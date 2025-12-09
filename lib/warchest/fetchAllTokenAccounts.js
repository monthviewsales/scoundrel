'use strict';

const logger = require('../logger');

const DEFAULT_PAGE_LIMIT = 10;

/**
 * Fetch all token accounts for an owner using cursor pagination.
 *
 * The SolanaTracker `getTokenAccountsByOwnerV2` RPC method returns a single
 * page of accounts plus pagination metadata. This helper walks the cursor
 * until exhaustion (or a safe page limit) and de-duplicates by account
 * pubkey to guard against overlapping pages.
 *
 * @param {object} rpcMethods - RPC methods instance with getTokenAccountsByOwnerV2.
 * @param {string} owner - Wallet public key to query.
 * @param {object} [opts]
 * @param {string} [opts.programId] - Token program to filter by.
 * @param {number} [opts.limit=500] - Page size to request from the RPC.
 * @param {boolean} [opts.excludeZero=true] - Whether to omit zero-balance accounts.
 * @param {number} [opts.pageLimit=DEFAULT_PAGE_LIMIT] - Safety cap on pagination loops.
 * @returns {Promise<{accounts: Array, pageCount: number, totalCount: number, truncated: boolean}>}
 */
async function fetchAllTokenAccounts(rpcMethods, owner, opts = {}) {
  if (!rpcMethods || typeof rpcMethods.getTokenAccountsByOwnerV2 !== 'function') {
    throw new Error('fetchAllTokenAccounts: rpcMethods.getTokenAccountsByOwnerV2 is required');
  }

  if (!owner) {
    throw new Error('fetchAllTokenAccounts: owner is required');
  }

  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 500;
  const excludeZero = opts.excludeZero !== false;
  const pageLimit = Number.isFinite(Number(opts.pageLimit)) ? Number(opts.pageLimit) : DEFAULT_PAGE_LIMIT;

  const accounts = [];
  const seenPubkeys = new Set();

  let pageCount = 0;
  let nextCursor = opts.paginationKey || null;
  let truncated = false;
  let lastTotalCount = null;

  while (pageCount < pageLimit) {
    const response = await rpcMethods.getTokenAccountsByOwnerV2(owner, {
      programId: opts.programId,
      limit,
      excludeZero,
      paginationKey: nextCursor,
    });

    const pageAccounts = Array.isArray(response?.accounts) ? response.accounts : [];
    for (const account of pageAccounts) {
      const pubkey = account && account.pubkey;
      if (pubkey && !seenPubkeys.has(pubkey)) {
        seenPubkeys.add(pubkey);
        accounts.push(account);
      }
    }

    lastTotalCount = response && typeof response.totalCount === 'number'
      ? response.totalCount
      : lastTotalCount;

    pageCount += 1;

    const hasMore = !!(response && response.hasMore);
    nextCursor = response ? response.nextCursor || null : null;

    if (!hasMore || !nextCursor) {
      truncated = hasMore && !nextCursor;
      break;
    }
  }

  if (pageCount >= pageLimit && nextCursor) {
    truncated = true;
    logger.warn(
      `[HUD] Token account pagination for ${owner} hit page limit (${pageLimit}); results may be incomplete.`,
    );
  }

  return {
    accounts,
    pageCount,
    totalCount: lastTotalCount != null ? lastTotalCount : accounts.length,
    truncated,
  };
}

module.exports = {
  fetchAllTokenAccounts,
};
