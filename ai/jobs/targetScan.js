"use strict";

const defaultClient = require("../gptClient");
const targetScanTask = require("../warlordAI/tasks/targetScan");
const { createWarlordAI } = require("../warlordAI");
const baseLogger = require("../../lib/logger");

/**
 * Create a TargetScan analysis runner bound to a specific AI client.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log: { debug: Function } }} client
 * @returns {{ analyzeTargetScan: (args: { payload: Object, model?: string, purpose?: string }) => Promise<Object> }}
 */
function createTargetScanAnalysis(client) {
  const resolvedClient = client || defaultClient;
  const { runTask } = createWarlordAI(resolvedClient);
  const fallbackLogger =
    baseLogger && typeof baseLogger.child === "function"
      ? baseLogger.child({ scope: "targetScan" })
      : console;
  const logger =
    resolvedClient.log && typeof resolvedClient.log.debug === "function"
      ? resolvedClient.log
      : fallbackLogger;
  const allowDebug =
    process.env.TARGETSCAN_DEBUG === "1" ||
    process.env.WARCHEST_TARGETSCAN_DEBUG === "1" ||
    process.env.SC_HUD_MODE !== "1";

  /**
   * Build a fallback response when the model fails.
   *
   * @param {Object} payload
   * @returns {Object}
   */
  function buildFallback(payload) {
    const mint = payload?.meta?.mint || payload?.mint || null;
    const symbol = payload?.token?.summary?.symbol ?? null;
    const name = payload?.token?.summary?.name ?? null;
    return {
      version: "targetscan.v2",
      mint: mint || "",
      symbol,
      name,
      buyScore: 0,
      rating: "avoid",
      confidence: 0,
      summary: "",
      keySignals: [],
      risks: [],
      invalidation: "",
      timeHorizon: "",
      notes: "",
    };
  }

  /**
   * Run the target scan task and normalize the output.
   *
   * @param {{ payload: Object, model?: string, purpose?: string }} params
   * @returns {Promise<Object>}
   */
  async function analyzeTargetScan({ payload, model, purpose }) {
    if (!payload) {
      throw new Error("[targetScan] missing payload");
    }

    let out;
    try {
      out = await runTask({
        task: "targetScan",
        payload: { payload, purpose },
        model,
      });
    } catch (err) {
      out = buildFallback(payload);
    }

    if (!out || typeof out !== "object") {
      out = buildFallback(payload);
    }

    if (allowDebug && logger && typeof logger.debug === "function") {
      logger.debug(
        "[targetScan] model output (truncated):",
        JSON.stringify(out).slice(0, 300)
      );
    }
    return out;
  }

  return { analyzeTargetScan };
}

const { analyzeTargetScan } = createTargetScanAnalysis(defaultClient);

module.exports = {
  createTargetScanAnalysis,
  analyzeTargetScan,
};
