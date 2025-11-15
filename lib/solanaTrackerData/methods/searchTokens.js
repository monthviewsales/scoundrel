'use strict';

function serializeSearchParams(input) {
  const output = {};
  if (!input || typeof input !== 'object') return output;
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      output[key] = value.join(',');
    } else if (typeof value === 'object') {
      output[key] = JSON.stringify(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Bind helper for the flexible search endpoint.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(params: Record<string, any>) => Promise<any>}
 */
function createSearchTokens({ client, call }) {
  if (!client || !call) throw new Error('createSearchTokens: missing dependencies');

  return async function searchTokens(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('searchTokens: params object is required');
    }
    const serialized = serializeSearchParams(params);
    if (!Object.keys(serialized).length) {
      throw new Error('searchTokens: provide at least one filter');
    }
    return call('searchTokens', () => client.searchTokens(serialized));
  };
}

module.exports = { createSearchTokens, serializeSearchParams };
