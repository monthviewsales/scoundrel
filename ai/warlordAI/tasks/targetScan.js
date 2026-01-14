"use strict";

const targetScanSchema = require("../../schemas/targetscan.v1.schema.json");

const SYSTEM = [
  "You are Warlord's target scan engine.",
  "You receive JSON describing a single mint with token summary, market overview, OHLCV context, price range, ATH, and optional devscan metadata.",
  "Your job is to score the mint's buy opportunity and return a structured JSON response.",
  "buyScore must be 0-100 where 100 is strongest buy conviction.",
  "rating must be one of: strong_buy, buy, watch, avoid.",
  "Use only the provided data; do not invent prices, holders, or risk flags.",
  "If data is missing, state that in notes or risks and lower confidence.",
  "Keep summary concise and actionable.  Must be less than 256 characters.",
  "Return ONLY valid JSON following the schema. No markdown. No extra commentary.",
].join(" ");

/**
 * Build the user payload for target scan.
 * @param {Object} payload
 * @returns {Object}
 */
function buildUser(payload) {
  return payload?.payload || payload || {};
}

module.exports = {
  name: "targetscan_v1",
  schema: targetScanSchema,
  system: SYSTEM,
  buildUser,
};
