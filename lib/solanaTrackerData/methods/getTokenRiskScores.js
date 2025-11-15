'use strict';

function normalizeRiskFactors(source) {
  if (!source) return [];

  if (Array.isArray(source)) {
    return source.map((factor) => ({
      name: factor?.name || factor?.label || factor?.type || 'unknown',
      score: typeof factor?.score === 'number' ? factor.score
        : typeof factor?.value === 'number' ? factor.value
          : typeof factor === 'number' ? factor
            : null,
      severity: factor?.severity || factor?.level || factor?.status || null,
      raw: factor,
    }));
  }

  if (typeof source === 'object') {
    return Object.entries(source).map(([key, value]) => ({
      name: value?.name || value?.label || key,
      score: typeof value?.score === 'number' ? value.score
        : typeof value?.value === 'number' ? value.value
          : typeof value === 'number' ? value
            : null,
      severity: value?.severity || value?.level || value?.status || null,
      raw: value,
    }));
  }

  return [];
}

function normalizeRiskPayload(tokenAddress, payload) {
  if (!payload || typeof payload !== 'object') {
    return { token: tokenAddress, score: null, rating: null, factors: [], raw: payload };
  }

  const score = typeof payload.totalScore === 'number'
    ? payload.totalScore
    : typeof payload.score === 'number'
      ? payload.score
      : typeof payload.overallScore === 'number'
        ? payload.overallScore
        : null;

  const rating = payload.rating || payload.grade || payload.level || null;
  const factors = normalizeRiskFactors(payload.factors || payload.riskFactors || payload.scores);

  return {
    token: tokenAddress,
    score,
    rating,
    factors,
    raw: payload,
  };
}

/**
 * Bind helper for token risk analysis endpoint.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client & { request: Function }, call: Function }} deps
 * @returns {(tokenAddress: string) => Promise<{ token: string, score: (number|null), rating: (string|null), factors: Array<{ name: string, score: (number|null), severity: (string|null), raw: any }>, raw: any }>}
 */
function createGetTokenRiskScores({ client, call }) {
  if (!client || typeof client.request !== 'function' || !call) {
    throw new Error('createGetTokenRiskScores: missing request-capable client');
  }

  return async function getTokenRiskScores(tokenAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getTokenRiskScores: tokenAddress is required');
    }

    const mint = tokenAddress.trim();
    const payload = await call('getTokenRiskScores', () => client.request(`/risk/${mint}`));
    return normalizeRiskPayload(mint, payload);
  };
}

module.exports = { createGetTokenRiskScores, normalizeRiskPayload };
