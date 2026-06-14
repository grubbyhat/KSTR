/* KSTR dashboard client - connects to the backend websocket and renders
   live state. Shared by the public dashboard and the admin panel. */

const KSTR = (() => {
  let state = null;
  let config = null;
  let onState = null;

  const $ = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  // ── formatting ──
  const fmt = (n, d = 2) =>
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtUsd = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + fmt(n, 2);
  };
  const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '-');
  const timeStr = (ts) => new Date(ts).toLocaleTimeString('en-GB');

  // ── render ──
  function render() {
    if (!state) return;

    // live + connection
    const lb = $('liveBadge');
    if (lb) {
      lb.textContent = state.live ? '● LIVE' : '○ SIM';
      lb.className = 'badge ' + (state.live ? 'live-on' : 'live-off');
    }
    setText('walletAddr', short(state.wallet && state.wallet.address));
    setText('runState', state.running ? 'RUNNING' : 'IDLE');

    const t = state.totals || {};
    const pr = state.prices || {};
    const mk = state.market || {};

    // fees claimed
    setText('feesSol', fmt(t.feesClaimedSol, 3));
    setText('feesUsd', fmtUsd((t.feesClaimedSol || 0) * (pr.solUsd || 0)));

    // KINS bought
    setText('kinsAmt', fmtInt(t.kinsBoughtUi));
    setText('kinsUsd', fmtUsd((t.kinsBoughtUi || 0) * (pr.kinsUsd || 0)) + ' • ' + fmt(t.kinsSolSpent, 2) + ' SOL');

    // KSTR buyback
    setText('kstrBought', fmtInt(t.kstrBoughtUi));
    setText('kstrSpent', fmt(t.kstrSolSpent, 2) + ' SOL spent');

    // KSTR marketcap
    setText('kstrMcap', fmtUsd(mk.kstrMcapUsd));
    setText('kstrPrice', pr.kstrPriceUsd ? '$' + Number(pr.kstrPriceUsd).toPrecision(4) : '-');

    // gold spot + equivalent ($ sign is in the HTML)
    setText('goldSpot', fmt(pr.goldSpotUsd, 3));
    setText('goldUpdated', pr.updatedAt ? 'updated ' + timeStr(pr.updatedAt) : '');
    setText('goldEq', fmt(t.goldEquivalent, 2));
    setText('goldEqUsd', fmtUsd((t.goldEquivalent || 0) * (pr.goldSpotUsd || 0)));

    // KINS mcap (context)
    setText('kinsMcap', fmtUsd(mk.kinsMcapUsd));
    setText('kinsPrice', pr.kinsUsd ? '$' + Number(pr.kinsUsd).toPrecision(4) : '-');
    setText('solPrice', pr.solUsd ? '$' + fmt(pr.solUsd, 2) : '-');

    // split bar
    const cfg = config || {};
    const split = cfg.feeSplit || { kinsBuyPct: 75, kstrBuybackPct: 25 };
    const kEl = $('splitKins'), sEl = $('splitKstr');
    if (kEl) kEl.style.width = split.kinsBuyPct + '%';
    if (sEl) sEl.style.width = split.kstrBuybackPct + '%';
    setText('splitKinsPct', split.kinsBuyPct + '%');
    setText('splitKstrPct', split.kstrBuybackPct + '%');

    setText('cycles', fmtInt(t.cycles));

    drawChart(state.goldHistory || []);
    if (onState) onState(state, config);
  }

  // ── gold price chart ──
  function drawChart(history) {
    const cv = $('goldChart');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (history.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('collecting gold price…', 12, h / 2);
      return;
    }
    const vals = history.map((p) => p.usd);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 0.01; max += 0.01; }
    const pad = 8;
    const x = (i) => pad + (i / (history.length - 1)) * (w - pad * 2);
    const y = (v) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 3; g++) {
      const gy = pad + (g / 3) * (h - pad * 2);
      ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(w - pad, gy); ctx.stroke();
    }
    // area
    ctx.beginPath();
    ctx.moveTo(x(0), y(vals[0]));
    history.forEach((p, i) => ctx.lineTo(x(i), y(p.usd)));
    ctx.lineTo(x(history.length - 1), h - pad);
    ctx.lineTo(x(0), h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,194,60,0.35)');
    grad.addColorStop(1, 'rgba(255,194,60,0)');
    ctx.fillStyle = grad; ctx.fill();
    // line
    ctx.beginPath();
    ctx.moveTo(x(0), y(vals[0]));
    history.forEach((p, i) => ctx.lineTo(x(i), y(p.usd)));
    ctx.strokeStyle = '#ffc23c'; ctx.lineWidth = 2; ctx.stroke();
    // last label
    ctx.fillStyle = '#fff'; ctx.font = '11px Inter, sans-serif';
    ctx.fillText('$' + vals[vals.length - 1].toFixed(3), x(history.length - 1) - 44, y(vals[vals.length - 1]) - 8);
  }

  // ── log ──
  function addLog(entry) {
    const box = $('log');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'row lvl-' + (entry.type || 'info');
    const sig = entry.sig
      ? ` <a href="https://solscan.io/tx/${entry.sig}" target="_blank">tx↗</a>`
      : '';
    row.innerHTML = `<span class="t">${timeStr(entry.ts)}</span><span class="m">${escapeHtml(entry.message)}${sig}</span>`;
    box.prepend(row);
    while (box.children.length > 200) box.removeChild(box.lastChild);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function renderLogs(logs) {
    const box = $('log');
    if (!box) return;
    box.innerHTML = '';
    (logs || []).slice().reverse().forEach(addLog);
  }

  // ── websocket ──
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    const dot = $('connDot'), ct = $('connText');
    ws.onopen = () => { if (dot) dot.className = 'dot ok'; if (ct) ct.textContent = 'connected'; };
    ws.onclose = () => {
      if (dot) dot.className = 'dot'; if (ct) ct.textContent = 'reconnecting…';
      setTimeout(connect, 2000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        state = msg.state; config = msg.config; render(); renderLogs(state.log);
      } else if (msg.type === 'state') {
        state = msg.state; render();
      } else if (msg.type === 'log') {
        addLog(msg.entry);
      }
    };
  }

  // admin helper
  async function api(path, body) {
    const res = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }

  return {
    init(cb) { onState = cb; connect(); window.addEventListener('resize', render); },
    api,
    getState: () => state,
    getConfig: () => config,
  };
})();
