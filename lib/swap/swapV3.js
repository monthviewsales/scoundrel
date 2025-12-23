'use strict';

// swapV3
// Minimal build → sign → (optional preflight) → send pipeline.
// - No solana-swap
// - No web3.js
// - Decimal amounts only (human units)
// - Returns txid so existing txMonitor workflow can take over

const logger = require('../logger').child({ scope: 'swapV3' });

const {
  getBase64Encoder,
  getTransactionDecoder,
} = require('@solana/kit');

const {
  signTransaction,
  getBase64EncodedWireTransaction,
  assertIsSendableTransaction,
} = require('@solana/transactions');

/**
 * @typedef {Object} SwapV3BuildResponse
 * @property {string} txn - Base64 encoded wire transaction returned by the swap builder.
 * @property {string} [type] - e.g. 'v0' or 'legacy'
 * @property {number|string} [rate] - quote rate/price info (passthrough)
 */

/**
 * Build a swap transaction using SolanaTracker Swap API.
 *
 * This function intentionally does not know about CLI or DB.
 * It assumes `fromAmount` is a decimal string/number (human units).
 *
 * @param {Object} args
 * @param {string} args.baseUrl
 * @param {string} args.apiKey
 * @param {string} args.from
 * @param {string} args.to
 * @param {string|number} args.fromAmount
 * @param {string} args.payer
 * @param {number} args.slippagePercent
 * @param {string|null} [args.priorityFeeLevel]
 * @param {string|null} [args.txVersion]
 * @returns {Promise<SwapV3BuildResponse>}
 */
async function buildSwapTx({
  baseUrl,
  apiKey,
  from,
  to,
  fromAmount,
  payer,
  slippagePercent,
  priorityFeeLevel,
  txVersion,
}) {
  if (!baseUrl) throw new Error('swapV3.buildSwapTx: missing baseUrl');
  if (!apiKey) throw new Error('swapV3.buildSwapTx: missing apiKey');

  // Note: We keep this flexible because SolanaTracker may evolve params.
  // We only send the essentials + optional knobs you already support.
  const url = new URL(baseUrl);
  // If caller passes the origin only, assume /swap.
  if (!url.pathname || url.pathname === '/') url.pathname = '/swap';

  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('fromAmount', String(fromAmount));
  url.searchParams.set('slippage', String(slippagePercent));
  url.searchParams.set('payer', payer);

  if (priorityFeeLevel) url.searchParams.set('priorityFeeLevel', String(priorityFeeLevel));
  if (txVersion) url.searchParams.set('txVersion', String(txVersion));

  const startedAt = Date.now();
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
    },
  });

  const ms = Date.now() - startedAt;
  const text = await res.text();

  if (!res.ok) {
    // Include the first ~500 chars only to keep logs sane.
    const snippet = text ? text.slice(0, 500) : '';
    const err = new Error(`swapV3.buildSwapTx: HTTP ${res.status} ${res.statusText} (${ms}ms) ${snippet}`);
    err.status = res.status;
    err.body = snippet;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const snippet = text ? text.slice(0, 500) : '';
    throw new Error(`swapV3.buildSwapTx: invalid JSON response (${ms}ms) ${snippet}`);
  }

  if (!json || typeof json.txn !== 'string' || !json.txn.length) {
    throw new Error('swapV3.buildSwapTx: missing `txn` in response');
  }

  return json;
}

function extractPriceImpactPercent(rate) {
  if (!rate || typeof rate !== 'object') return null;

  // Common field names seen across swap builders.
  const raw =
    rate.priceImpactPercent ??
    rate.priceImpactPercentage ??
    rate.priceImpact ??
    rate.priceImpactPct ??
    null;

  if (raw == null) return null;

  const n = Number(raw);
  if (!Number.isFinite(n)) return null;

  // Heuristic: some APIs return 0.0123 for 1.23%; others return 1.23.
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

/**
 * Execute a swap using SolanaTracker Swap API + Solana Kit signing + SolanaTracker RPC send.
 *
 * IMPORTANT:
 * - `fromAmount` is a DECIMAL human-unit amount.
 * - This function returns txid only; confirmation is handled elsewhere.
 *
 * @param {Object} args
 * @param {'buy'|'sell'} args.side
 * @param {string} args.fromMint
 * @param {string} args.toMint
 * @param {string|number} args.fromAmount
 * @param {string} args.payerAddress
 * @param {import('@solana/rpc').SolanaRpcApi} args.rpc
 * @param {CryptoKeyPair[]|undefined} args.keyPairs
 * @param {string} args.swapApiBaseUrl
 * @param {string} args.swapApiKey
 * @param {number} args.slippagePercent
 * @param {string|null} [args.priorityFeeLevel]
 * @param {string|null} [args.txVersion]
 * @param {boolean} [args.preflight]
 * @returns {Promise<{ txid: string, swapType?: string, rate?: any, priceImpactPercent?: number|null, raw?: any }>} 
 */
async function executeSwapV3({
  side,
  fromMint,
  toMint,
  fromAmount,
  payerAddress,
  rpc,
  keyPairs,
  swapApiBaseUrl,
  swapApiKey,
  slippagePercent,
  priorityFeeLevel = null,
  txVersion = null,
  preflight = false,
}) {
  if (!side || (side !== 'buy' && side !== 'sell')) throw new Error(`swapV3: invalid side ${side}`);
  if (!fromMint) throw new Error('swapV3: missing fromMint');
  if (!toMint) throw new Error('swapV3: missing toMint');
  if (!payerAddress) throw new Error('swapV3: missing payerAddress');
  if (!rpc) throw new Error('swapV3: missing rpc');
  if (!swapApiBaseUrl) throw new Error('swapV3: missing swapApiBaseUrl');
  if (!swapApiKey) throw new Error('swapV3: missing swapApiKey');

  const amountNum = Number(fromAmount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error(`swapV3: invalid fromAmount ${fromAmount}`);
  }

  const startedAt = Date.now();
  logger.info('swap.build.start', {
    side,
    fromMint,
    toMint,
    fromAmount: String(fromAmount),
    slippagePercent,
    priorityFeeLevel,
    txVersion,
  });

  /** @type {SwapV3BuildResponse} */
  const buildResp = await buildSwapTx({
    baseUrl: swapApiBaseUrl,
    apiKey: swapApiKey,
    from: fromMint,
    to: toMint,
    fromAmount,
    payer: payerAddress,
    slippagePercent,
    priorityFeeLevel,
    txVersion,
  });

  logger.debug('swap.build.done', {
    ms: Date.now() - startedAt,
    type: buildResp.type || null,
  });

  const priceImpactPercent = extractPriceImpactPercent(buildResp.rate);
  if (priceImpactPercent != null && priceImpactPercent > 2) {
    logger.warn('swap.priceImpact.high', {
      side,
      fromMint,
      toMint,
      fromAmount: String(fromAmount),
      priceImpactPercent,
      thresholdPercent: 2,
    });
  }

  // Decode base64 wire transaction → Transaction object
  const txnB64 = buildResp.txn;
  const txnBytes = getBase64Encoder().encode(txnB64);
  const transaction = getTransactionDecoder().decode(txnBytes);

  // Sign
  if (!Array.isArray(keyPairs) || keyPairs.length === 0) {
    throw new Error('swapV3: missing keyPairs (CryptoKeyPair[]) for signing');
  }

  const signed = await signTransaction(keyPairs, transaction);
  assertIsSendableTransaction(signed);

  // Re-encode to base64 wire transaction for RPC send
  const signedWireB64 = getBase64EncodedWireTransaction(signed);

  // Optional preflight/sim
  if (preflight) {
    if (typeof rpc.simulateTransaction === 'function') {
      logger.debug('swap.preflight.start');
      const simResp = await rpc
        .simulateTransaction(signedWireB64, { encoding: 'base64' })
        .send();

      const err = simResp && simResp.value && simResp.value.err;
      if (err) {
        const e = new Error('swapV3: preflight simulation failed');
        e.simulationError = err;
        e.simulationLogs = simResp.value.logs || null;
        throw e;
      }
      logger.debug('swap.preflight.ok');
    } else {
      logger.warn('swap.preflight.unavailable', { reason: 'rpc.simulateTransaction not present' });
    }
  }

  // Send
  logger.info('swap.send.start');
  const txid = await rpc
    .sendTransaction(signedWireB64, { encoding: 'base64' })
    .send();

  logger.info('swap.send.done', {
    txid,
    ms: Date.now() - startedAt,
    swapType: buildResp.type || null,
  });

  return {
    txid,
    swapType: buildResp.type,
    rate: buildResp.rate,
    priceImpactPercent,
    raw: buildResp,
  };
}

module.exports = {
  executeSwapV3,
  // exported for unit tests / isolated debugging
  _buildSwapTx: buildSwapTx,
};
