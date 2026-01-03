'use strict';

const baseLogger = require('../logger');
const logger = (typeof baseLogger.swap === 'function' ? baseLogger.swap() : baseLogger).child({
  module: 'swapRaptor',
});

const {
  getBase64Encoder,
  getTransactionDecoder,
  isSolanaError,
} = require('@solana/kit');

const {
  signTransaction,
  getBase64EncodedWireTransaction,
  assertIsSendableTransaction,
} = require('@solana/transactions');

let raptorDebugLogger = null;

function resolveEndpoint(baseUrl, defaultPath) {
  const url = new URL(baseUrl);
  const normalized = (url.pathname || '').replace(/\/+$/, '');
  if (!normalized) {
    url.pathname = defaultPath;
    return url;
  }
  if (normalized.endsWith(defaultPath)) {
    url.pathname = normalized;
    return url;
  }
  if (/(\/quote|\/quote-and-swap)$/.test(normalized)) {
    url.pathname = normalized.replace(/\/(quote|quote-and-swap)$/, defaultPath);
    return url;
  }
  url.pathname = `${normalized}${defaultPath}`;
  return url;
}

function addApiKeyHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['x-api-headers'] = apiKey;
  }
  return headers;
}

function parseJsonResponse({ text, label, ms }) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const snippet = text ? text.slice(0, 500) : '';
    throw new Error(`${label}: invalid JSON response (${ms}ms) ${snippet}`);
  }
  return json;
}

function ensureFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a finite number`);
  }
  return n;
}

function decimalToBaseUnits(amount, decimals) {
  const raw = String(amount ?? '').trim();
  if (!raw) throw new Error('amount is required');
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`amount must be a non-negative decimal string (got ${raw})`);
  }

  const [whole, fraction = ''] = raw.split('.');
  const decimalsInt = ensureFiniteNumber(decimals, 'decimals');
  if (!Number.isInteger(decimalsInt) || decimalsInt < 0) {
    throw new Error(`decimals must be a non-negative integer (got ${decimals})`);
  }

  if (fraction.length > decimalsInt) {
    const tail = fraction.slice(decimalsInt);
    if (/[1-9]/.test(tail)) {
      throw new Error(`amount has more precision than supported (${decimalsInt} decimals)`);
    }
  }

  const paddedFraction = fraction.padEnd(decimalsInt, '0').slice(0, decimalsInt);
  const scale = 10n ** BigInt(decimalsInt);
  const wholeBig = BigInt(whole || '0');
  const fracBig = paddedFraction ? BigInt(paddedFraction) : 0n;
  return wholeBig * scale + fracBig;
}

function baseUnitsToDecimal(rawAmount, decimals) {
  if (rawAmount == null) return null;
  const decimalsInt = ensureFiniteNumber(decimals, 'decimals');
  if (!Number.isInteger(decimalsInt) || decimalsInt < 0) return null;
  const amountBig = BigInt(rawAmount);
  const scale = 10n ** BigInt(decimalsInt);
  const whole = amountBig / scale;
  const fraction = amountBig % scale;
  if (decimalsInt === 0) return Number(whole);
  const fractionStr = fraction.toString().padStart(decimalsInt, '0').replace(/0+$/, '');
  const combined = fractionStr ? `${whole.toString()}.${fractionStr}` : whole.toString();
  const asNumber = Number(combined);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function extractPriceImpactPercent(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const raw = quote.priceImpact ?? quote.priceImpactPct ?? quote.priceImpactPercent ?? null;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function normalizeU64JsonValue(amount, label) {
  if (typeof amount === 'bigint') {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds max safe integer; cannot send as JSON number`);
    }
    return Number(amount);
  }
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      throw new Error(`${label} must be a finite number`);
    }
    if (!Number.isInteger(amount)) {
      throw new Error(`${label} must be an integer`);
    }
    return amount;
  }
  if (typeof amount === 'string') {
    if (!/^\d+$/.test(amount)) {
      throw new Error(`${label} must be a base-10 integer string`);
    }
    const asBig = BigInt(amount);
    if (asBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds max safe integer; cannot send as JSON number`);
    }
    return Number(asBig);
  }
  throw new Error(`${label} must be a bigint, number, or integer string`);
}

function safeSerialize(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      return val;
    }));
  } catch (err) {
    return String(value);
  }
}

function extractSolanaErrorDetails(err) {
  if (!err) return null;
  const isSolErr = typeof isSolanaError === 'function' ? isSolanaError(err) : false;
  if (!isSolErr) return null;

  const details = {
    name: err.name,
    message: err.message,
  };

  if (err.code !== undefined) details.code = err.code;
  if (err.context !== undefined) details.context = safeSerialize(err.context);
  if (err.cause) {
    const cause = err.cause;
    details.cause = {
      name: cause?.name,
      message: cause?.message,
    };
    if (cause?.code !== undefined) details.cause.code = cause.code;
    if (cause?.context !== undefined) details.cause.context = safeSerialize(cause.context);
  }

  return details;
}

/**
 * Fetch a swap quote from Raptor.
 *
 * @param {Object} args
 * @param {string} args.baseUrl
 * @param {string} args.apiKey
 * @param {string} args.inputMint
 * @param {string} args.outputMint
 * @param {string|number|bigint} args.amount
 * @param {number} args.slippageBps
 * @returns {Promise<object>}
 */
async function getSwapQuote({ baseUrl, apiKey, inputMint, outputMint, amount, slippageBps }) {
  if (!baseUrl) throw new Error('swapRaptor.getSwapQuote: missing baseUrl');
  if (!apiKey) throw new Error('swapRaptor.getSwapQuote: missing apiKey');

  const url = resolveEndpoint(baseUrl, '/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));

  if (typeof raptorDebugLogger === 'function') {
    raptorDebugLogger('swap.raptor.quote.request', {
      url: url.toString(),
      inputMint,
      outputMint,
      amount: String(amount),
      slippageBps,
    });
  }

  const startedAt = Date.now();
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: addApiKeyHeaders(apiKey, { accept: 'application/json' }),
  });

  const ms = Date.now() - startedAt;
  const text = await res.text();

  if (!res.ok) {
    const snippet = text ? text.slice(0, 500) : '';
    const err = new Error(`swapRaptor.getSwapQuote: HTTP ${res.status} ${res.statusText} (${ms}ms) ${snippet}`);
    err.status = res.status;
    err.body = snippet;
    throw err;
  }

  const json = parseJsonResponse({ text, label: 'swapRaptor.getSwapQuote', ms });
  if (typeof raptorDebugLogger === 'function') {
    raptorDebugLogger('swap.raptor.quote.response', json);
  }
  return json;
}

/**
 * Request a quote + swap transaction build from Raptor.
 *
 * @param {Object} args
 * @param {string} args.baseUrl
 * @param {string} args.apiKey
 * @param {string} args.userPublicKey
 * @param {string} args.inputMint
 * @param {string} args.outputMint
 * @param {string|number|bigint} args.amount
 * @param {number} args.slippageBps
 * @param {string|null} [args.priorityFee]
 * @param {string|null} [args.txVersion]
 * @returns {Promise<object>}
 */
async function quoteAndSwap({
  baseUrl,
  apiKey,
  userPublicKey,
  inputMint,
  outputMint,
  amount,
  slippageBps,
  priorityFee,
  txVersion,
}) {
  if (!baseUrl) throw new Error('swapRaptor.quoteAndSwap: missing baseUrl');
  if (!apiKey) throw new Error('swapRaptor.quoteAndSwap: missing apiKey');

  const url = resolveEndpoint(baseUrl, '/quote-and-swap');
  const body = {
    userPublicKey,
    inputMint,
    outputMint,
    amount: normalizeU64JsonValue(amount, 'quoteAndSwap.amount'),
    slippageBps: String(slippageBps),
  };

  if (priorityFee != null) body.priorityFee = String(priorityFee);
  if (txVersion) body.txVersion = String(txVersion);

  if (typeof raptorDebugLogger === 'function') {
    raptorDebugLogger('swap.raptor.quoteAndSwap.request', {
      url: url.toString(),
      body,
    });
  }

  const startedAt = Date.now();
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: addApiKeyHeaders(apiKey, {
      accept: 'application/json',
      'content-type': 'application/json',
    }),
    body: JSON.stringify(body),
  });

  const ms = Date.now() - startedAt;
  const text = await res.text();

  if (!res.ok) {
    const snippet = text ? text.slice(0, 500) : '';
    const err = new Error(`swapRaptor.quoteAndSwap: HTTP ${res.status} ${res.statusText} (${ms}ms) ${snippet}`);
    err.status = res.status;
    err.body = snippet;
    throw err;
  }

  const json = parseJsonResponse({ text, label: 'swapRaptor.quoteAndSwap', ms });
  if (typeof raptorDebugLogger === 'function') {
    const summary = {
      hasSwapTransaction: Boolean(json && json.swapTransaction),
      swapTransactionLength: json && typeof json.swapTransaction === 'string' ? json.swapTransaction.length : null,
      lastValidBlockHeight: json?.lastValidBlockHeight ?? null,
      quote: json?.quote ?? null,
    };
    raptorDebugLogger('swap.raptor.quoteAndSwap.response', summary);
  }
  return json;
}

function estimateDeltasFromQuote({ side, quote, inputDecimals, outputDecimals }) {
  if (!quote || typeof quote !== 'object') {
    return { tokensReceivedDecimal: null, solReceivedDecimal: null };
  }

  let amountIn = null;
  let amountOut = null;
  if (Number.isFinite(Number(inputDecimals))) {
    amountIn = baseUnitsToDecimal(quote.amountIn, inputDecimals);
  }
  if (Number.isFinite(Number(outputDecimals))) {
    amountOut = baseUnitsToDecimal(quote.amountOut, outputDecimals);
  }

  let tokensReceivedDecimal = null;
  let solReceivedDecimal = null;

  if (side === 'buy') {
    tokensReceivedDecimal = amountOut;
    solReceivedDecimal = amountIn != null ? -amountIn : null;
  } else {
    tokensReceivedDecimal = amountIn != null ? -amountIn : null;
    solReceivedDecimal = amountOut;
  }

  return { tokensReceivedDecimal, solReceivedDecimal };
}

async function resolveRpcResult(maybeBuilder) {
  if (maybeBuilder && typeof maybeBuilder.send === 'function') {
    return maybeBuilder.send();
  }
  return maybeBuilder;
}

function normalizeTxid(txid) {
  if (!txid) return null;
  if (typeof txid === 'string') return txid;
  if (typeof txid === 'object') {
    if (typeof txid.signature === 'string') return txid.signature;
    if (typeof txid.result === 'string') return txid.result;
    if (typeof txid.value === 'string') return txid.value;
    if (typeof txid.txid === 'string') return txid.txid;
  }
  return String(txid);
}

/**
 * Execute a swap via Raptor (quote-only for dry-run, quote+swap for live).
 *
 * @param {Object} args
 * @param {'buy'|'sell'} args.side
 * @param {string} args.fromMint
 * @param {string} args.toMint
 * @param {string|number} args.fromAmount
 * @param {number} args.inputDecimals
 * @param {number} args.outputDecimals
 * @param {string} args.payerAddress
 * @param {import('@solana/rpc').SolanaRpcApi} args.rpc
 * @param {CryptoKeyPair[]|undefined} args.keyPairs
 * @param {string} args.swapApiBaseUrl
 * @param {string} args.swapApiKey
 * @param {number} args.slippagePercent
 * @param {string|null} [args.priorityFee]
 * @param {string|null} [args.txVersion]
 * @param {boolean} [args.preflight]
 * @param {number|null} [args.maxPriceImpactPercent]
 * @param {boolean} [args.inkMode]
 * @param {boolean} [args.debugLogging]
 * @param {boolean} [args.dryRun]
 * @param {(event: string, data?: object) => void} [args.onProgress]
 * @returns {Promise<{ txid: string|null, dryRun?: boolean, swapType?: string, quote?: any, rate?: any, priceImpactPercent?: number|null, totalFeesSol?: number|null, tokensReceivedDecimal?: number|null, solReceivedDecimal?: number|null, raw?: any }>}
 */
async function executeSwapRaptor({
  side,
  fromMint,
  toMint,
  fromAmount,
  inputDecimals,
  outputDecimals,
  payerAddress,
  rpc,
  keyPairs,
  swapApiBaseUrl,
  swapApiKey,
  slippagePercent,
  priorityFee = null,
  txVersion = null,
  preflight = false,
  maxPriceImpactPercent = null,
  inkMode = false,
  debugLogging = false,
  dryRun = false,
  onProgress,
}) {
  if (!side || (side !== 'buy' && side !== 'sell')) throw new Error(`swapRaptor: invalid side ${side}`);
  if (!fromMint) throw new Error('swapRaptor: missing fromMint');
  if (!toMint) throw new Error('swapRaptor: missing toMint');
  if (!payerAddress) throw new Error('swapRaptor: missing payerAddress');
  if (!rpc) throw new Error('swapRaptor: missing rpc');
  if (!swapApiBaseUrl) throw new Error('swapRaptor: missing swapApiBaseUrl');
  if (!swapApiKey) throw new Error('swapRaptor: missing swapApiKey');

  raptorDebugLogger = debugLogging ? (event, data) => logger.info(event, data) : null;
  if (debugLogging) {
    logger.info('swap.raptor.debug.enabled', { baseUrl: swapApiBaseUrl, txVersion });
  }

  const amountNum = Number(fromAmount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error(`swapRaptor: invalid fromAmount ${fromAmount}`);
  }

  const startedAt = Date.now();
  logger.info('swap.raptor.start', {
    side,
    fromMint,
    toMint,
    fromAmount: String(fromAmount),
    slippagePercent,
    txVersion,
  });
  if (typeof onProgress === 'function') {
    onProgress('swap.build.start', {
      side,
      fromMint,
      toMint,
      fromAmount: String(fromAmount),
      slippagePercent,
      txVersion,
    });
  }

  const slippageBps = Math.round(ensureFiniteNumber(slippagePercent, 'slippagePercent') * 100);
  const amountBaseUnits = decimalToBaseUnits(fromAmount, inputDecimals);

  if (dryRun) {
    const quote = await getSwapQuote({
      baseUrl: swapApiBaseUrl,
      apiKey: swapApiKey,
      inputMint: fromMint,
      outputMint: toMint,
      amount: amountBaseUnits,
      slippageBps,
    });
    if (typeof onProgress === 'function') {
      onProgress('swap.build.done', {
        side,
        fromMint,
        toMint,
        fromAmount: String(fromAmount),
        slippagePercent,
        txVersion,
      });
    }

    const priceImpactPercent = extractPriceImpactPercent(quote);
    if (priceImpactPercent != null && priceImpactPercent > 2) {
      (inkMode ? logger.debug : logger.warn)('swap.raptor.priceImpact.high', {
        side,
        fromMint,
        toMint,
        fromAmount: String(fromAmount),
        priceImpactPercent,
        thresholdPercent: 2,
      });
    }

    if (maxPriceImpactPercent != null && priceImpactPercent != null && priceImpactPercent > maxPriceImpactPercent) {
      const e = new Error(`swapRaptor: price impact ${priceImpactPercent}% exceeds max ${maxPriceImpactPercent}%`);
      e.priceImpactPercent = priceImpactPercent;
      e.maxPriceImpactPercent = maxPriceImpactPercent;
      throw e;
    }

    const { tokensReceivedDecimal, solReceivedDecimal } = estimateDeltasFromQuote({
      side,
      quote,
      inputDecimals,
      outputDecimals,
    });

    if (typeof onProgress === 'function') {
      onProgress('swap.dryRun', {
        side,
        fromMint,
        toMint,
        fromAmount: String(fromAmount),
        slippagePercent,
        txVersion,
      });
    }

    return {
      txid: null,
      dryRun: true,
      swapType: 'raptor',
      quote,
      rate: null,
      priceImpactPercent,
      totalFeesSol: null,
      tokensReceivedDecimal,
      solReceivedDecimal,
      raw: quote,
    };
  }

  const payload = await quoteAndSwap({
    baseUrl: swapApiBaseUrl,
    apiKey: swapApiKey,
    userPublicKey: payerAddress,
    inputMint: fromMint,
    outputMint: toMint,
    amount: amountBaseUnits,
    slippageBps,
    priorityFee: priorityFee != null ? priorityFee : null,
    txVersion,
  });
  if (typeof onProgress === 'function') {
    onProgress('swap.build.done', {
      side,
      fromMint,
      toMint,
      fromAmount: String(fromAmount),
      slippagePercent,
      txVersion,
    });
  }

  if (!payload || typeof payload.swapTransaction !== 'string') {
    throw new Error('swapRaptor: missing swapTransaction in response');
  }

  const quote = payload.quote || null;
  const priceImpactPercent = extractPriceImpactPercent(quote);
  if (priceImpactPercent != null && priceImpactPercent > 2) {
    (inkMode ? logger.debug : logger.warn)('swap.raptor.priceImpact.high', {
      side,
      fromMint,
      toMint,
      fromAmount: String(fromAmount),
      priceImpactPercent,
      thresholdPercent: 2,
    });
  }

  if (maxPriceImpactPercent != null && priceImpactPercent != null && priceImpactPercent > maxPriceImpactPercent) {
    const e = new Error(`swapRaptor: price impact ${priceImpactPercent}% exceeds max ${maxPriceImpactPercent}%`);
    e.priceImpactPercent = priceImpactPercent;
    e.maxPriceImpactPercent = maxPriceImpactPercent;
    throw e;
  }

  if (!Array.isArray(keyPairs) || keyPairs.length === 0) {
    throw new Error('swapRaptor: missing keyPairs (CryptoKeyPair[]) for signing');
  }

  const txnBytes = getBase64Encoder().encode(payload.swapTransaction);
  const transaction = getTransactionDecoder().decode(txnBytes);
  const signed = await signTransaction(keyPairs, transaction);
  assertIsSendableTransaction(signed);
  const signedWireB64 = getBase64EncodedWireTransaction(signed);

  if (preflight) {
    logger.warn('swap.raptor.preflight.unsupported', {
      reason: 'Raptor docs do not advertise simulation support; skipping preflight.',
    });
    if (typeof onProgress === 'function') {
      onProgress('swap.preflight.unavailable', {
        reason: 'raptor preflight unsupported',
      });
    }
  }

  logger.info('swap.raptor.send.start', {
    side,
    fromMint,
    toMint,
    fromAmount: String(fromAmount),
    slippagePercent,
    txVersion,
  });
  if (typeof onProgress === 'function') {
    onProgress('swap.send.start', {
      side,
      fromMint,
      toMint,
      fromAmount: String(fromAmount),
      slippagePercent,
      txVersion,
    });
  }
  let txidRaw;
  try {
    txidRaw = await resolveRpcResult(rpc.sendTransaction(signedWireB64, { encoding: 'base64' }));
  } catch (err) {
    const details = extractSolanaErrorDetails(err);
    if (details) {
      err.solanaDetails = details;
    }
    throw err;
  }
  const txid = normalizeTxid(txidRaw);

  logger.info('swap.raptor.send.done', {
    txid,
    ms: Date.now() - startedAt,
  });
  if (typeof onProgress === 'function') {
    onProgress('swap.send.done', {
      txid,
      ms: Date.now() - startedAt,
    });
  }

  const { tokensReceivedDecimal, solReceivedDecimal } = estimateDeltasFromQuote({
    side,
    quote,
    inputDecimals,
    outputDecimals,
  });

  return {
    txid,
    swapType: 'raptor',
    quote,
    rate: null,
    priceImpactPercent,
    totalFeesSol: null,
    tokensReceivedDecimal,
    solReceivedDecimal,
    raw: payload,
  };
}

module.exports = {
  executeSwapRaptor,
  _decimalToBaseUnits: decimalToBaseUnits,
  _baseUnitsToDecimal: baseUnitsToDecimal,
  _getSwapQuote: getSwapQuote,
  _quoteAndSwap: quoteAndSwap,
};
