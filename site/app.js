/* KSTR public site: live stats (polling), contract-copy, count-up + scroll reveal. */
(function () {
  const API = (window.KSTR_API || '').replace(/\/$/, '');
  const LINKS = window.KSTR_LINKS || {};
  const $ = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fmt = (n, d = 2) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const fmtUsd = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + fmt(n, 2);
  };
  const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : 'soon');

  // ---- links + contract chip ----
  function applyLinks() {
    if (LINKS.x) $('lnkX').href = LINKS.x;
    if (LINKS.game) $('lnkGame').href = LINKS.game;
    if (LINKS.gold) $('lnkGold').href = LINKS.gold;
    if (LINKS.pumpfun) { const b = $('buyBtn'); b.href = LINKS.pumpfun; b.style.display = ''; }

    const c = LINKS.contract || '';
    setText('caText', short(c));
    setText('caTextFoot', short(c));
    [['caChip', 'caText'], ['caChipFoot', 'caTextFoot']].forEach(([btnId, spanId]) => {
      const btn = $(btnId), span = $(spanId);
      if (!btn || !span) return;
      btn.onclick = () => {
        if (!c) return;
        navigator.clipboard.writeText(c).then(() => {
          const old = span.textContent;
          span.textContent = 'copied';
          btn.classList.add('copied');
          setTimeout(() => { span.textContent = old; btn.classList.remove('copied'); }, 1200);
        });
      };
    });
  }

  // ---- count-up (first value only) then live updates ----
  const firstDone = {};
  function animNum(id, value, fmtFn) {
    const el = $(id);
    if (!el) return;
    const to = Number(value) || 0;
    if (firstDone[id]) { el.textContent = fmtFn(to); return; }
    firstDone[id] = true;
    if (to === 0 || reduced()) { el.textContent = fmtFn(to); return; }
    const start = performance.now(), dur = 900;
    (function step(now) {
      const t = Math.min((now - start) / dur, 1);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = fmtFn(to * e);
      if (t < 1) requestAnimationFrame(step);
    })(performance.now());
  }

  function render(s) {
    const t = s.totals || {}, pr = s.prices || {}, mk = s.market || {};
    animNum('feesSol', t.feesClaimedSol, (v) => fmt(v, 3));
    animNum('kinsAmt', t.kinsBoughtUi, (v) => fmtInt(v));
    animNum('kstrMcap', mk.kstrMcapUsd, (v) => fmtUsd(v));
    animNum('goldEq', t.goldEquivalent, (v) => fmt(v, 2));
    animNum('goldSpot', pr.goldSpotUsd, (v) => fmt(v, 3));
    setText('feesUsd', 'SOL · ' + fmtUsd((t.feesClaimedSol || 0) * (pr.solUsd || 0)));
    setText('kinsUsd', fmtUsd((t.kinsBoughtUi || 0) * (pr.kinsUsd || 0)));
    setText('kstrPrice', pr.kstrPriceUsd ? '$' + Number(pr.kstrPriceUsd).toPrecision(4) : ' ');
    setText('goldEqUsd', fmtUsd((t.goldEquivalent || 0) * (pr.goldSpotUsd || 0)));
    setText('updated', 'updated ' + new Date().toLocaleTimeString('en-GB'));
  }

  async function poll() {
    try {
      const res = await fetch(API + '/api/state', { cache: 'no-store' });
      render(await res.json());
    } catch {
      setText('updated', 'engine offline, numbers will resume when it reconnects');
    }
  }

  applyLinks();
  poll();
  setInterval(poll, 5000);
})();
