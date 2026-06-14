/**
 * Price/market oracles. All read-only - these run even with no wallet.
 *
 *   • gold spot   -> kintaragold.xyz embedded `spotPriceUsd` (polled)
 *   • KINS price  -> Dexscreener (also yields SOL/USD)
 *   • KSTR mcap   -> Helius accountSubscribe WS on the bonding curve (live),
 *                    recomputed from virtual reserves; Dexscreener fallback
 *                    once KSTR graduates.
 */
const axios = require('axios');
const WebSocket = require('ws');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { bondingCurvePda, OnlinePumpSdk } = require('@pump-fun/pump-sdk');

const { getConnection, WS_URL } = require('./connection');
const { patch, pushGold, state, pushLog } = require('./state');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let timers = [];
let kstrWs = null;
let kstrWsAlive = false;

// ── Gold spot from kintaragold.xyz ───────────────────────────────────────
async function fetchGoldSpot(url) {
  const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 10000 });
  const html = String(res.data || '');
  // Value is embedded inside escaped JSON in the RSC payload, e.g. \\\"spotPriceUsd\\\":4.55
  const m =
    html.match(/spotPriceUsd[\\":\s]*([0-9]+(?:\.[0-9]+)?)/) ||
    html.match(/latestGoldUsd[\\":\s]*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) throw new Error('gold spot not found in page');
  return parseFloat(m[1]);
}

async function pollGold(cfg) {
  try {
    const usd = await fetchGoldSpot(cfg.goldPriceUrl);
    patch('prices', { goldSpotUsd: usd, updatedAt: Date.now() });
    pushGold(usd);
  } catch (e) {
    pushLog('warn', `gold spot poll failed: ${e.message}`);
  }
}

// ── Dexscreener (KINS price + SOL/USD; KSTR fallback) ────────────────────
async function fetchDexToken(mint) {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 10000 });
  const pairs = (res.data && res.data.pairs) || [];
  if (!pairs.length) return null;
  // Prefer the deepest SOL-quoted pair.
  pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  return pairs[0];
}

async function pollDex(cfg) {
  try {
    const kins = await fetchDexToken(cfg.kinsMint);
    if (kins) {
      const priceUsd = parseFloat(kins.priceUsd) || 0;
      const priceNative = parseFloat(kins.priceNative) || 0; // KINS price in SOL
      const solUsd = priceNative > 0 ? priceUsd / priceNative : state.prices.solUsd;
      patch('prices', { kinsUsd: priceUsd, solUsd, updatedAt: Date.now() });
      patch('market', { kinsMcapUsd: kins.marketCap || kins.fdv || 0 });
    }
  } catch (e) {
    pushLog('warn', `dexscreener poll failed: ${e.message}`);
  }

  // KSTR via Dexscreener only as a fallback (no live curve / graduated).
  if (cfg.kstrMint && (state.market.kstrGraduated || !kstrWsAlive)) {
    try {
      const kstr = await fetchDexToken(cfg.kstrMint);
      if (kstr) {
        patch('market', { kstrMcapUsd: kstr.marketCap || kstr.fdv || 0, kstrGraduated: true });
        patch('prices', { kstrPriceUsd: parseFloat(kstr.priceUsd) || 0 });
      }
    } catch {
      /* KSTR may not exist yet - silent */
    }
  }
}

// ── KSTR marketcap from the bonding curve (live via Helius WS) ────────────
async function recomputeKstrFromCurve(cfg) {
  const connection = getConnection();
  if (!connection || !cfg.kstrMint) return;
  try {
    const mint = new PublicKey(cfg.kstrMint);
    const online = new OnlinePumpSdk(connection);
    const bc = await online.fetchBondingCurve(mint);
    if (!bc) return; // graduated or not found -> dex fallback handles it
    if (bc.complete === true) {
      patch('market', { kstrGraduated: true });
      return;
    }
    const vSol = Number(bc.virtualSolReserves) / LAMPORTS_PER_SOL;
    const supplyInfo = await connection.getTokenSupply(mint);
    const decimals = supplyInfo.value.decimals;
    const vTokensUi = Number(bc.virtualTokenReserves) / Math.pow(10, decimals);
    const uiSupply = supplyInfo.value.uiAmount || 0;
    if (vTokensUi <= 0) return;

    const priceSol = vSol / vTokensUi; // SOL per token
    const solUsd = state.prices.solUsd || 0;
    const mcapUsd = priceSol * uiSupply * solUsd;
    patch('market', { kstrPriceSol: priceSol, kstrMcapUsd: mcapUsd, kstrGraduated: false });
    patch('prices', { kstrPriceUsd: priceSol * solUsd });
  } catch (e) {
    pushLog('warn', `KSTR curve recompute failed: ${e.message}`);
  }
}

function startKstrWs(cfg) {
  if (!WS_URL || !cfg.kstrMint) return;
  let curvePubkey;
  try {
    curvePubkey = bondingCurvePda(new PublicKey(cfg.kstrMint)).toBase58();
  } catch {
    return;
  }

  function connect() {
    kstrWs = new WebSocket(WS_URL);
    kstrWs.on('open', () => {
      kstrWsAlive = true;
      kstrWs.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'accountSubscribe',
          params: [curvePubkey, { encoding: 'base64', commitment: 'confirmed' }],
        })
      );
      pushLog('info', 'KSTR bonding-curve websocket subscribed');
      recomputeKstrFromCurve(cfg);
    });
    kstrWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.method === 'accountNotification') recomputeKstrFromCurve(cfg);
      } catch {
        /* ignore */
      }
    });
    kstrWs.on('close', () => {
      kstrWsAlive = false;
      setTimeout(connect, 5000); // auto-reconnect
    });
    kstrWs.on('error', () => {
      try {
        kstrWs.close();
      } catch {
        /* ignore */
      }
    });
  }
  connect();
}

function start(cfg) {
  stop();
  pollGold(cfg);
  pollDex(cfg);
  timers.push(setInterval(() => pollGold(cfg), cfg.goldPricePollMs || 30000));
  timers.push(setInterval(() => pollDex(cfg), cfg.dexPollMs || 20000));
  startKstrWs(cfg);
}

function stop() {
  timers.forEach(clearInterval);
  timers = [];
  if (kstrWs) {
    try {
      kstrWs.removeAllListeners('close');
      kstrWs.close();
    } catch {
      /* ignore */
    }
    kstrWs = null;
  }
}

module.exports = { start, stop, recomputeKstrFromCurve, fetchGoldSpot, fetchDexToken };
