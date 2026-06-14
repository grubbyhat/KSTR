/**
 * Central live state + a tiny pub/sub.
 *
 * Everything the dashboard shows lives here. Modules call `patch()` to update
 * a slice; the server subscribes to `bus` and broadcasts the new snapshot to
 * every connected websocket client. The ledger owns the authoritative totals
 * and pushes them in via patch('totals', ...).
 */
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(0);

const state = {
  live: false, // admin toggle: are we actually moving money?
  running: false, // is the claim/buy loop active?
  startedAt: null,

  wallet: { configured: false, address: null, rpcHost: null },

  // realtime balances / pending
  balances: { sol: 0 },
  fees: { pendingSol: 0, lastCheckTs: null },

  // running totals (authoritative copy lives in the ledger)
  totals: {
    feesClaimedSol: 0,
    kstrBoughtUi: 0,
    kstrSolSpent: 0,
    kinsBoughtUi: 0,
    kinsSolSpent: 0,
    goldEquivalent: 0, // computed display figure (labelled as estimate in UI)
    claims: 0,
    buys: 0,
    cycles: 0,
  },

  // live prices
  prices: {
    solUsd: 0,
    kinsUsd: 0,
    kstrPriceUsd: 0,
    goldSpotUsd: 0, // in-game gold spot from kintaragold.xyz
    updatedAt: null,
  },

  // market data
  market: {
    kstrMcapUsd: 0,
    kstrPriceSol: 0,
    kstrGraduated: false,
    kinsMcapUsd: 0,
  },

  goldHistory: [], // [{ t, usd }] for the chart
  log: [], // recent operation log entries

  lastClaimTs: null,
  lastBuyTs: null,
};

const MAX_LOG = 300;
const MAX_GOLD_HISTORY = 2000;

function snapshot() {
  return state;
}

/** Shallow-merge a value into a top-level slice and notify subscribers. */
function patch(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && state[key] && typeof state[key] === 'object') {
    state[key] = { ...state[key], ...value };
  } else {
    state[key] = value;
  }
  bus.emit('update', { key });
}

function pushLog(type, message, extra = {}) {
  const entry = { ts: Date.now(), type, message, ...extra };
  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  bus.emit('log', entry);
  return entry;
}

function pushGold(usd, t) {
  if (!usd || !isFinite(usd)) return;
  state.goldHistory.push({ t: t || nowTs(), usd });
  if (state.goldHistory.length > MAX_GOLD_HISTORY) {
    state.goldHistory.splice(0, state.goldHistory.length - MAX_GOLD_HISTORY);
  }
}

// Time helper kept here so callers don't sprinkle Date.now() everywhere.
function nowTs() {
  return Date.now();
}

module.exports = { bus, state, snapshot, patch, pushLog, pushGold, nowTs };
