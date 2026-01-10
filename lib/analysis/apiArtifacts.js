'use strict';

/**
 * Normalize an ISO timestamp.
 * @param {string|number|Date|undefined|null} value
 * @returns {string}
 */
function toIsoString(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

/**
 * Return the first finite number from the provided candidates.
 * @param  {...any} values
 * @returns {number|null}
 */
function pickNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * Extract an ATH price from a response payload.
 * @param {any} response
 * @returns {number|null}
 */
function extractAthPrice(response) {
  if (response == null) return null;
  if (typeof response === 'number') return Number.isFinite(response) ? response : null;
  if (typeof response === 'string') {
    const num = Number(response);
    return Number.isFinite(num) ? num : null;
  }
  if (typeof response !== 'object') return null;

  return pickNumber(
    response.ath,
    response.athPrice,
    response.price,
    response.priceUsd,
    response.price_usd,
    response.value,
    response.usd,
    response?.data?.ath,
    response?.data?.price,
    response?.data?.priceUsd,
  );
}

/**
 * Build a normalized ATH price artifact.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {any} params.response
 * @param {string|number|Date} [params.fetchedAt]
 * @returns {{ mint: string, fetchedAt: string, response: any, summary: { athPrice: number|null } }}
 */
function buildAthPriceArtifact({ mint, response, fetchedAt } = {}) {
  return {
    mint,
    fetchedAt: toIsoString(fetchedAt),
    response: response ?? null,
    summary: {
      athPrice: extractAthPrice(response),
    },
  };
}

/**
 * Extract a price range summary from response payloads.
 * @param {any} response
 * @returns {{ low: number|null, high: number|null, current: number|null }|null}
 */
function extractPriceRangeSummary(response) {
  if (!response || typeof response !== 'object') return null;
  const low = pickNumber(
    response.low,
    response.lowPrice,
    response.min,
    response.minPrice,
    response.priceLow,
    response.price_low,
    response?.data?.low,
    response?.data?.min,
  );
  const high = pickNumber(
    response.high,
    response.highPrice,
    response.max,
    response.maxPrice,
    response.priceHigh,
    response.price_high,
    response?.data?.high,
    response?.data?.max,
  );
  const current = pickNumber(
    response.price,
    response.priceUsd,
    response.current,
    response.currentPrice,
    response?.data?.price,
    response?.data?.priceUsd,
  );

  if (low == null && high == null && current == null) return null;
  return { low, high, current };
}

/**
 * Build a normalized price range artifact.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {number} params.timeFrom
 * @param {number} params.timeTo
 * @param {any} params.response
 * @param {string|number|Date} [params.fetchedAt]
 * @returns {{ request: { mint: string, timeFrom: number, timeTo: number }, fetchedAt: string, response: any, summary: Object|null }}
 */
function buildPriceRangeArtifact({ mint, timeFrom, timeTo, response, fetchedAt } = {}) {
  return {
    request: {
      mint,
      timeFrom,
      timeTo,
    },
    fetchedAt: toIsoString(fetchedAt),
    response: response ?? null,
    summary: extractPriceRangeSummary(response),
  };
}

/**
 * Parse devscan metadata rows into a structured artifact.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {string} params.source
 * @param {Object|null} params.metadataRow
 * @param {string|number|Date} [params.fetchedAt]
 * @returns {{ mint: string, source: string, fetchedAt: string, metadataId: string|null, updatedAt: number|null, response: any }}
 */
function buildDevscanMetadataArtifact({ mint, source, metadataRow, fetchedAt } = {}) {
  let parsed = null;
  if (metadataRow && metadataRow.response_json != null) {
    if (typeof metadataRow.response_json === 'string') {
      try {
        parsed = JSON.parse(metadataRow.response_json);
      } catch (err) {
        parsed = metadataRow.response_json;
      }
    } else {
      parsed = metadataRow.response_json;
    }
  }

  return {
    mint,
    source,
    fetchedAt: toIsoString(fetchedAt),
    metadataId: metadataRow?.metadata_id || null,
    updatedAt: metadataRow?.updated_at ?? null,
    response: parsed,
  };
}

module.exports = {
  buildAthPriceArtifact,
  buildPriceRangeArtifact,
  buildDevscanMetadataArtifact,
};
