#!/usr/bin/env python3
"""Monitora o preço de ingressos numa página e avisa no WhatsApp quando
algum preço entra na faixa desejada.

Uso:
    python monitor.py               # roda em loop (a cada INTERVAL_SECONDS)
    python monitor.py --once        # verifica uma vez e sai (GitHub Actions / cron)
    python monitor.py --dry-run     # só mostra os preços encontrados, não envia nada
    python monitor.py --test-whatsapp   # envia uma mensagem de teste

Configuração por variáveis de ambiente (ou arquivo .env) — veja .env.example.
"""

import argparse
import json
import os
import random
import re
import sys
import time
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

import requests
from playwright.sync_api import sync_playwright

PRICE_RE = re.compile(r"R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)


def load_dotenv(path=".env"):
    """Carrega um .env simples (CHAVE=valor) sem dependências extras."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env(name, default=None, required=False):
    value = os.environ.get(name, "").strip()
    if not value:
        if required:
            sys.exit(f"Erro: defina a variável {name} (veja .env.example)")
        return default
    return value


def parse_brl(text):
    """'1.234,56' -> 1234.56"""
    return float(text.replace(".", "").replace(",", "."))


def fmt_brl(value):
    s = f"{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


# --------------------------------------------------------------------------
# Coleta de preços
# --------------------------------------------------------------------------

def fetch_page_text(url, price_selector=None, wait_ms=4000):
    """Abre a página num Chromium headless e devolve o texto visível.

    Se PRICE_SELECTOR estiver definido, devolve apenas o texto dos elementos
    que casam com o seletor (um por linha), junto com o texto do elemento pai
    para dar contexto (nome do setor etc.).
    """
    launch_args = {"headless": True}
    if env("CHROMIUM_PATH"):
        launch_args["executable_path"] = env("CHROMIUM_PATH")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(**launch_args)
        context = browser.new_context(
            user_agent=USER_AGENT,
            locale="pt-BR",
            timezone_id="America/Sao_Paulo",
            viewport={"width": 1366, "height": 900},
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        try:
            page.wait_for_load_state("networkidle", timeout=20_000)
        except Exception:
            pass  # páginas com polling nunca ficam "idle"; seguimos assim mesmo
        page.wait_for_timeout(wait_ms)

        # Rola a página para carregar listas "lazy"
        for _ in range(5):
            page.mouse.wheel(0, 2000)
            page.wait_for_timeout(500)

        if price_selector:
            blocks = page.eval_on_selector_all(
                price_selector,
                """els => els.map(e => {
                    const ctx = (e.parentElement || e).innerText || '';
                    return ctx.replace(/\\s*\\n\\s*/g, ' | ');
                })""",
            )
            text = "\n".join(blocks)
        else:
            text = page.inner_text("body")

        browser.close()
        return text


def extract_offers(text, keyword=None, context_before=2):
    """Encontra todos os preços em R$ no texto, com um pouco de contexto."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    offers = []
    for i, line in enumerate(lines):
        for match in PRICE_RE.finditer(line):
            try:
                price = parse_brl(match.group(1))
            except ValueError:
                continue
            # contexto = linhas anteriores + a linha do preço (setor costuma vir antes)
            context = " | ".join(lines[max(0, i - context_before): i + 1])
            if keyword and keyword.lower() not in context.lower():
                continue
            offers.append({"price": price, "context": context[:200]})
    return offers


# --------------------------------------------------------------------------
# Envio para o WhatsApp
# --------------------------------------------------------------------------

def send_whatsapp(message):
    provider = env("WHATSAPP_PROVIDER", "callmebot").lower()

    if provider == "callmebot":
        phone = env("WHATSAPP_PHONE", required=True)
        apikey = env("CALLMEBOT_APIKEY", required=True)
        url = (
            "https://api.callmebot.com/whatsapp.php"
            f"?phone={quote_plus(phone)}&text={quote_plus(message)}&apikey={quote_plus(apikey)}"
        )
        r = requests.get(url, timeout=30)
        if r.status_code != 200 or "error" in r.text.lower():
            raise RuntimeError(f"CallMeBot respondeu {r.status_code}: {r.text[:300]}")

    elif provider == "twilio":
        sid = env("TWILIO_ACCOUNT_SID", required=True)
        token = env("TWILIO_AUTH_TOKEN", required=True)
        from_ = env("TWILIO_WHATSAPP_FROM", "+14155238886")  # número do sandbox
        to = env("WHATSAPP_PHONE", required=True)
        r = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            auth=(sid, token),
            data={"From": f"whatsapp:{from_}", "To": f"whatsapp:{to}", "Body": message},
            timeout=30,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Twilio respondeu {r.status_code}: {r.text[:300]}")

    else:
        sys.exit(f"WHATSAPP_PROVIDER inválido: {provider} (use 'callmebot' ou 'twilio')")


# --------------------------------------------------------------------------
# Estado (para não mandar a mesma oferta repetidamente)
# --------------------------------------------------------------------------

def load_state(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        data = {}
    if isinstance(data, list):  # formato antigo: só a lista de ofertas avisadas
        data = {"alerted": data}
    data.setdefault("alerted", [])
    data.setdefault("failures", 0)
    data.setdefault("health_alert_sent", False)
    data.setdefault("last_summary", "")
    data.setdefault("last_offers", [])
    data.setdefault("last_offers_at", "")
    data.setdefault("history", [])
    return data


def save_state(path, state):
    Path(path).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def now_br():
    return datetime.now(ZoneInfo("America/Sao_Paulo"))


def offer_key(o):
    return f"{o['price']:.2f}|{o['context']}"


def format_offers(offers, limit=8):
    lines = [f"• {fmt_brl(o['price'])} — {o['context']}" for o in offers[:limit]]
    if len(offers) > limit:
        lines.append(f"... e mais {len(offers) - limit} oferta(s)")
    return lines


# --------------------------------------------------------------------------
# Painel ao vivo: status.json publicado a cada verificação
# --------------------------------------------------------------------------

HISTORY_STEP_SECONDS = 300   # um ponto no gráfico a cada 5 min (ou quando o preço muda)
HISTORY_DAYS = 7


def record_reading(state, offers, in_range, now):
    state["last_offers"] = [
        {"price": o["price"], "context": o["context"], "in_range": o in in_range} for o in offers
    ]
    state["last_offers_at"] = now.isoformat(timespec="seconds")

    point = [now.isoformat(timespec="seconds"), offers[0]["price"], len(in_range)]
    history = state["history"]
    if history:
        elapsed = (now - datetime.fromisoformat(history[-1][0])).total_seconds()
        if elapsed < HISTORY_STEP_SECONDS and history[-1][1:] == point[1:]:
            return
    history.append(point)
    cutoff = now - timedelta(days=HISTORY_DAYS)
    state["history"] = [p for p in history if datetime.fromisoformat(p[0]) >= cutoff]


def publish_status(cfg, state, failure, now):
    """Grava status.json e, se PUBLISH_BRANCH estiver definido, envia para essa
    branch do GitHub (é de lá que o painel lê). Nunca interrompe o monitor."""
    status = {
        "updated_at": now.isoformat(timespec="seconds"),
        "interval_seconds": cfg["interval"],
        "ok": failure is None,
        "failure": failure,
        "consecutive_failures": state["failures"],
        "url": cfg["url"],
        "min_price": cfg["min"],
        "max_price": cfg["max"],
        "keyword": cfg["keyword"],
        "offers_at": state["last_offers_at"],
        "offers": state["last_offers"],
        "history": state["history"],
    }
    path = Path(cfg["status_file"])
    path.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")

    branch = cfg["publish_branch"]
    if not branch:
        return
    # commit "solto" (sem histórico) só com o status.json, sobrescrevendo a branch:
    # não mexe nos arquivos do repositório e não acumula milhares de commits
    git_env = {**os.environ,
               "GIT_AUTHOR_NAME": "ticket-monitor", "GIT_AUTHOR_EMAIL": "ticket-monitor@users.noreply.github.com",
               "GIT_COMMITTER_NAME": "ticket-monitor", "GIT_COMMITTER_EMAIL": "ticket-monitor@users.noreply.github.com"}

    def git(*args, stdin=None):
        return subprocess.run(["git", *args], input=stdin, env=git_env, capture_output=True,
                              text=True, check=True, timeout=60).stdout.strip()

    try:
        blob = git("hash-object", "-w", str(path))
        tree = git("mktree", stdin=f"100644 blob {blob}\tstatus.json\n")
        commit = git("commit-tree", tree, "-m", f"status {status['updated_at']}")
        git("push", "--force", "--quiet", "origin", f"{commit}:refs/heads/{branch}")
    except (subprocess.SubprocessError, OSError) as e:
        detail = getattr(e, "stderr", "") or str(e)
        print(f"Aviso: não consegui publicar o status para o painel: {detail.strip()[:200]}",
              file=sys.stderr)


# --------------------------------------------------------------------------
# Verificação
# --------------------------------------------------------------------------

def read_offers(cfg):
    """Devolve (ofertas, motivo_da_falha). Falha = erro ou nenhum preço achado."""
    try:
        text = fetch_page_text(cfg["url"], cfg["selector"])
    except Exception as e:  # rede instável, página fora do ar, timeout...
        return [], f"erro ao abrir a página: {str(e).splitlines()[0][:150]}"
    # com seletor, cada linha já é um bloco completo (setor + preço)
    offers = extract_offers(text, cfg["keyword"], context_before=0 if cfg["selector"] else 2)
    if not offers:
        if cfg["dump"]:
            print(text[:5000])
        return [], "nenhum preço em R$ encontrado (bloqueio, captcha ou mudança no site?)"
    offers.sort(key=lambda o: o["price"])
    return offers, None


def check_once(cfg, dry_run=False):
    ts = now_br().strftime("%d/%m %H:%M:%S")
    offers, failure = read_offers(cfg)
    in_range = [o for o in offers if cfg["min"] <= o["price"] <= cfg["max"]]

    if offers:
        print(f"[{ts}] {len(offers)} preço(s). Menor: {fmt_brl(offers[0]['price'])} | "
              f"{len(in_range)} na faixa {fmt_brl(cfg['min'])}–{fmt_brl(cfg['max'])}")
    else:
        print(f"[{ts}] Falha: {failure}")

    if dry_run:
        for o in offers:
            flag = "✅" if o in in_range else "  "
            print(f"  {flag} {fmt_brl(o['price']):>14}  {o['context']}")
        return

    state = load_state(cfg["state_file"])
    now = now_br()

    # 0) Atualiza o painel antes de mandar mensagens (se o WhatsApp falhar, o painel segue vivo)
    if failure:
        state["failures"] += 1
    else:
        record_reading(state, offers, in_range, now)
    publish_status(cfg, state, failure, now)
    save_state(cfg["state_file"], state)

    # 1) Saúde do monitor: avisa uma vez se parar de conseguir ler a página
    if failure:
        if state["failures"] >= cfg["fail_alert_after"] and not state["health_alert_sent"]:
            send_whatsapp(
                "⚠️ Monitor de ingressos: não estou conseguindo ler a página há "
                f"{state['failures']} tentativas seguidas ({failure}). Continuo tentando "
                f"e aviso quando voltar.\n\nConfira manualmente: {cfg['url']}"
            )
            state["health_alert_sent"] = True
        save_state(cfg["state_file"], state)
        return

    if state["health_alert_sent"]:
        send_whatsapp("✅ Monitor de ingressos: voltei a ler a página normalmente.")
    state["failures"] = 0
    state["health_alert_sent"] = False

    # 2) Ofertas novas dentro da faixa
    already_sent = set(state["alerted"])
    new = [o for o in in_range if offer_key(o) not in already_sent]
    if new:
        lines = [f"🎫 Ingresso na faixa de {fmt_brl(cfg['min'])} a {fmt_brl(cfg['max'])}!", ""]
        lines += format_offers(new)
        lines += ["", f"👉 Comprar agora: {cfg['url']}"]
        if cfg["dashboard_url"]:
            lines.append(f"📈 Painel ao vivo: {cfg['dashboard_url']}")
        send_whatsapp("\n".join(lines))
        print(f"[{ts}] ✅ WhatsApp enviado com {len(new)} oferta(s) nova(s).")
    # guarda só o que ainda está na faixa: se uma oferta sumir e voltar, avisa de novo
    state["alerted"] = sorted({offer_key(o) for o in in_range})

    # 3) Resumo diário (confirma que o monitor está vivo e mostra os menores preços)
    today = now.strftime("%Y-%m-%d")
    if cfg["summary_hour"] is not None and now.hour >= cfg["summary_hour"] \
            and state["last_summary"] != today:
        lines = [
            f"📊 Resumo diário ({now:%d/%m}) — monitor ativo 24h.",
            f"Sua faixa: {fmt_brl(cfg['min'])} a {fmt_brl(cfg['max'])}"
            + (f" | setor: {cfg['keyword']}" if cfg["keyword"] else ""),
            f"Na faixa agora: {len(in_range)} oferta(s).",
            "",
            "Menores preços no momento:",
        ]
        lines += format_offers(offers, limit=5)
        lines += ["", f"Link: {cfg['url']}"]
        if cfg["dashboard_url"]:
            lines.append(f"📈 Painel ao vivo: {cfg['dashboard_url']}")
        send_whatsapp("\n".join(lines))
        state["last_summary"] = today
        print(f"[{ts}] 📊 Resumo diário enviado.")

    save_state(cfg["state_file"], state)


def main():
    parser = argparse.ArgumentParser(description="Alerta de preço de ingresso no WhatsApp")
    parser.add_argument("--once", action="store_true", help="verifica uma vez e sai")
    parser.add_argument("--dry-run", action="store_true", help="mostra preços sem enviar")
    parser.add_argument("--dump", action="store_true", help="imprime o texto capturado se não achar preços")
    parser.add_argument("--test-whatsapp", action="store_true", help="envia mensagem de teste")
    parser.add_argument("--max-minutes", type=float, default=0,
                        help="no modo loop, para depois de N minutos (usado no GitHub Actions)")
    args = parser.parse_args()

    load_dotenv()

    if args.test_whatsapp:
        send_whatsapp("✅ Teste do monitor de ingressos: o WhatsApp está funcionando!")
        print("Mensagem de teste enviada.")
        return

    summary_hour = env("SUMMARY_HOUR", "10")
    cfg = {
        "url": env("TICKET_URL", required=True),
        "min": float(env("MIN_PRICE", "0").replace(",", ".")),
        "max": float(env("MAX_PRICE", required=True).replace(",", ".")),
        "keyword": env("SECTOR_KEYWORD"),
        "selector": env("PRICE_SELECTOR"),
        "state_file": env("STATE_FILE", "state.json"),
        "fail_alert_after": int(env("FAIL_ALERT_AFTER", "5")),
        "status_file": env("STATUS_FILE", "status.json"),
        "publish_branch": env("PUBLISH_BRANCH"),
        "dashboard_url": env("DASHBOARD_URL"),
        "interval": int(env("INTERVAL_SECONDS", "120")),
        "summary_hour": None if summary_hour.lower() in ("off", "-1", "nao", "não") else int(summary_hour),
        "dump": args.dump,
    }
    interval = cfg["interval"]

    if args.once or args.dry_run:
        check_once(cfg, dry_run=args.dry_run)
        return

    # falha logo na partida se faltar configuração do WhatsApp (e não no meio do loop)
    if env("WHATSAPP_PROVIDER", "callmebot").lower() == "twilio":
        required = ("WHATSAPP_PHONE", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN")
    else:
        required = ("WHATSAPP_PHONE", "CALLMEBOT_APIKEY")
    for name in required:
        env(name, required=True)

    deadline = time.monotonic() + args.max_minutes * 60 if args.max_minutes else None
    print(f"Monitorando a cada ~{interval}s. Ctrl+C para parar.", flush=True)
    while deadline is None or time.monotonic() < deadline:
        try:
            check_once(cfg)
        except Exception as e:  # ex.: falha ao enviar o WhatsApp: tenta de novo na próxima
            print(f"[{now_br():%d/%m %H:%M:%S}] Erro: {e}", file=sys.stderr)
        sys.stdout.flush()
        # um pouco de aleatoriedade para não bater sempre no mesmo segundo
        time.sleep(interval + random.randint(0, max(1, interval // 5)))


if __name__ == "__main__":
    main()
