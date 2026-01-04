'use strict';

let kit = null;
try {
  // eslint-disable-next-line global-require
  kit = require('@solana/kit');
} catch (_) {
  kit = null;
}

const SOLANA_ERROR_CODES = kit ? {
  preflightFailure: kit.SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  blockhashNotFound: kit.SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCKHASH_NOT_FOUND,
  transactionExpired: kit.SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_EXPIRED_BLOCKHEIGHT_EXCEEDED,
  sigMissing: kit.SOLANA_ERROR__TRANSACTION__SIGNATURES_MISSING,
  txSizeExceeded: kit.SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
  computeExceeded: kit.SOLANA_ERROR__INSTRUCTION_ERROR__COMPUTATIONAL_BUDGET_EXCEEDED,
} : {};

const RETRYABLE_RPC_METHODS = new Set([
  'getBalance',
  'getTokenAccountsByOwner',
  'getTokenAccountsByOwnerV2',
  'getBlockTime',
  'getLatestBlockhash',
  'getTransaction',
  'getSignatureStatuses',
  'getAccountInfo',
  'getProgramAccounts',
  'getBlock',
  'getSlot',
  'getBlockHeight',
  'getSlotLeaders',
  'getSignatureStatuses',
  'simulateTransaction',
]);

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
]);

function isSolanaError(err, code) {
  if (!kit || typeof kit.isSolanaError !== 'function') return false;
  return code ? kit.isSolanaError(err, code) : kit.isSolanaError(err);
}

function normalizeMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && typeof err.message === 'string') return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function extractLogsFromContext(err) {
  if (!err || typeof err !== 'object') return null;
  const context = err.context || err.data || null;
  if (context && Array.isArray(context.logs)) return context.logs;
  if (context && context.data && Array.isArray(context.data.logs)) return context.data.logs;
  return null;
}

function extractProgramErrorFromLogs(logs) {
  if (!Array.isArray(logs)) return null;
  let programId = null;
  let programError = null;
  let anchorError = null;
  for (const line of logs) {
    if (!programId) {
      const programMatch = String(line).match(/Program ([1-9A-HJ-NP-Za-km-z]{32,}) invoke/);
      if (programMatch) {
        programId = programMatch[1];
      }
    }
    if (!programError) {
      const customMatch = String(line).match(/custom program error: (0x[0-9a-f]+)/i);
      if (customMatch) {
        programError = customMatch[1];
      }
    }
    if (!anchorError) {
      const anchorMatch = String(line).match(/AnchorError occurred\. Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)/);
      if (anchorMatch) {
        anchorError = { name: anchorMatch[1], number: Number(anchorMatch[2]) };
      }
    }
  }
  if (!programId && !programError && !anchorError) return null;
  return { programId, programError, anchorError };
}

function extractInstructionError(err) {
  if (!err || typeof err !== 'object') return null;
  if (Array.isArray(err.InstructionError)) {
    const [idx, detail] = err.InstructionError;
    return { index: idx, detail };
  }
  if (Array.isArray(err)) {
    const [idx, detail] = err;
    if (typeof idx === 'number') return { index: idx, detail };
  }
  return null;
}

function classifyByMessage(message) {
  const lower = String(message || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('transaction simulation failed')) return 'simulation_failed';
  if (lower.includes('preflight')) return 'preflight_failed';
  if (lower.includes('blockhash not found')) return 'blockhash_not_found';
  if (lower.includes('blockheight exceeded') || lower.includes('transaction expired')) {
    return 'transaction_expired';
  }
  if (lower.includes('insufficient funds')) return 'insufficient_funds';
  if (lower.includes('signature verification failed')) return 'signature_failed';
  if (lower.includes('fetch failed')) return 'rpc_transport';
  if (lower.includes('websocket failed to connect')) return 'ws_connect';
  return null;
}

function shouldRetryRpcMethod(method) {
  return RETRYABLE_RPC_METHODS.has(String(method || ''));
}

function isTransientTransportError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.code || err.errno || err?.cause?.code || err?.cause?.errno;
  if (code && TRANSIENT_ERROR_CODES.has(String(code))) return true;
  const message = normalizeMessage(err);
  return /fetch failed|socket hang up|network error|timed out|timeout/i.test(message);
}

/**
 * Classify a Solana/RPC error into a reusable summary.
 *
 * @param {*} err
 * @param {Object} [options]
 * @param {string} [options.method] - RPC method name, when applicable.
 * @param {string[]} [options.logs] - Optional log messages for additional parsing.
 * @returns {{kind:string,message:string,userMessage:string,retryable:boolean,code?:string,solanaErrorCode?:string,programError?:object,logs?:string[]}}
 */
function classifySolanaError(err, options = {}) {
  const message = normalizeMessage(err);
  const logs = options.logs || extractLogsFromContext(err);
  const programError = extractProgramErrorFromLogs(logs);
  const instructionError = extractInstructionError(err);

  let kind = classifyByMessage(message) || 'unknown';
  let retryable = false;
  let solanaErrorCode = null;
  let code = err && typeof err === 'object' ? (err.code || err?.cause?.code || null) : null;

  if (isSolanaError(err)) {
    solanaErrorCode = err.code != null ? String(err.code) : null;
    if (SOLANA_ERROR_CODES.preflightFailure && isSolanaError(err, SOLANA_ERROR_CODES.preflightFailure)) {
      kind = 'preflight_failed';
    } else if (SOLANA_ERROR_CODES.blockhashNotFound && isSolanaError(err, SOLANA_ERROR_CODES.blockhashNotFound)) {
      kind = 'blockhash_not_found';
    } else if (SOLANA_ERROR_CODES.transactionExpired && isSolanaError(err, SOLANA_ERROR_CODES.transactionExpired)) {
      kind = 'transaction_expired';
    } else if (SOLANA_ERROR_CODES.sigMissing && isSolanaError(err, SOLANA_ERROR_CODES.sigMissing)) {
      kind = 'signature_missing';
    } else if (SOLANA_ERROR_CODES.txSizeExceeded && isSolanaError(err, SOLANA_ERROR_CODES.txSizeExceeded)) {
      kind = 'tx_size_exceeded';
    } else if (SOLANA_ERROR_CODES.computeExceeded && isSolanaError(err, SOLANA_ERROR_CODES.computeExceeded)) {
      kind = 'compute_exceeded';
    }

    if (err.cause && isSolanaError(err.cause)) {
      const causeMessage = normalizeMessage(err.cause);
      const causeKind = classifyByMessage(causeMessage);
      if (causeKind) kind = causeKind;
      if (!solanaErrorCode && err.cause.code != null) {
        solanaErrorCode = String(err.cause.code);
      }
    }
  }

  if (instructionError) {
    kind = 'instruction_error';
  }
  if (programError && (programError.programError || programError.anchorError)) {
    kind = 'program_error';
  }

  if (kind === 'rpc_transport' || kind === 'ws_connect' || isTransientTransportError(err)) {
    retryable = true;
    if (kind === 'unknown') kind = 'rpc_transport';
  }
  if (shouldRetryRpcMethod(options.method) && isTransientTransportError(err)) {
    retryable = true;
  }

  let userMessage = message || 'Unknown error';
  if (kind === 'simulation_failed') {
    userMessage = 'Transaction simulation failed (preflight). Check logs for the failing instruction.';
  } else if (kind === 'preflight_failed') {
    userMessage = 'Preflight failed. RPC rejected the transaction during simulation.';
  } else if (kind === 'blockhash_not_found') {
    userMessage = 'Blockhash not found. The transaction may be too old.';
  } else if (kind === 'transaction_expired') {
    userMessage = 'Transaction expired before confirmation. Consider re-sending with a new blockhash.';
  } else if (kind === 'signature_missing') {
    userMessage = 'Transaction signatures are missing. Check signing step.';
  } else if (kind === 'tx_size_exceeded') {
    userMessage = 'Transaction size exceeds RPC limits.';
  } else if (kind === 'compute_exceeded') {
    userMessage = 'Transaction exceeded the compute budget.';
  } else if (kind === 'rpc_transport') {
    userMessage = 'RPC transport error; network may be unstable.';
  } else if (kind === 'ws_connect') {
    userMessage = 'WebSocket connection failed; subscriptions may be unavailable.';
  } else if (kind === 'program_error') {
    const detail = programError?.anchorError
      ? `${programError.anchorError.name} (#${programError.anchorError.number})`
      : programError?.programError
        ? programError.programError
        : 'custom program error';
    userMessage = `Program error during transaction execution: ${detail}`;
  } else if (kind === 'instruction_error' && instructionError) {
    const detail = instructionError.detail ? JSON.stringify(instructionError.detail) : 'unknown error';
    userMessage = `Instruction ${instructionError.index} failed: ${detail}`;
  }

  return {
    kind,
    message,
    userMessage,
    retryable,
    code: code != null ? String(code) : null,
    solanaErrorCode,
    programError: programError || null,
    logs: logs || null,
  };
}

/**
 * Produce a short user-facing error message for logs/HUD.
 *
 * @param {*} err
 * @param {Object} [options]
 * @returns {string}
 */
function formatSolanaErrorMessage(err, options) {
  const summary = classifySolanaError(err, options);
  return summary.userMessage || summary.message || 'Unknown error';
}

/**
 * Decide if an RPC error should be retried (read-only methods only).
 *
 * @param {string} method
 * @param {*} err
 * @returns {boolean}
 */
function shouldRetryRpcError(method, err) {
  if (!shouldRetryRpcMethod(method)) return false;
  const summary = classifySolanaError(err, { method });
  return summary.retryable;
}

module.exports = {
  classifySolanaError,
  formatSolanaErrorMessage,
  shouldRetryRpcError,
  shouldRetryRpcMethod,
};
