# KSTR · Kintara Gold Engine

A live dashboard for the KSTR coin. It claims KSTR's pump.fun **creator fees**, then
splits the spend **75% → buy KINS** (graduated → PumpSwap) and **25% → buy back KSTR**
(bonding curve) — all routed through pump.fun's own programs (no Jupiter). It tracks fees
claimed, KINS bought, KSTR marketcap (live via Helius websocket), the Kintara **gold spot
price** (from kintaragold.xyz), and a computed **gold-equivalent** figure. Styled to match
the Kintara game; meant to be screen-shared on stream next to the game.

## Layout

```
kstr/
  backend/   the brain — claim/buy loop, oracles, ledger, HTTP+WS, serves the dashboard
  admin/     Electron app — runs the backend in-process + control panel + Stream Mode
```

## Setup

1. **Backend secrets** — copy `backend/.env.example` → `backend/.env` and fill:
   - `RPC_URL` = your Helius RPC (the websocket URL is derived automatically)
   - `WALLET_PRIVATE_KEY` = base58 secret key of the **KSTR creator wallet**
     (only the creator can claim KSTR's fees; this same wallet buys KINS/KSTR)
2. **Install**
   ```
   cd backend && npm install
   cd ../admin && npm install
   ```
3. **At KSTR launch** — paste the KSTR mint into the admin **Configuration** panel
   (or set `kstrMint` in `backend/config.json`) and Save.

## Run

- **Dashboard only (headless):** `cd backend && npm start` →
  - public dashboard: http://localhost:8790/
  - admin panel:      http://localhost:8790/admin
- **Electron (recommended for streaming):** `cd admin && npm start`
  - opens the control panel; **F11** opens fullscreen **Stream Mode** (the public view)

## Safety: LIVE vs SIM

The engine boots in **SIM** mode — it logs what it *would* do but moves no money.
Flip **GO LIVE** in the admin panel (or `live: true` in config) to enable real
transactions. `minClaimSol`, `reserveSol`, `buySlippageBps`, `priorityFeeSol`, the
25/75 `feeSplit`, and `burnKstrBuyback` are all configurable live.

## What's real vs. estimated

Fees claimed, KINS bought, KSTR buyback, and KSTR marketcap are **real on-chain** figures —
each action links to its Solscan tx in the activity feed. **"Gold Acquired"** is a labelled
conversion estimate (KINS value ÷ gold spot); the actual in-game gold buying is done/shown
separately on stream.

## Key addresses

- KINS: `Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump` (PumpSwap)
- Kintara GOLD token (reference only, not used for buys): `JCWS5oy3PKRKxK5FTKd9ELa3AZ2PAjJzkaWcUD61pump`
