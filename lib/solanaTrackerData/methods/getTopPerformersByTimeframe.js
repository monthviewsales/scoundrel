"use strict";

const VALID_TIMEFRAMES = ["5m", "15m", "30m", "1h", "6h", "12h", "24h"];

/**
 * Bind helper for /top-performers endpoint.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options?: { timeframe?: string }) => Promise<any>}
 */
function createGetTopPerformersByTimeframe({ client, call }) {
  if (!client || !call)
    throw new Error("createGetTopPerformersByTimeframe: missing dependencies");

  return async function getTopPerformersByTimeframe(options = {}) {
    const { timeframe } = options;
    if (timeframe && !VALID_TIMEFRAMES.includes(timeframe)) {
      throw new Error(
        `getTopPerformersByTimeframe: timeframe must be one of ${VALID_TIMEFRAMES.join(
          ", "
        )}`
      );
    }

    return call("getTopPerformersByTimeframe", () =>
      client.getTopPerformers(timeframe)
    );
  };
}

module.exports = { createGetTopPerformersByTimeframe };
