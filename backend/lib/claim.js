/**
 * Creator-fee claimer (self-contained port of token/feeclaim/main.js).
 *
 * Handles every pump.fun fee shape:
 *   • SOL vs USDC quote coins
 *   • bonding-curve vs graduated (PumpSwap) coins
 *   • single-creator (collect_creator_fee_v2) vs fee-sharing-config
 *     (transfer_creator_fees_to_pump_v2 + distribute_creator_fees_v2)
 *
 * Exposes checkFees(mint) and claimFees(mint, priorityFeeSol). The discriminators
 * and USDC mint are inlined so this folder has no dependency on token/.
 */
const {
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SystemProgram,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');
const {
  PumpSdk,
  OnlinePumpSdk,
  feeSharingConfigPda,
  creatorVaultPda,
  canonicalPumpPoolPda,
  bondingCurvePda,
  PUMP_PROGRAM_ID,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
} = require('@pump-fun/pump-sdk');
const {
  coinCreatorVaultAuthorityPda,
  coinCreatorVaultAtaPda,
} = require('@pump-fun/pump-swap-sdk');

const { getConnection, getWallet } = require('./connection');

// ── Inlined constants (from token/shared-utils.js) ───────────────────────
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ZERO_PUBKEY = new PublicKey('11111111111111111111111111111111');
const PUMP_COLLECT_CREATOR_FEE_V2_DISCRIMINATOR = Buffer.from([207, 17, 138, 242, 4, 34, 19, 56]);
const PUMP_DISTRIBUTE_CREATOR_FEES_V2_DISCRIMINATOR = Buffer.from([255, 203, 19, 79, 244, 68, 8, 159]);
const PUMP_TRANSFER_CREATOR_FEES_TO_PUMP_V2_DISCRIMINATOR = Buffer.from([1, 33, 78, 185, 33, 67, 44, 92]);

// Detect the bonding-curve quote_mint for a coin.
async function readBondingCurveQuote(connection, mint) {
  const bondingCurve = bondingCurvePda(mint);
  const acc = await connection.getAccountInfo(bondingCurve, 'confirmed');
  if (!acc) return { quoteMint: null, isUsdcQuote: false, creator: null, complete: false, bondingCurve };
  const data = acc.data;
  const complete = data[48] === 1;
  const creator = new PublicKey(data.slice(49, 81));
  let quoteMint = null;
  let isUsdcQuote = false;
  if (data.length >= 115) {
    const qm = new PublicKey(data.slice(83, 115));
    if (!qm.equals(NATIVE_MINT) && !qm.equals(ZERO_PUBKEY)) {
      quoteMint = qm;
      isUsdcQuote = qm.equals(USDC_MINT);
    }
  }
  return { quoteMint, isUsdcQuote, creator, complete, bondingCurve };
}

function buildTransferCreatorFeesToPumpV2Ix({ payer, quoteMint, quoteTokenProgram, coinCreator }) {
  const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);
  const coinCreatorVaultAta = coinCreatorVaultAtaPda(coinCreatorVaultAuthority, quoteMint, quoteTokenProgram);
  const pumpCreatorVault = creatorVaultPda(coinCreator);
  const pumpCreatorVaultAta = getAssociatedTokenAddressSync(quoteMint, pumpCreatorVault, true, quoteTokenProgram);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: coinCreator, isSigner: false, isWritable: false },
    { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: true },
    { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: pumpCreatorVault, isSigner: false, isWritable: true },
    { pubkey: pumpCreatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: PUMP_AMM_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ keys, programId: PUMP_AMM_PROGRAM_ID, data: Buffer.from(PUMP_TRANSFER_CREATOR_FEES_TO_PUMP_V2_DISCRIMINATOR) });
}

function buildDistributeCreatorFeesV2Ix({ payer, mint, sharingConfig, quoteMint, quoteTokenProgram, shareholders, initializeAta }) {
  const bondingCurve = bondingCurvePda(mint);
  const cvault = creatorVaultPda(sharingConfig);
  const cvaultAta = getAssociatedTokenAddressSync(quoteMint, cvault, true, quoteTokenProgram);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: false },
    { pubkey: sharingConfig, isSigner: false, isWritable: false },
    { pubkey: cvault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: cvaultAta, isSigner: false, isWritable: true },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const isNative = quoteMint.equals(NATIVE_MINT);
  for (const s of shareholders) keys.push({ pubkey: s, isSigner: false, isWritable: true });
  if (!isNative) {
    for (const s of shareholders) {
      const ata = getAssociatedTokenAddressSync(quoteMint, s, false, quoteTokenProgram);
      keys.push({ pubkey: ata, isSigner: false, isWritable: true });
    }
  }
  const data = Buffer.alloc(8 + 1);
  PUMP_DISTRIBUTE_CREATOR_FEES_V2_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(initializeAta ? 1 : 0, 8);
  return new TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data });
}

function buildCollectCreatorFeeV2Ix({ creator, quoteMint, quoteTokenProgram }) {
  const creatorTokenAccount = getAssociatedTokenAddressSync(quoteMint, creator, false, quoteTokenProgram);
  const cvault = creatorVaultPda(creator);
  const cvaultTokenAccount = getAssociatedTokenAddressSync(quoteMint, cvault, true, quoteTokenProgram);
  const keys = [
    { pubkey: creator, isSigner: false, isWritable: true },
    { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
    { pubkey: cvault, isSigner: false, isWritable: true },
    { pubkey: cvaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data: Buffer.from(PUMP_COLLECT_CREATOR_FEE_V2_DISCRIMINATOR) });
}

async function readUiTokenBalance(connection, ataPubkey, info) {
  if (!info) return 0;
  try {
    const parsed = await connection.getParsedAccountInfo(ataPubkey);
    if (parsed.value && parsed.value.data && 'parsed' in parsed.value.data) {
      return parsed.value.data.parsed.info.tokenAmount.uiAmount || 0;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

/** Inspect claimable creator fees for a mint. Returns SOL (or USDC) totals. */
async function checkFees(mintStr) {
  const connection = getConnection();
  if (!connection) throw new Error('RPC not configured');
  const pumpSdk = new PumpSdk(connection);
  const mint = new PublicKey(mintStr);

  const cq = await readBondingCurveQuote(connection, mint);
  const quoteMint = cq.quoteMint || NATIVE_MINT;
  const quoteTokenProgram = TOKEN_PROGRAM_ID;
  const isUsdcQuote = !!cq.isUsdcQuote;

  const sharingConfigPubkey = feeSharingConfigPda(mint);
  const poolAddress = canonicalPumpPoolPda(mint);
  const coinCreatorVaultAuth = coinCreatorVaultAuthorityPda(sharingConfigPubkey);
  const ammVaultAta = coinCreatorVaultAtaPda(coinCreatorVaultAuth, quoteMint, quoteTokenProgram);
  const creatorVault = creatorVaultPda(sharingConfigPubkey);
  const creatorVaultAta = getAssociatedTokenAddressSync(quoteMint, creatorVault, true, quoteTokenProgram);

  const [sharingConfigInfo, poolInfo, ammVaultInfo, creatorVaultInfo, creatorVaultAtaInfo] =
    await connection.getMultipleAccountsInfo([sharingConfigPubkey, poolAddress, ammVaultAta, creatorVault, creatorVaultAta]);

  const isGraduated = poolInfo !== null;
  const hasAmmFees = ammVaultInfo !== null;

  if (!sharingConfigInfo) {
    if (!cq.creator) return { error: 'Bonding curve not found for this mint.' };
    const creator = cq.creator;
    const creatorVaultSingle = creatorVaultPda(creator);
    const creatorVaultAtaSingle = getAssociatedTokenAddressSync(quoteMint, creatorVaultSingle, true, quoteTokenProgram);
    const [creatorVaultLamports, , creatorVaultAtaInfoSingle] = await connection.getMultipleAccountsInfo([
      creatorVaultSingle,
      getAssociatedTokenAddressSync(quoteMint, creator, false, quoteTokenProgram),
      creatorVaultAtaSingle,
    ]);
    let cvBalance = 0;
    if (isUsdcQuote) cvBalance = await readUiTokenBalance(connection, creatorVaultAtaSingle, creatorVaultAtaInfoSingle);
    else cvBalance = creatorVaultLamports ? creatorVaultLamports.lamports / LAMPORTS_PER_SOL : 0;
    return {
      hasSharingConfig: false,
      isSingleCreator: true,
      creator: creator.toBase58(),
      isGraduated,
      hasAmmFees,
      isUsdcQuote,
      quoteMint: quoteMint.toBase58(),
      creatorVaultSol: cvBalance,
      ammVaultSol: 0,
      totalClaimable: cvBalance,
    };
  }

  const sharingConfig = pumpSdk.decodeSharingConfig(sharingConfigInfo);
  let vaultBalance = 0;
  if (isUsdcQuote) vaultBalance = await readUiTokenBalance(connection, creatorVaultAta, creatorVaultAtaInfo);
  else vaultBalance = creatorVaultInfo ? creatorVaultInfo.lamports / LAMPORTS_PER_SOL : 0;

  let ammBalance = 0;
  if (hasAmmFees) ammBalance = await readUiTokenBalance(connection, ammVaultAta, ammVaultInfo);

  return {
    hasSharingConfig: true,
    isGraduated,
    hasAmmFees,
    isUsdcQuote,
    quoteMint: quoteMint.toBase58(),
    shareholders: sharingConfig.shareholders.map((s) => ({ address: s.address.toBase58(), shareBps: s.shareBps })),
    admin: sharingConfig.admin.toBase58(),
    adminRevoked: sharingConfig.adminRevoked,
    creatorVaultSol: vaultBalance,
    ammVaultSol: ammBalance,
    totalClaimable: vaultBalance + ammBalance,
  };
}

/**
 * Claim creator fees for a mint. Returns { signature, claimedSol } where
 * claimedSol is the realized SOL balance delta (for the ledger).
 */
async function claimFees(mintStr, priorityFeeSol = 0.005) {
  const connection = getConnection();
  const wallet = getWallet();
  if (!connection || !wallet) throw new Error('wallet/RPC not configured');

  const pumpSdk = new PumpSdk(connection);
  const onlineSdk = new OnlinePumpSdk(connection);
  const mint = new PublicKey(mintStr);

  const cq = await readBondingCurveQuote(connection, mint);
  const isUsdcQuote = !!cq.isUsdcQuote;

  let isGraduated = false;
  let isSingleCreator = false;
  let baseInstructions = [];

  const sharingConfig = feeSharingConfigPda(mint);
  const sharingConfigInfo = await connection.getAccountInfo(sharingConfig, 'confirmed');

  if (!sharingConfigInfo) {
    isSingleCreator = true;
    if (!cq.creator) throw new Error('Bonding curve not found for this mint.');
    const quoteMint = isUsdcQuote ? USDC_MINT : NATIVE_MINT;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;
    if (isUsdcQuote) {
      const creatorAta = getAssociatedTokenAddressSync(quoteMint, cq.creator, false, quoteTokenProgram);
      baseInstructions.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, creatorAta, cq.creator, quoteMint, quoteTokenProgram));
    }
    baseInstructions.push(buildCollectCreatorFeeV2Ix({ creator: cq.creator, quoteMint, quoteTokenProgram }));
  } else if (!isUsdcQuote) {
    const r = await onlineSdk.buildDistributeCreatorFeesInstructions(mint);
    isGraduated = r.isGraduated;
    baseInstructions = r.instructions;
  } else {
    const poolAddress = canonicalPumpPoolPda(mint);
    const decoded = pumpSdk.decodeSharingConfig(sharingConfigInfo);
    const shareholders = decoded.shareholders.map((s) => s.address);
    const poolInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
    isGraduated = poolInfo !== null;
    const quoteMint = USDC_MINT;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;
    const cvault = creatorVaultPda(sharingConfig);
    const cvaultAta = getAssociatedTokenAddressSync(quoteMint, cvault, true, quoteTokenProgram);
    baseInstructions.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, cvaultAta, cvault, quoteMint, quoteTokenProgram));
    if (isGraduated) {
      baseInstructions.push(buildTransferCreatorFeesToPumpV2Ix({ payer: wallet.publicKey, quoteMint, quoteTokenProgram, coinCreator: sharingConfig }));
    }
    baseInstructions.push(buildDistributeCreatorFeesV2Ix({ payer: wallet.publicKey, mint, sharingConfig, quoteMint, quoteTokenProgram, shareholders, initializeAta: true }));
  }

  const cuLimit = isUsdcQuote && !isSingleCreator ? 600_000 : isSingleCreator ? 80_000 : 400_000;
  const allIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })];
  const microLamports = Math.floor((priorityFeeSol * 1e9 * 1e6) / cuLimit);
  if (microLamports > 0) allIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  allIxs.push(...baseInstructions);

  const balanceBefore = await connection.getBalance(wallet.publicKey);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // Realized SOL gained (USDC coins won't reflect here; claimedSol stays ~0 for those).
  const balanceAfter = await connection.getBalance(wallet.publicKey);
  const claimedSol = Math.max(0, (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL);

  return { signature: sig, claimedSol, isGraduated, isUsdcQuote, isSingleCreator };
}

module.exports = { checkFees, claimFees };
