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
from datetime import datetime
from pathlib import Path
from urllib.parse import quote_plus

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
        return set(json.loads(Path(path).read_text(encoding="utf-8")))
    except (FileNotFoundError, ValueError):
        return set()


def save_state(path, keys):
    Path(path).write_text(json.dumps(sorted(keys), ensure_ascii=False, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# Loop principal
# --------------------------------------------------------------------------

def check_once(cfg, dry_run=False):
    now = datetime.now().strftime("%d/%m %H:%M:%S")
    text = fetch_page_text(cfg["url"], cfg["selector"])
    # com seletor, cada linha já é um bloco completo (setor + preço)
    offers = extract_offers(text, cfg["keyword"], context_before=0 if cfg["selector"] else 2)

    if not offers:
        print(f"[{now}] Nenhum preço em R$ encontrado na página. "
              "Rode com --dry-run --dump para ver o texto capturado.")
        if cfg["dump"]:
            print(text[:5000])
        return

    prices = sorted({o["price"] for o in offers})
    print(f"[{now}] {len(offers)} preço(s) encontrados. Menor: {fmt_brl(prices[0])} | "
          f"todos: {', '.join(fmt_brl(p) for p in prices[:15])}")

    in_range = [o for o in offers if cfg["min"] <= o["price"] <= cfg["max"]]
    if dry_run:
        for o in offers:
            flag = "✅" if o in in_range else "  "
            print(f"  {flag} {fmt_brl(o['price']):>14}  {o['context']}")
        return

    current_keys = {f"{o['price']:.2f}|{o['context']}" for o in in_range}
    already_sent = load_state(cfg["state_file"])
    new = [o for o in in_range if f"{o['price']:.2f}|{o['context']}" not in already_sent]

    if new:
        new.sort(key=lambda o: o["price"])
        lines = [f"🎫 Ingresso na faixa de {fmt_brl(cfg['min'])} a {fmt_brl(cfg['max'])}!", ""]
        for o in new[:8]:
            lines.append(f"• {fmt_brl(o['price'])} — {o['context']}")
        if len(new) > 8:
            lines.append(f"... e mais {len(new) - 8} oferta(s)")
        lines += ["", f"Comprar: {cfg['url']}"]
        message = "\n".join(lines)
        send_whatsapp(message)
        print(f"[{now}] ✅ WhatsApp enviado com {len(new)} oferta(s) nova(s).")
    else:
        print(f"[{now}] Nada novo na faixa {fmt_brl(cfg['min'])}–{fmt_brl(cfg['max'])}.")

    # guarda só o que ainda está na faixa: se uma oferta sumir e voltar, avisa de novo
    save_state(cfg["state_file"], current_keys)


def main():
    parser = argparse.ArgumentParser(description="Alerta de preço de ingresso no WhatsApp")
    parser.add_argument("--once", action="store_true", help="verifica uma vez e sai")
    parser.add_argument("--dry-run", action="store_true", help="mostra preços sem enviar")
    parser.add_argument("--dump", action="store_true", help="imprime o texto capturado se não achar preços")
    parser.add_argument("--test-whatsapp", action="store_true", help="envia mensagem de teste")
    args = parser.parse_args()

    load_dotenv()

    if args.test_whatsapp:
        send_whatsapp("✅ Teste do monitor de ingressos: o WhatsApp está funcionando!")
        print("Mensagem de teste enviada.")
        return

    cfg = {
        "url": env("TICKET_URL", required=True),
        "min": float(env("MIN_PRICE", "0").replace(",", ".")),
        "max": float(env("MAX_PRICE", required=True).replace(",", ".")),
        "keyword": env("SECTOR_KEYWORD"),
        "selector": env("PRICE_SELECTOR"),
        "state_file": env("STATE_FILE", "state.json"),
        "dump": args.dump,
    }
    interval = int(env("INTERVAL_SECONDS", "120"))

    if args.once or args.dry_run:
        check_once(cfg, dry_run=args.dry_run)
        return

    print(f"Monitorando a cada ~{interval}s. Ctrl+C para parar.")
    while True:
        try:
            check_once(cfg)
        except Exception as e:  # rede instável, página fora do ar etc.: tenta de novo
            print(f"[{datetime.now():%d/%m %H:%M:%S}] Erro: {e}", file=sys.stderr)
        # um pouco de aleatoriedade para não bater sempre no mesmo segundo
        time.sleep(interval + random.randint(0, max(1, interval // 5)))


if __name__ == "__main__":
    main()
