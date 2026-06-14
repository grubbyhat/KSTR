/**
 * KSTR dashboard backend — the brain.
 *
 * - serves the public dashboard + admin panel from /public
 * - exposes a JSON API + a websocket for live state
 * - runs the loop: claim KSTR creator fees -> split spend 25% KSTR buyback /
 *   75% KINS buy (all via pump.fun). Nothing moves money unless `live` is on.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const conn = require('./lib/connection');
const { state, bus, patch, pushLog, snapshot } = require('./lib/state');
const ledger = require('./lib/ledger');
const oracles = require('./lib/oracles');
const claim = require('./lib/claim');
const { buy, burnAll } = require('./lib/buy');

const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const SITE_DIR = path.resolve(__dirname, '..', 'site');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── loop ─────────────────────────────────────────────────────────────────
let running = false;
let loopTimer = null;
let busy = false;

function computeGoldEq(solSpent) {
  const solUsd = state.prices.solUsd || 0;
  const gold = state.prices.goldSpotUsd || 0;
  if (gold <= 0) return 0;
  return (solSpent * solUsd) / gold;
}

async function runCycle({ manual = false } = {}) {
  if (busy) {
    if (manual) pushLog('warn', 'cycle already running');
    return;
  }
  busy = true;
  try {
    if (!config.kstrMint) {
      pushLog('warn', 'KSTR mint not set — nothing to do');
      return;
    }
    if (!conn.isWalletReady()) {
      pushLog('warn', 'wallet/RPC not configured — read-only');
      return;
    }

    // 1) check claimable fees
    const fees = await claim.checkFees(config.kstrMint);
    if (fees.error) {
      pushLog('warn', `check-fees: ${fees.error}`);
      return;
    }
    const pending = fees.isUsdcQuote ? 0 : fees.totalClaimable || 0;
    patch('fees', { pendingSol: pending, lastCheckTs: Date.now() });

    // 2) claim if worthwhile
    if (!fees.isUsdcQuote && pending >= config.minClaimSol) {
      if (state.live) {
        pushLog('info', `Claiming ~${pending.toFixed(4)} SOL in creator fees…`);
        const r = await claim.claimFees(config.kstrMint, config.priorityFeeSol);
        ledger.recordClaim({ sol: r.claimedSol, sig: r.signature, mint: config.kstrMint });
        pushLog('success', `Claimed ${r.claimedSol.toFixed(4)} SOL`, { sig: r.signature });
        await sleep(2000);
      } else {
        pushLog('info', `[SIM] would claim ~${pending.toFixed(4)} SOL (live OFF)`);
      }
    }

    // 3) compute spendable and split 25/75
    const lamports = await conn.getConnection().getBalance(conn.getWallet().publicKey);
    const balSol = lamports / 1e9;
    patch('balances', { sol: balSol });

    const spend = balSol - config.reserveSol;
    const kstrSpend = spend * (config.feeSplit.kstrBuybackPct / 100);
    const kinsSpend = spend * (config.feeSplit.kinsBuyPct / 100);

    if (spend < 0.002) {
      if (manual) pushLog('info', `nothing to spend (balance ${balSol.toFixed(4)} SOL)`);
    } else if (!state.live) {
      pushLog('info', `[SIM] would buy KINS ${kinsSpend.toFixed(4)} SOL + KSTR buyback ${kstrSpend.toFixed(4)} SOL (live OFF)`);
    } else {
      const buyOpts = { slippageBps: config.buySlippageBps, priorityFeeSol: config.priorityFeeSol };

      // 75% -> KINS (graduated -> PumpSwap)
      if (kinsSpend >= 0.001) {
        const rb = await buy(config.kinsMint, kinsSpend, { ...buyOpts, poolKey: config.kinsPool });
        const goldEq = computeGoldEq(rb.solSpent);
        ledger.recordBuy({ token: 'KINS', solSpent: rb.solSpent, tokensUi: rb.tokensUi, sig: rb.sig, mint: config.kinsMint, goldEq });
        pushLog('success', `Bought ${rb.tokensUi.toFixed(2)} KINS for ${kinsSpend.toFixed(4)} SOL (≈${goldEq.toFixed(2)} gold)`, { sig: rb.sig });
      }

      // 25% -> KSTR buyback (curve)
      if (kstrSpend >= 0.001) {
        const rk = await buy(config.kstrMint, kstrSpend, buyOpts);
        ledger.recordBuy({ token: 'KSTR', solSpent: rk.solSpent, tokensUi: rk.tokensUi, sig: rk.sig, mint: config.kstrMint });
        pushLog('success', `Bought back ${rk.tokensUi.toFixed(2)} KSTR for ${kstrSpend.toFixed(4)} SOL`, { sig: rk.sig });
        if (config.burnKstrBuyback) {
          const b = await burnAll(config.kstrMint, buyOpts);
          if (b.sig) pushLog('success', `Burned ${b.burnedUi.toFixed(2)} KSTR`, { sig: b.sig });
        }
      }
    }

    ledger.recordCycle();
  } catch (e) {
    pushLog('error', `cycle error: ${e.message}`);
  } finally {
    busy = false;
  }
}

async function tick() {
  if (!running) return;
  await runCycle();
  if (running) loopTimer = setTimeout(tick, config.claimIntervalMs);
}
function startLoop() {
  if (running) return;
  running = true;
  patch('running', true);
  patch('startedAt', Date.now());
  pushLog('info', 'loop started');
  tick();
}
function stopLoop() {
  running = false;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  patch('running', false);
  pushLog('info', 'loop stopped');
}

// ── HTTP + static ──────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function serveFile(res, baseDir, rel) {
  const filePath = path.join(baseDir, rel);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  // The informative public site lives in ../site and is also independently deployable.
  // Redirect to a trailing slash so relative asset URLs resolve under /site/.
  if (pathname === '/site') {
    res.writeHead(302, { Location: '/site/' });
    return res.end();
  }
  if (pathname.startsWith('/site/')) {
    const rel = pathname.replace(/^\/site\//, '') || 'index.html';
    return serveFile(res, SITE_DIR, rel);
  }
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel === 'admin' || rel === 'admin/') rel = 'admin.html';
  return serveFile(res, PUBLIC_DIR, rel);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, snapshot());
    if (req.method === 'GET' && p === '/api/config') return sendJson(res, 200, config);

    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const mintChanged = 'kstrMint' in body && body.kstrMint !== config.kstrMint;
      config = { ...config, ...body };
      if (body.feeSplit) config.feeSplit = { ...config.feeSplit, ...body.feeSplit };
      saveConfig();
      if (mintChanged) oracles.start(config); // re-subscribe WS to new mint
      pushLog('info', 'config updated');
      return sendJson(res, 200, { ok: true, config });
    }

    if (req.method === 'POST' && p === '/api/control/start') {
      startLoop();
      return sendJson(res, 200, { ok: true, running });
    }
    if (req.method === 'POST' && p === '/api/control/stop') {
      stopLoop();
      return sendJson(res, 200, { ok: true, running });
    }
    if (req.method === 'POST' && p === '/api/control/live') {
      const body = await readBody(req);
      const live = !!body.live;
      patch('live', live);
      config.live = live;
      saveConfig();
      pushLog(live ? 'warn' : 'info', live ? 'LIVE mode ON — real transactions enabled' : 'LIVE mode OFF — simulation only');
      return sendJson(res, 200, { ok: true, live });
    }

    if (req.method === 'POST' && p === '/api/action/cycle-now') {
      runCycle({ manual: true });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/action/claim-now') {
      if (!conn.isWalletReady() || !config.kstrMint) return sendJson(res, 400, { error: 'wallet or mint not configured' });
      const r = await claim.claimFees(config.kstrMint, config.priorityFeeSol);
      ledger.recordClaim({ sol: r.claimedSol, sig: r.signature, mint: config.kstrMint });
      pushLog('success', `Manual claim: ${r.claimedSol.toFixed(4)} SOL`, { sig: r.signature });
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (req.method === 'POST' && p === '/api/action/check-fees') {
      if (!config.kstrMint) return sendJson(res, 400, { error: 'mint not set' });
      const fees = await claim.checkFees(config.kstrMint);
      patch('fees', { pendingSol: fees.isUsdcQuote ? 0 : fees.totalClaimable || 0, lastCheckTs: Date.now() });
      return sendJson(res, 200, fees);
    }
    if (req.method === 'POST' && p === '/api/action/buy-now') {
      const body = await readBody(req);
      const token = body.token === 'KSTR' ? 'KSTR' : 'KINS';
      const mint = token === 'KSTR' ? config.kstrMint : config.kinsMint;
      const sol = Number(body.sol);
      if (!mint || !(sol > 0)) return sendJson(res, 400, { error: 'bad token/sol' });
      if (!state.live) return sendJson(res, 400, { error: 'live mode is OFF' });
      const r = await buy(mint, sol, { slippageBps: config.buySlippageBps, priorityFeeSol: config.priorityFeeSol, poolKey: token === 'KINS' ? config.kinsPool : undefined });
      const goldEq = token === 'KINS' ? computeGoldEq(r.solSpent) : 0;
      ledger.recordBuy({ token, solSpent: r.solSpent, tokensUi: r.tokensUi, sig: r.sig, mint, goldEq });
      pushLog('success', `Manual buy ${token}: ${r.tokensUi.toFixed(2)} for ${sol} SOL`, { sig: r.sig });
      return sendJson(res, 200, { ok: true, ...r });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

// ── websocket: push live state ──────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'snapshot', state: snapshot(), config }));
  ws.on('close', () => clients.delete(ws));
});
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}
let stateDirty = false;
bus.on('update', () => (stateDirty = true));
bus.on('log', (entry) => broadcast({ type: 'log', entry }));
setInterval(() => {
  if (stateDirty) {
    stateDirty = false;
    broadcast({ type: 'state', state: snapshot() });
  }
}, 250);

// ── boot ─────────────────────────────────────────────────────────────────
function boot() {
  patch('wallet', { configured: conn.status().walletConfigured, address: conn.status().walletAddress, rpcHost: conn.status().rpcHost });
  patch('live', !!config.live);
  ledger.load();
  oracles.start(config);

  server.listen(config.httpPort, () => {
    console.log(`[kstr] dashboard:  http://localhost:${config.httpPort}/`);
    console.log(`[kstr] admin:      http://localhost:${config.httpPort}/admin`);
    console.log(`[kstr] websocket:  ws://localhost:${config.httpPort}/ws`);
    console.log(`[kstr] wallet:     ${conn.status().walletAddress || '(not configured)'}`);
    console.log(`[kstr] live:       ${config.live ? 'ON' : 'OFF (simulation)'}`);
  });

  if (config.autoStart && conn.isWalletReady() && config.kstrMint) startLoop();
}
boot();
