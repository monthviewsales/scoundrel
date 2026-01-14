"use strict";

const { loadStrategyDocs } = require("./sellOps/strategyDocs");

const STRATEGY_DOCS = loadStrategyDocs();
const STRATEGY_LIST = [
  STRATEGY_DOCS.flash,
  STRATEGY_DOCS.hybrid,
  STRATEGY_DOCS.hybridv2,
  STRATEGY_DOCS.campaign,
].filter(Boolean);
const STRATEGY_LOOKUP = (() => {
  const map = new Map();
  const addKey = (key, doc) => {
    if (!key) return;
    const normalized = String(key)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!normalized) return;
    map.set(normalized, doc);
  };

  for (const doc of STRATEGY_LIST) {
    addKey(doc.name, doc);
    addKey(doc.strategyId, doc);
  }

  // Common short names
  addKey("flash", STRATEGY_DOCS.flash);
  addKey("hybrid", STRATEGY_DOCS.hybrid);
  addKey("hybridv2", STRATEGY_DOCS.hybridv2);
  addKey("campaign", STRATEGY_DOCS.campaign);

  return map;
})();

/**
 * Return the cached strategy docs.
 *
 * @returns {{ flash: object, hybrid: object, hybridv2: object, campaign: object }}
 */
function getStrategyDocs() {
  return STRATEGY_DOCS;
}

/**
 * Return the cached strategy list.
 *
 * @returns {object[]}
 */
function getStrategyList() {
  return STRATEGY_LIST.slice();
}

/**
 * Resolve a strategy doc for an override value.
 *
 * @param {any} value
 * @returns {object|null}
 */
function resolveStrategyOverride(value) {
  if (!value) return null;
  const key = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return STRATEGY_LOOKUP.get(key) || null;
}

/**
 * Resolve a human-readable label for a strategy.
 *
 * @param {any} rawValue
 * @param {object|null} doc
 * @returns {string}
 */
function resolveStrategyLabel(rawValue, doc) {
  if (doc && doc.name) return doc.name;
  if (rawValue) return String(rawValue).trim();
  return "inferred";
}

module.exports = {
  getStrategyDocs,
  getStrategyList,
  resolveStrategyOverride,
  resolveStrategyLabel,
};
