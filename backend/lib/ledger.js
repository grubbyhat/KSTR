/**
 * Append-only ledger of every real on-chain action (claims + buys).
 *
 * One JSON object per line in data/ledger.jsonl. Totals are derived by
 * replaying the file on boot, so the numbers on the dashboard survive
 * restarts and every figure is auditable back to a tx signature.
 *
 * goldEquivalent is the one *computed* figure: at the moment of each KINS buy
 * we convert that buy's USD value into in-game gold at the live spot price and
 * accumulate it. It is a labelled estimate in the UI, not a claim of a real
 * gold purchase.
 */
const fs = require('fs');
const path = require('path');
const { patch, nowTs } = require('./state');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const LEDGER = path.join(DATA_DIR, 'ledger.jsonl');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function blankTotals() {
  return {
    feesClaimedSol: 0,
    kstrBoughtUi: 0,
    kstrSolSpent: 0,
    kinsBoughtUi: 0,
    kinsSolSpent: 0,
    goldEquivalent: 0,
    claims: 0,
    buys: 0,
    cycles: 0,
  };
}

let totals = blankTotals();
let lastClaimTs = null;
let lastBuyTs = null;

function applyEvent(rec) {
  if (rec.kind === 'claim') {
    totals.feesClaimedSol += Number(rec.sol || 0);
    totals.claims += 1;
    lastClaimTs = rec.ts;
  } else if (rec.kind === 'buy') {
    if (rec.token === 'KSTR') {
      totals.kstrBoughtUi += Number(rec.tokensUi || 0);
      totals.kstrSolSpent += Number(rec.solSpent || 0);
    } else if (rec.token === 'KINS') {
      totals.kinsBoughtUi += Number(rec.tokensUi || 0);
      totals.kinsSolSpent += Number(rec.solSpent || 0);
      totals.goldEquivalent += Number(rec.goldEq || 0);
    }
    totals.buys += 1;
    lastBuyTs = rec.ts;
  } else if (rec.kind === 'cycle') {
    totals.cycles += 1;
  }
}

function publish() {
  patch('totals', { ...totals });
  patch('lastClaimTs', lastClaimTs);
  patch('lastBuyTs', lastBuyTs);
}

/** Replay the ledger file into in-memory totals and push to state. */
function load() {
  totals = blankTotals();
  lastClaimTs = null;
  lastBuyTs = null;
  try {
    if (fs.existsSync(LEDGER)) {
      const lines = fs.readFileSync(LEDGER, 'utf8').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          applyEvent(JSON.parse(t));
        } catch {
          /* skip a corrupt line rather than lose the whole ledger */
        }
      }
    }
  } catch (e) {
    console.error('[ledger] load error:', e.message);
  }
  publish();
  return { ...totals };
}

function write(rec) {
  ensureDir();
  const full = { ts: nowTs(), ...rec };
  fs.appendFileSync(LEDGER, JSON.stringify(full) + '\n');
  applyEvent(full);
  publish();
  return full;
}

function recordClaim({ sol, sig, mint }) {
  return write({ kind: 'claim', sol, sig, mint });
}

function recordBuy({ token, solSpent, tokensUi, sig, mint, goldEq }) {
  return write({ kind: 'buy', token, solSpent, tokensUi, sig, mint, goldEq: goldEq || 0 });
}

function recordCycle() {
  return write({ kind: 'cycle' });
}

function getTotals() {
  return { ...totals };
}

module.exports = { load, recordClaim, recordBuy, recordCycle, getTotals, LEDGER };
