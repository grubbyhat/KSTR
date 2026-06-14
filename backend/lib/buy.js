/**
 * Unified pump.fun buyer — no Jupiter.
 *
 * Auto-routes by token state:
 *   • bonding curve (not graduated)  -> @pump-fun/pump-sdk  buyInstructions
 *   • graduated (PumpSwap pool)      -> @pump-fun/pump-swap-sdk  buyQuoteInput
 *
 * KSTR (fresh) takes the curve path; KINS (graduated) takes the PumpSwap path.
 * Both SDKs treat `slippage` as a percent, so we pass slippageBps/100.
 *
 * Tokens received are measured from the ATA balance delta (authoritative),
 * not estimated, so the ledger records what actually landed.
 */
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createBurnInstruction,
  createCloseAccountInstruction,
} = require('@solana/spl-token');
const BN = require('bn.js');
const {
  OnlinePumpSdk,
  PumpSdk,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
} = require('@pump-fun/pump-sdk');
const {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  canonicalPumpPoolPda,
} = require('@pump-fun/pump-swap-sdk');

const { getConnection, getWallet } = require('./connection');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tokenUiBalance(connection, ata) {
  try {
    const r = await connection.getTokenAccountBalance(ata);
    return r.value.uiAmount || 0;
  } catch {
    return 0; // ATA doesn't exist yet
  }
}

/** Is this mint still on the bonding curve, or graduated to PumpSwap? */
async function detectRoute(connection, mintPk) {
  const online = new OnlinePumpSdk(connection);
  try {
    const bc = await online.fetchBondingCurve(mintPk);
    if (bc && bc.complete !== true) return { route: 'curve', bondingCurve: bc };
  } catch {
    /* no bonding curve -> graduated */
  }
  return { route: 'pumpswap' };
}

async function buildCurveBuy({ connection, wallet, mint, solLamports, slippagePct, bondingCurve }) {
  const online = new OnlinePumpSdk(connection);
  const offline = new PumpSdk(connection);

  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();

  const bcPk = bondingCurvePda(mint);
  const bcInfo = await connection.getAccountInfo(bcPk);
  if (!bcInfo) throw new Error('bonding curve account missing');

  const supplyInfo = await connection.getTokenSupply(mint);
  const mintSupply = new BN(supplyInfo.value.amount);

  // Desired token amount for the given SOL; buyInstructions pads SOL by slippage%.
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply,
    bondingCurve,
    amount: solLamports,
  });

  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  let associatedUserAccountInfo = null;
  try {
    associatedUserAccountInfo = await connection.getAccountInfo(ata);
  } catch {
    /* fine, SDK creates it */
  }

  return offline.buyInstructions({
    global,
    bondingCurveAccountInfo: bcInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user: wallet.publicKey,
    amount,
    solAmount: solLamports,
    slippage: slippagePct,
  });
}

async function buildPumpSwapBuy({ connection, wallet, mint, solLamports, slippagePct, poolKey }) {
  const online = new OnlinePumpAmmSdk(connection);
  const offline = new PumpAmmSdk();
  const pool = poolKey ? new PublicKey(poolKey) : canonicalPumpPoolPda(mint);
  const swapState = await online.swapSolanaState(pool, wallet.publicKey);
  // buyQuoteInput: spend `quote` (wSOL lamports) to buy base; SDK wraps/unwraps SOL.
  return offline.buyQuoteInput(swapState, solLamports, slippagePct);
}

async function sendV0(connection, wallet, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection
    .confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    .catch(() => {});
  return sig;
}

/**
 * Buy `solAmount` SOL worth of `mintStr`.
 * @returns {Promise<{sig, tokensUi, route, solSpent}>}
 */
async function buy(mintStr, solAmount, opts = {}) {
  const connection = getConnection();
  const wallet = getWallet();
  if (!connection || !wallet) throw new Error('wallet/RPC not configured');
  if (!(solAmount > 0)) throw new Error('solAmount must be > 0');

  const mint = new PublicKey(mintStr);
  const slippagePct = (opts.slippageBps != null ? opts.slippageBps : 200) / 100;
  const priorityFeeSol = opts.priorityFeeSol != null ? opts.priorityFeeSol : 0.005;
  const solLamports = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));

  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const before = await tokenUiBalance(connection, ata);

  const route = await detectRoute(connection, mint);
  const buyIxs =
    route.route === 'curve'
      ? await buildCurveBuy({ connection, wallet, mint, solLamports, slippagePct, bondingCurve: route.bondingCurve })
      : await buildPumpSwapBuy({ connection, wallet, mint, solLamports, slippagePct, poolKey: opts.poolKey });

  const cuLimit = route.route === 'curve' ? 300_000 : 360_000;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })];
  const microLamports = Math.floor((priorityFeeSol * 1e9 * 1e6) / cuLimit);
  if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  ixs.push(...buyIxs);

  const sig = await sendV0(connection, wallet, ixs);
  await sleep(1800);
  const after = await tokenUiBalance(connection, ata);

  return { sig, tokensUi: Math.max(0, after - before), route: route.route, solSpent: solAmount };
}

/** Burn the entire balance of `mintStr` (optional KSTR buyback-and-burn). */
async function burnAll(mintStr, opts = {}) {
  const connection = getConnection();
  const wallet = getWallet();
  if (!connection || !wallet) throw new Error('wallet/RPC not configured');

  const mint = new PublicKey(mintStr);
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  let raw;
  try {
    raw = await connection.getTokenAccountBalance(ata);
  } catch {
    return { sig: null, burnedUi: 0 };
  }
  const amount = BigInt(raw.value.amount);
  if (amount === 0n) return { sig: null, burnedUi: 0 };

  const priorityFeeSol = opts.priorityFeeSol != null ? opts.priorityFeeSol : 0.005;
  const cuLimit = 120_000;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })];
  const microLamports = Math.floor((priorityFeeSol * 1e9 * 1e6) / cuLimit);
  if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  ixs.push(createBurnInstruction(ata, mint, wallet.publicKey, amount));
  ixs.push(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey));

  const sig = await sendV0(connection, wallet, ixs);
  return { sig, burnedUi: raw.value.uiAmount || 0 };
}

module.exports = { buy, burnAll, detectRoute };
