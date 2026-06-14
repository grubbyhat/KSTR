/* KSTR public site — polls the engine's /api/state and reflects it live.
   Polling (not websocket) keeps it simple and CORS-friendly when hosted
   on a different origin than the engine. */
(function () {
  const API = (window.KSTR_API || '').replace(/\/$/, '');
  const LINKS = window.KSTR_LINKS || {};
  const $ = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  const fmt = (n, d = 2) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const fmtUsd = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + fmt(n, 2);
  };

  // static links
  function applyLinks() {
    if (LINKS.x) $('lnkX').href = LINKS.x;
    if (LINKS.game) $('lnkGame').href = LINKS.game;
    if (LINKS.gold) $('lnkGold').href = LINKS.gold;
    if (LINKS.pumpfun) { const b = $('buyBtn'); b.href = LINKS.pumpfun; b.style.display = ''; }
  }

  function render(s) {
    const t = s.totals || {}, pr = s.prices || {}, mk = s.market || {};
    setText('feesSol', fmt(t.feesClaimedSol, 3));
    setText('feesUsd', 'SOL · ' + fmtUsd((t.feesClaimedSol || 0) * (pr.solUsd || 0)));
    setText('kinsAmt', fmtInt(t.kinsBoughtUi));
    setText('kinsUsd', fmtUsd((t.kinsBoughtUi || 0) * (pr.kinsUsd || 0)));
    setText('kstrMcap', fmtUsd(mk.kstrMcapUsd));
    setText('kstrPrice', pr.kstrPriceUsd ? '$' + Number(pr.kstrPriceUsd).toPrecision(4) : '—');
    setText('goldEq', fmt(t.goldEquivalent, 2));
    setText('goldEqUsd', fmtUsd((t.goldEquivalent || 0) * (pr.goldSpotUsd || 0)));
    setText('goldSpot', fmt(pr.goldSpotUsd, 3));
    setText('navLive', s.live ? 'LIVE' : 'LIVE');
    setText('updated', 'updated ' + new Date().toLocaleTimeString('en-GB'));
  }

  async function poll() {
    try {
      const res = await fetch(API + '/api/state', { cache: 'no-store' });
      render(await res.json());
    } catch {
      setText('updated', 'engine offline — numbers will resume when it reconnects');
    }
  }

  applyLinks();
  poll();
  setInterval(poll, 5000);
})();
