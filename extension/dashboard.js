(() => {
  // ---- de onde vêm os dados: o que a extensão gravou neste navegador -------
  let config = null;
  const $ = (id) => document.getElementById(id);
  const brl = (v) => v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const brlShort = (v) => "R$ " + Math.round(v).toLocaleString("pt-BR");

  let status = null;
  let rangeHours = 24;
  try { const h = localStorage.getItem("rangeHours"); if (h) rangeHours = +h; } catch (e) {}
  try { $("only-hit").checked = localStorage.getItem("onlyHit") === "1"; } catch (e) {}

  async function fetchStatus() {
    const data = await chrome.storage.local.get(["status", "config"]);
    config = data.config || null;
    if (!data.status) throw Object.assign(new Error("sem dados"), { notFound: true });
    return data.status;
  }

  function ago(iso) {
    if (!iso) return "—";
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `há ${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return `há ${h} h ${m % 60} min`;
    return `há ${Math.floor(h / 24)} dias`;
  }
  // tira os pedaços do contexto que são só o preço ("R$ 645,50"), que já aparece na coluna Preço
  const cleanContext = (ctx) => ctx.split(" | ").filter((p) => !/^R\$\s*[\d.,]+$/.test(p.trim())).join(" · ");
  const fmtTime = (d) => d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  // ---- cabeçalho / status ----------------------------------------------------
  function renderHeader() {
    const pill = $("pill"), banner = $("banner");
    pill.className = "pill";
    banner.className = "banner";
    if (!status) return;
    const ageS = (Date.now() - new Date(status.updated_at).getTime()) / 1000;
    const wa = $("wa-banner");
    wa.className = "banner warn" + (status.whatsapp_error ? " show" : "");
    wa.textContent = status.whatsapp_error ? `O envio para o WhatsApp falhou: ${status.whatsapp_error}` : "";
    const nb = $("note-banner");
    nb.className = "banner warn" + (status.note ? " show" : "");
    nb.textContent = status.note || "";
    $("source").textContent = status.offers_at
      ? `Preços lidos direto da página do site (aba fixada no seu Chrome) ${ago(status.offers_at)}${status.page_title ? ` · “${status.page_title}”` : ""}`
      : "";
    if (config && !config.enabled) {
      pill.classList.add("stale");
      $("pill-text").textContent = "Pausado";
      banner.classList.add("show", "warn");
      banner.textContent = "O monitor está pausado. Ative em ⚙ Configurações.";
      $("sub").textContent = `Última verificação ${ago(status.updated_at)}`;
      return;
    }
    const staleAfter = Math.max(360, (status.interval_seconds || 120) * 3);
    $("sub").textContent = `Última verificação ${ago(status.updated_at)} · ${fmtTime(new Date(status.updated_at))}`;
    if (ageS > staleAfter) {
      pill.classList.add("stale");
      $("pill-text").textContent = "Parado";
      banner.classList.add("show", "warn");
      banner.textContent = `A última verificação foi ${ago(status.updated_at)}. O Chrome precisa ficar aberto e o computador sem hibernar.`;
    } else if (!status.ok) {
      pill.classList.add("fail");
      $("pill-text").textContent = "Falha ao ler";
      banner.classList.add("show");
      banner.textContent = `Não consegui ler a página do evento (${status.consecutive_failures}× seguidas): ${status.failure || "erro desconhecido"}. Os preços abaixo são da última leitura boa, ${ago(status.offers_at)}.`;
    } else {
      pill.classList.add("live");
      $("pill-text").textContent = "Ao vivo";
    }
  }

  // ---- números + botão -------------------------------------------------------
  function renderTiles() {
    const offers = status.offers || [];
    const hits = offers.filter((o) => o.in_range);
    const min = offers.length ? Math.min(...offers.map((o) => o.price)) : null;
    const minOffer = offers.find((o) => o.price === min);
    $("v-min").textContent = brl(min);
    $("n-min").textContent = minOffer ? cleanContext(minOffer.context) : "";
    $("v-hit").textContent = String(hits.length);
    $("n-hit").textContent = hits.length ? `a partir de ${brl(Math.min(...hits.map((o) => o.price)))}` : "nenhuma ainda";
    $("tile-hit").classList.toggle("hit", hits.length > 0);
    $("v-range").textContent = `${brlShort(status.min_price)} – ${brlShort(status.max_price)}`;
    $("n-range").textContent = [status.day_filter ? `dia ${status.day_filter}` : "qualquer data",
                                status.keyword ? `setor: ${status.keyword}` : "todos os setores"].join(" · ");

    const cta = $("cta");
    cta.href = status.url;
    cta.classList.toggle("hot", hits.length > 0);
    cta.textContent = hits.length ? `Comprar agora: ${hits.length} oferta(s) na faixa ↗` : "Abrir página do evento ↗";

    document.title = hits.length ? `(${hits.length}) ${brl(Math.min(...hits.map((o) => o.price)))} · Monitor` : "Monitor de ingressos";
  }

  // ---- tabela ----------------------------------------------------------------
  function renderOffers() {
    const tbody = $("offers");
    tbody.replaceChildren();
    const onlyHit = $("only-hit").checked;
    const all = (status.offers || []).slice().sort((a, b) => a.price - b.price);
    const list = onlyHit ? all.filter((o) => o.in_range) : all;
    $("offers-title").textContent = `Ofertas na página (${all.length})`;
    if (!list.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 2; td.className = "ctx";
      td.textContent = onlyHit ? "Nenhuma oferta na sua faixa no momento." : "Nenhum preço lido ainda.";
      tr.append(td); tbody.append(tr);
      return;
    }
    for (const o of list) {
      const tr = document.createElement("tr");
      if (o.in_range) tr.className = "in";
      const p = document.createElement("td"); p.className = "price"; p.textContent = brl(o.price);
      if (o.in_range) { const s = document.createElement("div"); s.innerHTML = '<span class="badge">✓ Na faixa</span>'; p.append(s); }
      const c = document.createElement("td"); c.className = "ctx"; c.textContent = cleanContext(o.context) || o.context; // texto vem do site: textContent
      tr.append(p, c); tbody.append(tr);
    }
  }

  // ---- gráfico (linha em degraus: o preço vale até a próxima leitura) --------
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.append(n);
    return n;
  };
  let chartGeom = null;

  function renderChart() {
    const svg = $("chart");
    svg.replaceChildren();
    $("tip").style.display = "none";
    const W = svg.clientWidth || 600, H = svg.clientHeight || 240;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const now = Date.now();
    const t0 = now - rangeHours * 3600e3;
    const all = (status.history || []).map(([t, p, n]) => ({ t: new Date(t).getTime(), p, n }));
    // inclui o último ponto anterior à janela, para a linha começar na borda
    const firstIn = all.findIndex((d) => d.t >= t0);
    const pts = firstIn === -1 ? all.slice(-1) : all.slice(Math.max(0, firstIn - 1));
    if (!pts.length) {
      const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle" }, svg);
      t.textContent = "Ainda sem histórico. Ele aparece depois das primeiras verificações.";
      chartGeom = null;
      return;
    }
    const lastT = new Date(status.offers_at || status.updated_at).getTime();
    const m = { l: 56, r: 12, t: 12, b: 26 };
    const xMin = Math.max(t0, Math.min(pts[0].t, now)), xMax = now;
    const prices = pts.map((d) => d.p).filter((p) => p != null);
    let yLo = Math.min(...prices, status.min_price), yHi = Math.max(...prices, status.max_price);
    const pad = (yHi - yLo) * 0.08 || yHi * 0.1 || 10;
    yLo = Math.max(0, yLo - pad); yHi += pad;
    const x = (t) => m.l + ((Math.max(t, xMin) - xMin) / (xMax - xMin || 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - yLo) / (yHi - yLo)) * (H - m.t - m.b);

    // grade e eixo Y (recessivos)
    const ticks = niceTicks(yLo, yHi, 4);
    for (const v of ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }, svg);
      const t = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg);
      t.textContent = brlShort(v);
    }
    // eixo X: marcas em horas "redondas" (no fuso de quem está vendo)
    const maxTicks = W < 420 ? 4 : 7;
    const HOUR = 3600e3;
    const step = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48].map((h) => h * HOUR).find((st) => (xMax - xMin) / st <= maxTicks) || 48 * HOUR;
    const start = new Date(xMin);
    if (step >= 24 * HOUR) start.setHours(0, 0, 0, 0); else start.setMinutes(0, 0, 0);
    const walk = Math.min(step, HOUR); // anda de hora em hora e só marca as horas múltiplas do passo
    for (let tv = start.getTime(); tv <= xMax; tv += step >= 24 * HOUR ? step : walk) {
      const d = new Date(tv);
      if (step < 24 * HOUR && step >= HOUR && d.getHours() % (step / HOUR)) continue;
      if (tv < xMin) continue;
      const px = x(tv);
      if (px < m.l + 14 || px > W - m.r - 14) continue;
      const t = el("text", { x: px, y: H - 6, "text-anchor": "middle" }, svg);
      t.textContent = step >= 24 * HOUR ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
                    : d.getHours() === 0 && d.getMinutes() === 0 ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
                    : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    // faixa desejada
    const bandTop = y(Math.min(status.max_price, yHi)), bandBot = y(Math.max(status.min_price, yLo));
    if (bandBot > bandTop) {
      el("rect", { x: m.l, y: bandTop, width: W - m.l - m.r, height: bandBot - bandTop, fill: "var(--band)" }, svg);
      const lbl = el("text", { x: W - m.r - 6, y: bandTop + 14, "text-anchor": "end", style: "fill: var(--text-secondary); font-weight: 600" }, svg);
      lbl.textContent = "Sua faixa";
    }

    // linha em degraus; interrompe quando o monitor ficou mais de 20 min sem dados
    const GAP = 20 * 60e3;
    let d = "";
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      if (cur.p == null) continue; // sem oferta nesse momento: buraco na linha
      const next = i + 1 < pts.length ? pts[i + 1].t : lastT;
      const xs = x(cur.t), xe = x(Math.min(next, now));
      const prev = pts[i - 1];
      d += (!prev || prev.p == null || cur.t - prev.t > GAP ? `M${xs},${y(cur.p)}` : `L${xs},${y(cur.p)}`) + `H${xe}`;
    }
    el("path", { d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    const last = pts[pts.length - 1];
    if (last.p != null) el("circle", { cx: x(Math.min(lastT, now)), cy: y(last.p), r: 4.5, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2 }, svg);

    const cross = el("line", { y1: m.t, y2: H - m.b, stroke: "var(--text-muted)", "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" }, svg);
    const dot = el("circle", { r: 4.5, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2, visibility: "hidden" }, svg);
    chartGeom = { pts, x, y, m, W, H, cross, dot, xMin, xMax };
  }

  function niceTicks(lo, hi, n) {
    const span = hi - lo, raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }

  function onPointer(ev) {
    if (!chartGeom) return;
    const { pts, x, y, m, W, cross, dot, xMin, xMax } = chartGeom;
    const svg = $("chart"), rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    if (px < m.l || px > W - m.r) return hideTip();
    const t = xMin + ((px - m.l) / (W - m.l - m.r)) * (xMax - xMin);
    let cur = null;
    for (const p of pts) { if (p.t <= t) cur = p; else break; }
    if (!cur) return hideTip();
    const cx = px;
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cur.p == null ? m.t : y(cur.p)); dot.setAttribute("visibility", cur.p == null ? "hidden" : "visible");
    const tip = $("tip");
    tip.replaceChildren();
    const t1 = document.createElement("div"); t1.className = "muted"; t1.textContent = fmtTime(new Date(t));
    const t2 = document.createElement("div"); const b = document.createElement("b"); b.textContent = cur.p == null ? "sem oferta" : brl(cur.p); t2.append("Menor preço: ", b);
    const t3 = document.createElement("div"); t3.textContent = `${cur.n} oferta(s) na faixa`;
    tip.append(t1, t2, t3);
    tip.style.display = "block";
    const wrap = $("chart-wrap").getBoundingClientRect();
    const left = ev.clientX - wrap.left;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(0, left + 12 + tw > wrap.width ? left - tw - 12 : left + 12), wrap.width - tw) + "px";
    tip.style.top = Math.max(0, (cur.p == null ? chartGeom.m.t : y(cur.p)) * (rect.height / chartGeom.H) - 60) + "px";
  }
  function hideTip() {
    $("tip").style.display = "none";
    if (chartGeom) { chartGeom.cross.setAttribute("visibility", "hidden"); chartGeom.dot.setAttribute("visibility", "hidden"); }
  }
  $("chart").addEventListener("pointermove", onPointer);
  $("chart").addEventListener("pointerdown", onPointer);
  $("chart").addEventListener("pointerleave", hideTip);

  // ---- controles -------------------------------------------------------------
  document.querySelectorAll(".seg button").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(+btn.dataset.h === rangeHours));
    btn.addEventListener("click", () => {
      rangeHours = +btn.dataset.h;
      try { localStorage.setItem("rangeHours", String(rangeHours)); } catch (e) {}
      document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      if (status) renderChart();
    });
  });
  $("only-hit").addEventListener("change", () => {
    try { localStorage.setItem("onlyHit", $("only-hit").checked ? "1" : "0"); } catch (e) {}
    if (status) renderOffers();
  });
  $("refresh").addEventListener("click", async () => {
    $("refresh").disabled = true;
    $("refresh").textContent = "Verificando…";
    const r = await chrome.runtime.sendMessage({ type: "checkNow" });
    $("refresh").disabled = false;
    $("refresh").textContent = "Verificar agora";
    if (r && !r.ok) $("foot").textContent = "Erro: " + r.error;
  });
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("fullscreen").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));
  chrome.storage.onChanged.addListener((changes) => { if (changes.status || changes.config) load(); });
  addEventListener("resize", () => { if (status) renderChart(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      status = await fetchStatus();
      renderHeader(); renderTiles(); renderOffers(); renderChart();
      $("foot").textContent = config && config.enabled ? `Verifica o site a cada ${Number(config.intervalMin).toLocaleString("pt-BR")} min.` : "";
    } catch (e) {
      if (e.notFound) {
        $("sub").textContent = "Ainda não há dados.";
        $("pill").className = "pill stale";
        $("pill-text").textContent = "Aguardando";
        const banner = $("banner");
        banner.className = "banner show warn";
        banner.textContent = "Nenhuma leitura ainda. Abra ⚙ Configurações, preencha sua faixa e o WhatsApp e ative o monitor.";
      } else {
        $("foot").textContent = `Erro: ${e.message}`;
      }
    } finally {
      loading = false;
    }
  }

  load();
  setInterval(() => { if (status) renderHeader(); }, 1000); // "há X s" andando
})();
