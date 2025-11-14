'use strict';

/**
 * Resolve SolanaTracker RPC request builders to their JSON-RPC payloads.
 *
 * @param {*} result - RPC request builder or immediate response.
 * @returns {Promise<*>} Resolved RPC response payload.
 */
async function resolveRpcResult(result) {
  const awaited = await result;
  if (awaited && typeof awaited.send === 'function') {
    return awaited.send();
  }
  return awaited;
}

/**
 * Ensure the provided RPC client exposes the expected method.
 *
 * @param {*} rpc - RPC client instance.
 * @param {string} rpcMethod - Method name on the RPC client.
 * @param {string} helperName - Public helper name for error context.
 */
function ensureRpcMethod(rpc, rpcMethod, helperName) {
  if (!rpc || typeof rpc[rpcMethod] !== 'function') {
    throw new Error(`${helperName}: rpc client does not provide ${rpcMethod}`);
  }
}

module.exports = {
  ensureRpcMethod,
  resolveRpcResult,
};
