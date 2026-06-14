/**
 * Wallet + RPC bootstrap.
 *
 * On-chain actions (claim, buy) need both RPC_URL and WALLET_PRIVATE_KEY.
 * The read-only side of the dashboard (KINS price, gold spot, even KSTR
 * marketcap via a public RPC) can run with neither, so this module never
 * throws on load - callers check `isWalletReady()` before signing anything.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

const RPC_URL =
  process.env.RPC_URL || process.env.RPC_ENDPOINT || process.env.HELIUS_RPC || null;
const RAW_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || null;

function deriveWsUrl(httpUrl) {
  if (!httpUrl) return null;
  if (process.env.RPC_WS_URL) return process.env.RPC_WS_URL;
  return httpUrl.replace(/^http(s?):\/\//, (_, s) => `ws${s}://`);
}

let _connection = null;
let _wallet = null;
let _walletError = null;

function getConnection() {
  if (!RPC_URL) return null;
  if (!_connection) {
    _connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return _connection;
}

function getWallet() {
  if (_wallet || !RAW_KEY) return _wallet;
  try {
    _wallet = Keypair.fromSecretKey(bs58.decode(RAW_KEY.trim()));
  } catch (e) {
    _walletError = e.message;
    _wallet = null;
  }
  return _wallet;
}

function isWalletReady() {
  return !!(RPC_URL && getWallet());
}

function status() {
  const w = getWallet();
  return {
    rpcConfigured: !!RPC_URL,
    walletConfigured: !!w,
    walletAddress: w ? w.publicKey.toBase58() : null,
    walletError: _walletError,
    rpcHost: RPC_URL ? new URL(RPC_URL).host : null,
  };
}

module.exports = {
  RPC_URL,
  WS_URL: deriveWsUrl(RPC_URL),
  LAMPORTS_PER_SOL,
  getConnection,
  getWallet,
  isWalletReady,
  status,
};
