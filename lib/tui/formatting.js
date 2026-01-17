'use strict';

/**
 * Abbreviate a base58-ish address for display.
 *
 * @param {string} value
 * @param {number} left
 * @param {number} right
 * @returns {string}
 */
function shortenAddress(value, left = 4, right = 4) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

/**
 * Normalize a query string for comparisons.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeQuery(value) {
  return String(value || '').trim().toLowerCase();
}

module.exports = {
  shortenAddress,
  normalizeQuery,
};
