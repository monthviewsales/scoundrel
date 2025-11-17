'use strict';

const { ensureRpcMethod, resolveRpcResult } = require('./internal/rpcHelpers');
const { normalizeTokenAccount } = require('./internal/tokenAccountNormalizer');

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function coerceBoolean(value) {
  return Boolean(value);
}

function coerceTotalCount(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pickNextCursor(response) {
  return response?.nextCursor
    ?? response?.cursor?.next
    ?? response?.pagination?.nextCursor
    ?? response?.pagination?.next
    ?? response?.value?.nextCursor
    ?? null;
}

function pickHasMore(response) {
  const candidate = response?.hasMore
    ?? response?.cursor?.hasMore
    ?? response?.pagination?.hasMore
    ?? response?.value?.hasMore;
  return coerceBoolean(candidate);
}

function pickAccounts(response) {
  if (Array.isArray(response?.accounts)) return response.accounts;
  if (Array.isArray(response?.value?.accounts)) return response.value.accounts;
  if (Array.isArray(response?.value)) return response.value;
  if (Array.isArray(response)) return response;
  return [];
}

/**
 * Factory: SolanaTracker getTokenAccountsByOwnerV2 helper with pagination metadata.
 *
 * @param {*} rpc - HTTP RPC client from createSolanaTrackerRPCClient().
 * @returns {(owner: string, opts?: Object) => Promise<{owner: string, accounts: Array, hasMore: boolean, nextCursor: string|null, totalCount: number}>}
 */
function createGetTokenAccountsByOwnerV2(rpc) {
  return async function getTokenAccountsByOwnerV2(owner, opts = {}) {
    ensureRpcMethod(rpc, 'getTokenAccountsByOwnerV2', 'getTokenAccountsByOwnerV2');
    if (typeof owner !== 'string' || owner.trim() === '') {
      throw new Error('getTokenAccountsByOwnerV2: owner must be a non-empty string');
    }

    try {
      const mergedOpts = { ...opts };

      // Split mergedOpts into filter and config objects, matching the
      // getTokenAccountsByOwnerV2 RPC signature:
      // params: [ owner, filterObject, configObject ]
      const filter = {};
      const config = {};

      // Filter fields: mint / programId
      if (mergedOpts.mint) {
        filter.mint = mergedOpts.mint;
      }
      if (mergedOpts.programId) {
        filter.programId = mergedOpts.programId;
      }

      // If caller did not specify a mint or programId, default to the token program.
      if (!filter.mint && !filter.programId) {
        filter.programId = TOKEN_PROGRAM_ID;
      }

      // Config fields: anything that controls response formatting or pagination.
      // We explicitly map the common ones and pass through any remaining fields.
      if (mergedOpts.encoding) {
        config.encoding = mergedOpts.encoding;
      }
      if (mergedOpts.limit != null) {
        config.limit = mergedOpts.limit;
      }
      if (mergedOpts.excludeZero != null) {
        config.excludeZero = mergedOpts.excludeZero;
      }
      if (mergedOpts.paginationKey != null) {
        config.paginationKey = mergedOpts.paginationKey;
      }
      if (mergedOpts.changedSinceSlot != null) {
        config.changedSinceSlot = mergedOpts.changedSinceSlot;
      }
      if (mergedOpts.commitment) {
        config.commitment = mergedOpts.commitment;
      }
      if (mergedOpts.minContextSlot != null) {
        config.minContextSlot = mergedOpts.minContextSlot;
      }

      // Default: request parsed token accounts, not raw base64.
      if (!config.encoding) {
        config.encoding = 'jsonParsed';
      }

      const response = await resolveRpcResult(
        rpc.getTokenAccountsByOwnerV2(owner, filter, config)
      );

      const rawAccounts = pickAccounts(response);
      const accounts = rawAccounts
        .map((entry) => normalizeTokenAccount(owner, entry))
        .filter(Boolean);

      const totalCount = coerceTotalCount(
        response?.totalCount
          ?? response?.cursor?.totalCount
          ?? response?.pagination?.totalCount
          ?? response?.value?.totalCount,
        accounts.length
      );

      return {
        owner,
        accounts,
        hasMore: pickHasMore(response),
        nextCursor: pickNextCursor(response),
        totalCount,
        raw: response,
      };
    } catch (error) {
      throw new Error(`getTokenAccountsByOwnerV2: failed to fetch accounts: ${error?.message || error}`);
    }
  };
}

module.exports = { createGetTokenAccountsByOwnerV2 };
