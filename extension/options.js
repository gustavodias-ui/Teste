const FIELDS = {
  enabled: "checkbox", url: "text", min: "number", max: "number", day: "text", keyword: "text",
  intervalMin: "number", summaryHour: "number", selector: "text", renderWaitSec: "number",
  failAlertAfter: "number", phone: "text", apikey: "text",
};
const DEFAULTS = {
  enabled: false,
  url: "https://buyticketbrasil.com/event/bts-2026worldtourarirang/session/7dbb3a2b-985d-4bf2-9d36-df893169e098?returnTo=%2Fsearch",
  min: 0, max: "", day: "", keyword: "", intervalMin: 1, summaryHour: 10, selector: "",
  renderWaitSec: 6, failAlertAfter: 5, phone: "", apikey: "",
};
const $ = (id) => document.getElementById(id);

function say(text, kind) { const m = $("msg"); m.textContent = text; m.className = kind || ""; }

async function load() {
  const { config } = await chrome.storage.local.get("config");
  const cfg = { ...DEFAULTS, ...(config || {}) };
  for (const [k, type] of Object.entries(FIELDS)) {
    if (type === "checkbox") $(k).checked = !!cfg[k]; else $(k).value = cfg[k] ?? "";
  }
}

function read() {
  const cfg = {};
  for (const [k, type] of Object.entries(FIELDS)) {
    if (type === "checkbox") cfg[k] = $(k).checked;
    else if (type === "number") cfg[k] = $(k).value === "" ? DEFAULTS[k] : Number($(k).value);
    else cfg[k] = $(k).value.trim();
  }
  cfg.phone = cfg.phone.replace(/[\s()-]/g, "");
  return cfg;
}

async function save() {
  const cfg = read();
  if (!cfg.url) throw new Error("Informe o link da página do evento.");
  if (!(cfg.max > 0)) throw new Error("Informe o preço máximo.");
  if (cfg.min > cfg.max) throw new Error("O preço mínimo está maior que o máximo.");
  if (cfg.day && !/^\d{1,2}(\s*\/\s*\d{1,2})?$/.test(cfg.day)) throw new Error("Dia do show: use só o dia (31) ou dia/mês (31/10).");
  if (cfg.enabled && (!cfg.phone || !cfg.apikey)) throw new Error("Preencha seu número e a apikey do CallMeBot para ativar.");
  // outro site? pede permissão para ler aquela página (precisa ser no clique)
  const origin = new URL(cfg.url).origin + "/*";
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("Sem permissão para ler esse site, o monitor não funciona.");
  }
  const { config: old } = await chrome.storage.local.get("config");
  Object.assign(cfg, { ...(old || {}), ...cfg }); // mantém chaves internas que não estão no formulário
  const rangeChanged = old && (old.min !== cfg.min || old.max !== cfg.max || old.keyword !== cfg.keyword || old.url !== cfg.url || old.day !== cfg.day);
  await chrome.storage.local.set({ config: cfg });
  if (rangeChanged) {
    // filtro novo: zera os "já avisados" (para avisar de novo o que estiver na faixa) e o
    // histórico do gráfico (que era de outro filtro)
    const { state } = await chrome.storage.local.get("state");
    if (state) { state.alerted = []; state.history = []; await chrome.storage.local.set({ state }); }
  }
  await chrome.runtime.sendMessage({ type: "configChanged" });
  return cfg;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { const cfg = await save(); say(cfg.enabled ? "Salvo. Monitor ativo ✅" : "Salvo. O monitor está pausado.", "ok"); }
  catch (err) { say(err.message, "err"); }
});
$("test").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ config: { ...DEFAULTS, ...((await chrome.storage.local.get("config")).config || {}), phone: read().phone, apikey: read().apikey } });
    say("Enviando…");
    const r = await chrome.runtime.sendMessage({ type: "testWhatsapp" });
    if (r.ok) say("Mensagem de teste enviada. Confira seu WhatsApp.", "ok"); else say(r.error, "err");
  } catch (err) { say(err.message, "err"); }
});
$("check").addEventListener("click", async () => {
  try {
    await save();
    say("Abrindo a página e lendo os preços… (leva uns 10 s)");
    const r = await chrome.runtime.sendMessage({ type: "checkNow" });
    if (!r.ok) return say(r.error, "err");
    const { status } = await chrome.storage.local.get("status");
    if (!status.ok) return say("Não consegui ler: " + status.failure, "err");
    const n = status.offers.filter((o) => o.in_range).length;
    const dates = status.dates_seen.length ? ` Datas vistas na página: ${status.dates_seen.join(", ")}.` : "";
    say(`Li ${status.offers.length} preço(s)${status.day_filter ? ` do dia ${status.day_filter}` : ""}; ${n} na sua faixa.${dates}${status.note ? " ⚠️ " + status.note : ""}`, status.note ? "err" : "ok");
  } catch (err) { say(err.message, "err"); }
});
$("dash").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));

load();
