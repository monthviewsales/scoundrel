'use strict';

const { assertValidMintAddress } = require('../solana/addressValidation');

/**
 * @typedef {Object} SwapWorkerPayload
 * @property {'buy'|'sell'} side
 * @property {string} mint
 * @property {number|string} amount
 * @property {string} [walletAlias]
 * @property {number|string} [walletId]
 * @property {string} [walletPubkey]
 * @property {string} [walletPrivateKey]
 * @property {boolean} [dryRun]
 * @property {boolean} [detachMonitor]
 * @property {boolean} [panic]
 */

function normalizeAmount(side, raw) {
  if (raw === undefined || raw === null) {
    throw new Error(`Missing amount for ${side} side`);
  }

  const trimmed = raw.toString().trim().toLowerCase().replace(/\s+/g, '');
  if (!trimmed) {
    throw new Error('Amount cannot be empty');
  }

  if (trimmed === 'auto') {
    if (side === 'buy') {
      throw new Error("'auto' is only valid for sells (swap entire balance)");
    }
    return 'auto';
  }

  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed.slice(0, -1));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error('Percentage amount must be between 0 and 100');
    }
    return `${pct}%`;
  }

  const num = parseFloat(trimmed);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Amount must be a positive number');
  }

  return num;
}

function normalizeMint(mint) {
  return assertValidMintAddress(mint);
}

/**
 * Validate and normalize a swap payload.
 *
 * @param {SwapWorkerPayload} payload
 * @returns {Required<SwapWorkerPayload>}
 */
function validateSwapPayload(payload) {
  const side = payload && payload.side;
  if (side !== 'buy' && side !== 'sell') {
    throw new Error("Payload.side must be 'buy' or 'sell'");
  }

  const mint = normalizeMint(payload.mint);
  const amount = normalizeAmount(side, payload.amount);
  const dryRun = Boolean(payload.dryRun);
  const detachMonitor = Boolean(payload.detachMonitor);
  const panic = Boolean(payload.panic);

  const walletAlias = payload.walletAlias ? String(payload.walletAlias).trim() : undefined;
  const walletId =
    payload.walletId !== undefined && payload.walletId !== null
      ? payload.walletId
      : undefined;
  const walletPubkey = payload.walletPubkey ? String(payload.walletPubkey).trim() : undefined;
  const walletPrivateKey = payload.walletPrivateKey ? String(payload.walletPrivateKey).trim() : undefined;

  if (!walletAlias && !walletPrivateKey) {
    throw new Error('Payload must include walletAlias or walletPrivateKey');
  }

  return {
    side,
    mint,
    amount,
    walletAlias,
    walletId,
    walletPubkey,
    walletPrivateKey,
    dryRun,
    detachMonitor,
    panic,
  };
}

module.exports = {
  validateSwapPayload,
};
