// lib/trades.js
'use strict';

const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const { loadConfig } = require('./swap/swapConfig');
const { performTrade } = require('./swapEngine');
const getWalletPrivateKey = require('./wallets/getWalletPrivateKey');

/**
 * Decode the registry-managed private key for a wallet alias into a Keypair.
 *
 * @param {string} walletAlias
 * @returns {Promise<import('@solana/web3.js').Keypair>}
 */
async function getKeypairForWallet(walletAlias) {
  const raw = await getWalletPrivateKey(walletAlias);
  if (!raw) {
    throw new Error(`Private key not found for wallet alias "${walletAlias}"`);
  }

  const trimmed = raw.trim();
  const secretBytes = trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);

  return Keypair.fromSecretKey(secretBytes);
}

/**
 * Execute a buy swap using the configured wallet and swap engine.
 *
 * @param {object} params
 * @param {string} params.walletAlias
 * @param {string} params.mint
 * @param {number|string} params.amount
 * @param {number} [params.slippagePercent]
 * @param {number|string} [params.priorityFee]
 * @param {boolean} [params.useJito]
 * @param {boolean} [params.dryRun]
 * @returns {Promise<import('./swapEngine').TradeResult>}
 */
async function buyToken({ walletAlias, mint, amount, slippagePercent, priorityFee, useJito, dryRun }) {
  const cfg = await loadConfig();
  const keypair = await getKeypairForWallet(walletAlias);

  const slippage = Number(slippagePercent ?? cfg.slippage ?? 15);
  const priorityFeeArg = priorityFee === 'auto'
    ? 'auto'
    : Number(priorityFee ?? cfg.priorityFee ?? 0);

  return performTrade({
    side: 'buy',
    mint,
    amount,
    walletPubkey: keypair.publicKey.toBase58(),
    keypair,
    slippagePercent: slippage,
    priorityFee: priorityFeeArg,
    useJito,
    dryRun,
  });
}

/**
 * Execute a sell swap using the configured wallet and swap engine.
 *
 * @param {object} params
 * @param {string} params.walletAlias
 * @param {string} params.mint
 * @param {number|string} params.amount
 * @param {number} [params.slippagePercent]
 * @param {number|string} [params.priorityFee]
 * @param {boolean} [params.useJito]
 * @param {boolean} [params.dryRun]
 * @returns {Promise<import('./swapEngine').TradeResult>}
 */
async function sellToken({ walletAlias, mint, amount, slippagePercent, priorityFee, useJito, dryRun }) {
  const cfg = await loadConfig();
  const keypair = await getKeypairForWallet(walletAlias);

  const slippage = Number(slippagePercent ?? cfg.slippage ?? 15);
  const priorityFeeArg = priorityFee === 'auto'
    ? 'auto'
    : Number(priorityFee ?? cfg.priorityFee ?? 0);

  return performTrade({
    side: 'sell',
    mint,
    amount,
    walletPubkey: keypair.publicKey.toBase58(),
    keypair,
    slippagePercent: slippage,
    priorityFee: priorityFeeArg,
    useJito,
    dryRun,
  });
}

module.exports = {
  buyToken,
  sellToken,
};