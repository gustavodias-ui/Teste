// Monitor de Ingressos: service worker da extensão.
//
// A cada intervalo, recarrega uma aba fixada com a página do evento, lê os
// preços em R$ direto do que o site mostra e:
//   - avisa no WhatsApp (CallMeBot) e no Chrome quando aparece oferta na faixa;
//   - avisa se não conseguir ler a página por várias tentativas seguidas;
//   - manda um resumo diário;
//   - grava tudo em chrome.storage para o painel (dashboard.html).

const DEFAULTS = {
  enabled: false,
  url: "https://buyticketbrasil.com/event/bts-2026worldtourarirang/session/7dbb3a2b-985d-4bf2-9d36-df893169e098?returnTo=%2Fsearch",
  min: 0,
  max: 0,
  keyword: "",
  selector: "",
  phone: "",
  apikey: "",
  intervalMin: 1,
  day: "", // dia do show, ex.: "31" ou "31/10"; vazio = qualquer data
  summaryHour: 10, // -1 desliga
  failAlertAfter: 5,
  renderWaitSec: 6,
  callmebotUrl: "https://api.callmebot.com/whatsapp.php",
};
const HISTORY_STEP_MS = 5 * 60e3;
const HISTORY_DAYS = 7;
const ALARM = "check";

// ---------------------------------------------------------------------------
// Config e estado
// ---------------------------------------------------------------------------

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return { ...DEFAULTS, ...(config || {}) };
}

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return {
    alerted: [], failures: 0, healthAlertSent: false, lastSummary: "",
    lastOffers: [], lastOffersAt: "", lastPageTitle: "", history: [],
    ...(state || {}),
  };
}

const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const offerKey = (o) => `${o.price.toFixed(2)}|${o.context}`;
const formatOffers = (offers, limit = 8) => {
  const lines = offers.slice(0, limit).map((o) => `• ${brl(o.price)} — ${o.context}`);
  if (offers.length > limit) lines.push(`... e mais ${offers.length - limit} oferta(s)`);
  return lines;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Agendamento
// ---------------------------------------------------------------------------

async function schedule() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM);
  if (cfg.enabled) {
    const period = Math.max(0.5, Number(cfg.intervalMin) || 1);
    chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: 0.05 });
  }
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await schedule();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) runCheck(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "configChanged") { await schedule(); reply({ ok: true }); }
      else if (msg.type === "checkNow") { await runCheck(true); reply({ ok: true }); }
      else if (msg.type === "testWhatsapp") {
        await sendWhatsapp(await getConfig(), "✅ Teste do monitor de ingressos: o WhatsApp está funcionando!");
        reply({ ok: true });
      } else reply({ ok: false, error: "mensagem desconhecida" });
    } catch (e) {
      reply({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // resposta assíncrona
});

chrome.notifications.onClicked.addListener(async (id) => {
  const cfg = await getConfig();
  chrome.tabs.create({ url: cfg.url, active: true });
  chrome.notifications.clear(id);
});

// ---------------------------------------------------------------------------
// Aba de monitoramento
// ---------------------------------------------------------------------------

function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch { return false; }
}

async function getMonitorTab(cfg) {
  const { monitorTabId } = await chrome.storage.local.get("monitorTabId");
  if (monitorTabId != null) {
    try {
      const tab = await chrome.tabs.get(monitorTabId);
      // se você usou essa aba para comprar (mudou de página), não mexemos nela
      if (tab && samePage(tab.url || tab.pendingUrl || "", cfg.url)) {
        await chrome.tabs.update(tab.id, { url: cfg.url, autoDiscardable: false });
        return tab.id;
      }
    } catch { /* aba fechada */ }
  }
  const tab = await chrome.tabs.create({ url: cfg.url, active: false, pinned: true });
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  await chrome.storage.local.set({ monitorTabId: tab.id });
  return tab.id;
}

// Abre/recarrega a aba e espera terminar de carregar. O "ouvinte" é ligado ANTES
// da navegação, senão uma página rápida (ou em cache) termina antes e o aviso se perde.
async function loadMonitorTab(cfg, timeoutMs = 45_000) {
  let targetId = null;
  let resolveLoaded;
  const loaded = new Promise((r) => { resolveLoaded = r; });
  const completed = new Set();
  const listener = (id, info) => {
    if (info.status !== "complete") return;
    completed.add(id);
    if (id === targetId) resolveLoaded();
  };
  chrome.tabs.onUpdated.addListener(listener);
  let timer;
  try {
    targetId = await getMonitorTab(cfg);
    if (completed.has(targetId)) resolveLoaded();
    await Promise.race([
      loaded,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("a página demorou demais para carregar")), timeoutMs); }),
    ]);
    return targetId;
  } finally {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

// Roda DENTRO da página do site: abre a lista "Selecione o tipo de ingresso"
// (os preços só aparecem com ela aberta). Devolve quantos cliques deu.
function openTicketList() {
  const countPrices = () => ((document.body && document.body.innerText) || "").split("R$").length - 1;
  const seen = new Set();
  const candidates = [];
  const add = (el) => { if (el && !seen.has(el)) { seen.add(el); candidates.push(el); } };
  document.querySelectorAll('input[placeholder*="ingresso" i], [role="combobox"], [aria-haspopup="listbox"]').forEach(add);
  for (const el of document.querySelectorAll("button, div, span, label, p")) {
    const t = (el.textContent || "").trim();
    if (t.length < 60 && /selecione o (tipo de )?ingresso/i.test(t) && el.querySelectorAll("*").length < 8) add(el);
  }
  const before = countPrices();
  let clicks = 0;
  for (const el of candidates.slice(0, 4)) {
    if (el.getAttribute("aria-expanded") === "true") return clicks; // já aberta
    el.scrollIntoView({ block: "center" });
    if (el.focus) el.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ev = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
    }
    clicks++;
    // abriu (apareceram preços novos ou uma lista de opções): para, senão o próximo clique fecha
    if (countPrices() > before || document.querySelector('[role="option"], [role="listbox"]')) break;
  }
  return clicks;
}

// Roda DENTRO da página do site: lê o texto visível, acha os preços em R$ e,
// para cada preço, a data do show escrita acima dele (ex.: "31/10", "31 de outubro").
function extractFromPage(keyword, selector) {
  const RE = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;
  const MONTHS = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  const findDate = (text) => {
    let m = text.match(/(?<![\d,.])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*\d{2,4})?(?![\d,.])/);
    // "1/2" (meia-entrada) não é data: exige pelo menos 3 dígitos (5/11, 31/10, 01/02)
    if (m && m[1].length + m[2].length >= 3 && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) return { day: +m[1], month: +m[2] };
    m = text.match(/(?<![\d,.])(\d{1,2})\s*(?:de\s+)?(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\.?(?![a-zà-ú])/i);
    if (m && +m[1] >= 1 && +m[1] <= 31) return { day: +m[1], month: MONTHS[m[2].slice(0, 3).toLowerCase().replace("ç", "c")] };
    return null;
  };
  // só linhas curtas contam como "data do show" (títulos); textos longos como
  // "três shows nos dias 28, 30 e 31 de outubro" não
  const headingDate = (line) => (line.length <= 60 ? findDate(line.replace(RE, "")) : null);
  const label = (d) => `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}`;
  const flat = (el) => (el.innerText || el.textContent || "").replace(/\s*\n\s*/g, " | ").trim();

  const bodyLines = ((document.body && document.body.innerText) || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const datesSeen = new Map();
  bodyLines.forEach((l) => { const d = headingDate(l); if (d) datesSeen.set(label(d), d); });

  // 1) itens de lista de opções (tipo de ingresso + preço no mesmo item)
  // 2) seletor CSS configurado
  // 3) texto da página inteira, linha a linha
  let blocks = null;
  if (selector) {
    blocks = [...document.querySelectorAll(selector)].map((e) => flat(e.parentElement || e));
  } else {
    const opts = [...document.querySelectorAll('[role="option"], select option')].filter((e) => /R\$/.test(e.textContent || ""));
    if (opts.length) blocks = opts.map(flat);
  }

  const offers = [];
  const push = (price, context, date) => {
    if (!(price > 0)) return; // "R$ 0" = indisponível/esgotado
    if (keyword && !context.toLowerCase().includes(keyword.toLowerCase())) return;
    offers.push({ price, context: context.slice(0, 200), date });
  };
  const parse = (m) => parseFloat(m[1].replace(/\./g, "").replace(",", "."));

  if (blocks) {
    // lista de opções: a data é a da sessão, se a página mostrar uma única data em título
    const only = datesSeen.size === 1 ? [...datesSeen.values()][0] : null;
    for (const b of blocks) for (const m of b.matchAll(RE)) push(parse(m), b, findDate(b.replace(RE, "")) || only);
  } else {
    let current = null; // última data vista acima (títulos de seção vêm antes dos preços)
    let lastPriceLine = -1;
    bodyLines.forEach((line, i) => {
      const d = headingDate(line);
      if (d) current = d;
      const matches = [...line.matchAll(RE)];
      if (!matches.length) return;
      // contexto: até 2 linhas acima, sem invadir a oferta anterior e sem textos longos (descrições)
      const context = bodyLines.slice(Math.max(0, i - 2, lastPriceLine + 1), i + 1)
        .filter((l, k, arr) => k === arr.length - 1 || l.length <= 80).join(" | ");
      for (const m of matches) push(parse(m), context, current);
      lastPriceLine = i;
    });
  }

  for (const o of offers) {
    o.dateLabel = o.date ? label(o.date) : null;
    // mostra a data junto do setor, se ela ainda não estiver no texto da oferta
    if (o.date && !findDate(o.context.replace(RE, ""))) o.context = `📅 ${o.dateLabel} | ${o.context}`;
  }
  return { offers, title: document.title, datesSeen: [...datesSeen.keys()], usedOptions: !!blocks && !selector };
}

// "31" ou "31/10" -> { day, month }
function parseDayFilter(text) {
  const m = String(text || "").trim().match(/^(\d{1,2})(?:\s*\/\s*(\d{1,2}))?$/);
  return m ? { day: +m[1], month: m[2] ? +m[2] : null } : null;
}

async function readOffers(cfg) {
  try {
    const tabId = await loadMonitorTab(cfg);
    // dá tempo para o site montar a lista (páginas em JavaScript) e rola para carregar o resto
    await sleep(cfg.renderWaitSec * 1000);
    await chrome.scripting.executeScript({ target: { tabId }, func: () => window.scrollTo(0, document.body.scrollHeight) });
    await sleep(1000);
    // os preços ficam dentro da lista "Selecione o tipo de ingresso": abre antes de ler
    await chrome.scripting.executeScript({ target: { tabId }, func: openTicketList });
    await sleep(1500);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId }, func: extractFromPage, args: [cfg.keyword || "", cfg.selector || ""],
    });
    const base = { title: result.title, datesSeen: result.datesSeen, note: null, dateUnknown: false };
    if (!result.offers.length) {
      return { ...base, offers: [],
               failure: `nenhum preço em R$ encontrado na página "${result.title}" (captcha, login, ingressos esgotados ou mudança no site?)` };
    }
    let offers = result.offers;
    const want = parseDayFilter(cfg.day);
    if (want) {
      const dayTxt = cfg.day.trim();
      if (!result.datesSeen.length) {
        base.dateUnknown = true;
        base.note = `A página não mostra nenhuma data, então não dá para separar o dia ${dayTxt}: estou considerando todos os preços. Confira se o link é da sessão do dia ${dayTxt}.`;
      } else {
        // preço com data diferente sai; preço sem data identificada fica, marcado como "confira"
        offers = offers.filter((o) => !o.date || (o.date.day === want.day && (!want.month || o.date.month === want.month)));
        if (!offers.length) {
          base.note = `Nenhum preço do dia ${dayTxt} na página agora. Datas encontradas: ${result.datesSeen.join(", ")}.`;
        } else if (offers.some((o) => !o.date)) {
          base.dateUnknown = true;
          base.note = `Não achei a data do show perto de alguns preços. Confira se o link é da sessão do dia ${dayTxt}. Datas na página: ${result.datesSeen.join(", ")}.`;
        }
      }
    }
    offers = offers.map((o) => ({ price: o.price, context: o.context, date: o.dateLabel }));
    offers.sort((a, b) => a.price - b.price);
    return { ...base, offers, failure: null };
  } catch (e) {
    return { offers: [], title: "", datesSeen: [], note: null, failure: `erro ao abrir a página: ${String(e.message || e).slice(0, 150)}` };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp / notificações / badge
// ---------------------------------------------------------------------------

async function sendWhatsapp(cfg, text) {
  if (!cfg.phone || !cfg.apikey) throw new Error("preencha seu número e a apikey do CallMeBot nas configurações");
  const url = `${cfg.callmebotUrl}?phone=${encodeURIComponent(cfg.phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(cfg.apikey)}`;
  const r = await fetch(url);
  const body = await r.text();
  if (!r.ok || /error/i.test(body)) throw new Error(`CallMeBot respondeu ${r.status}: ${body.replace(/<[^>]+>/g, " ").trim().slice(0, 200)}`);
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/128.png", title, message, priority: 2 });
}

async function updateBadge() {
  const cfg = await getConfig();
  const { status } = await chrome.storage.local.get("status");
  if (!cfg.enabled) {
    chrome.action.setBadgeText({ text: "II" });
    chrome.action.setBadgeBackgroundColor({ color: "#77766f" });
  } else if (status && !status.ok) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d03b3b" });
  } else {
    const n = status ? status.offers.filter((o) => o.in_range).length : 0;
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#0ca30c" });
  }
}

// ---------------------------------------------------------------------------
// Verificação
// ---------------------------------------------------------------------------

let running = false;

async function runCheck(manual = false) {
  if (running) return;
  const cfg = await getConfig();
  if (!cfg.enabled && !manual) return;
  running = true;
  try {
    await doCheck(cfg);
  } finally {
    running = false;
    await updateBadge();
  }
}

async function doCheck(cfg) {
  const { offers, title, failure, note, datesSeen, dateUnknown } = await readOffers(cfg);
  const state = await getState();
  const now = new Date();
  const inRange = offers.filter((o) => o.price >= cfg.min && o.price <= cfg.max);
  const inRangeKeys = new Set(inRange.map(offerKey));

  // 0) atualiza o painel antes de mandar mensagens (se o WhatsApp falhar, o painel segue certo)
  if (failure) {
    state.failures += 1;
  } else {
    state.lastOffers = offers.map((o) => ({ ...o, in_range: inRangeKeys.has(offerKey(o)) }));
    state.lastOffersAt = now.toISOString();
    state.lastPageTitle = title;
    const point = [now.toISOString(), offers.length ? offers[0].price : null, inRange.length];
    const last = state.history[state.history.length - 1];
    if (!last || now - new Date(last[0]) >= HISTORY_STEP_MS || last[1] !== point[1] || last[2] !== point[2]) {
      state.history.push(point);
    }
    const cutoff = now.getTime() - HISTORY_DAYS * 86400e3;
    state.history = state.history.filter((p) => new Date(p[0]).getTime() >= cutoff);
  }
  const status = {
    source: "extension",
    updated_at: now.toISOString(),
    interval_seconds: Math.round((Number(cfg.intervalMin) || 1) * 60),
    ok: !failure,
    failure,
    consecutive_failures: state.failures,
    url: cfg.url,
    page_title: state.lastPageTitle,
    min_price: cfg.min,
    max_price: cfg.max,
    keyword: cfg.keyword || null,
    day_filter: cfg.day || null,
    note: failure ? null : note,
    dates_seen: datesSeen || [],
    offers_at: state.lastOffersAt,
    offers: state.lastOffers,
    history: state.history,
    whatsapp_error: null,
  };
  await chrome.storage.local.set({ state, status });

  try {
    // 1) saúde: avisa uma vez quando para de conseguir ler a página, e quando volta
    if (failure) {
      if (state.failures >= cfg.failAlertAfter && !state.healthAlertSent) {
        await sendWhatsapp(cfg, `⚠️ Monitor de ingressos: não estou conseguindo ler a página há ${state.failures} tentativas seguidas (${failure}). Continuo tentando e aviso quando voltar.\n\nConfira: ${cfg.url}`);
        notify("Monitor de ingressos: falha ao ler a página", failure);
        state.healthAlertSent = true;
      }
      return;
    }
    if (state.healthAlertSent) {
      await sendWhatsapp(cfg, "✅ Monitor de ingressos: voltei a ler a página normalmente.");
    }
    state.failures = 0;
    state.healthAlertSent = false;

    // 2) ofertas novas na faixa
    const already = new Set(state.alerted);
    const fresh = inRange.filter((o) => !already.has(offerKey(o)));
    if (fresh.length) {
      const dayTxt = cfg.day && !dateUnknown ? ` para o dia ${cfg.day}` : "";
      const msg = [`🎫 Ingresso${dayTxt} na faixa de ${brl(cfg.min)} a ${brl(cfg.max)}!`,
        ...(cfg.day && dateUnknown ? [`⚠️ A página não mostra a data: confira se é do dia ${cfg.day}.`] : []), "", ...formatOffers(fresh), "", `👉 Comprar agora: ${cfg.url}`].join("\n");
      notify(`🎫 ${fresh.length} oferta(s) na sua faixa! A partir de ${brl(fresh[0].price)}`, "Clique para abrir a página e comprar.");
      await sendWhatsapp(cfg, msg);
    }
    // guarda só o que ainda está na faixa: se sumir e voltar, avisa de novo
    state.alerted = [...inRangeKeys];

    // 3) resumo diário
    const today = now.toLocaleDateString("pt-BR");
    if (cfg.summaryHour >= 0 && now.getHours() >= cfg.summaryHour && state.lastSummary !== today) {
      const msg = [
        `📊 Resumo diário (${today}): monitor ativo.`,
        `Sua faixa: ${brl(cfg.min)} a ${brl(cfg.max)}${cfg.day ? ` | dia ${cfg.day}` : ""}${cfg.keyword ? ` | setor: ${cfg.keyword}` : ""}`,
        `Na faixa agora: ${inRange.length} oferta(s).`,
        "", ...(offers.length ? ["Menores preços no momento:", ...formatOffers(offers, 5)] : [note || "Nenhum preço no momento."]),
        "", `Link: ${cfg.url}`,
      ].join("\n");
      await sendWhatsapp(cfg, msg);
      state.lastSummary = today;
    }
  } catch (e) {
    // falha ao enviar: não marca como avisado, tenta de novo na próxima verificação
    status.whatsapp_error = String(e.message || e);
    console.warn("WhatsApp:", e);
  } finally {
    await chrome.storage.local.set({ state, status });
  }
}
