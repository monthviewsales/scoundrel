"use strict";

const {
  normalizeChartPoints,
  buildWalletStatsFromChart,
  buildRegimeEventsFromChart,
} = require("../../lib/analysis/walletChart");
const {
  isBase58Mint,
  isSolToStableSwap,
} = require("../../lib/analysis/tradeMints");
const {
  extractTimestamp,
  extractSide,
  extractAmount,
  extractPrice,
  extractFees,
} = require("../../lib/autopsy/tradeExtractors");
const {
  createSolanaTrackerDataClient,
} = require("../../lib/solanaTrackerDataClient");

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Object} parameters
 * @property {Function} handler
 */

/** @type {ToolDefinition[]} */
const toolDefinitions = [
  {
    name: "solanaTrackerData.getWalletTrades",
    description:
      "Fetch wallet trades from SolanaTracker with optional time filtering.",
    parameters: {
      type: "object",
      properties: {
        wallet: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        startTime: { type: "number" },
        endTime: { type: "number" },
      },
      required: ["wallet"],
      additionalProperties: false,
    },
    handler: async ({ wallet, limit, startTime, endTime }) => {
      const client = await createSolanaTrackerDataClient();
      try {
        return await client.getWalletTrades({
          wallet,
          limit,
          startTime,
          endTime,
        });
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "solanaTrackerData.getWalletChart",
    description: "Fetch wallet chart (PnL history) from SolanaTracker.",
    parameters: {
      type: "object",
      properties: {
        wallet: { type: "string" },
      },
      required: ["wallet"],
      additionalProperties: false,
    },
    handler: async ({ wallet }) => {
      const client = await createSolanaTrackerDataClient();
      try {
        return await client.getWalletChart(wallet);
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "solanaTrackerData.getPriceRange",
    description:
      "Fetch a token price range for a time window from SolanaTracker.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string" },
        tokenAddress: { type: "string" },
        timeFrom: { type: "number" },
        timeTo: { type: "number" },
      },
      required: ["timeFrom", "timeTo"],
      additionalProperties: false,
    },
    handler: async ({ mint, tokenAddress, timeFrom, timeTo }) => {
      const client = await createSolanaTrackerDataClient();
      const target = typeof mint === "string" && mint.trim() !== ""
        ? mint.trim()
        : typeof tokenAddress === "string" && tokenAddress.trim() !== ""
          ? tokenAddress.trim()
          : undefined;
      try {
        return await client.getPriceRange(target, timeFrom, timeTo);
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "solanaTrackerData.getTokenOverview",
    description: "Fetch the token overview feed from SolanaTracker.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: async ({ limit }) => {
      const client = await createSolanaTrackerDataClient();
      try {
        return await client.getTokenOverview({ limit });
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "solanaTrackerData.getTokenPrice",
    description: "Fetch the latest token price snapshot from SolanaTracker.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string" },
        tokenAddress: { type: "string" },
        includePriceChanges: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: async ({ mint, tokenAddress, includePriceChanges }) => {
      const client = await createSolanaTrackerDataClient();
      const payload = {};
      if (typeof mint === "string" && mint.trim() !== "") {
        payload.mint = mint.trim();
      } else if (typeof tokenAddress === "string" && tokenAddress.trim() !== "") {
        payload.tokenAddress = tokenAddress.trim();
      }
      try {
        return await client.getTokenPrice({
          ...payload,
          includePriceChanges: includePriceChanges === true,
        });
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "solanaTrackerData.getTokenSnapshotNow",
    description:
      "Fetch the latest token snapshot (overview + pricing) from SolanaTracker.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string" },
        tokenAddress: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async ({ mint, tokenAddress }) => {
      const client = await createSolanaTrackerDataClient();
      const payload = {};
      if (typeof mint === "string" && mint.trim() !== "") {
        payload.mint = mint.trim();
      } else if (typeof tokenAddress === "string" && tokenAddress.trim() !== "") {
        payload.tokenAddress = tokenAddress.trim();
      }
      try {
        return await client.getTokenSnapshotNow(payload);
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "solanaTrackerData.getAthPrice",
    description: "Fetch the token all-time-high price from SolanaTracker.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string" },
        tokenAddress: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async ({ mint, tokenAddress }) => {
      const client = await createSolanaTrackerDataClient();
      const target = typeof mint === "string" && mint.trim() !== ""
        ? mint.trim()
        : typeof tokenAddress === "string" && tokenAddress.trim() !== ""
          ? tokenAddress.trim()
          : undefined;
      try {
        return await client.getAthPrice(target);
      } finally {
        if (client && typeof client.close === "function") {
          await client.close();
        }
      }
    },
  },
  {
    name: "grok.scoreProfile",
    description:
      "Score an X profile using Grok with a structured JSON response.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string" },
        profileUrl: { type: "string" },
        profile: { type: "object" },
        model: { type: "string" },
        purpose: { type: "string" },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    handler: async ({ handle, profileUrl, profile, model, purpose }) => {
      const { runGrokProfileScore } = require("../jobs/grokProfileScore");
      return runGrokProfileScore({
        handle,
        profileUrl,
        profile,
        model,
        purpose,
      });
    },
  },
  {
    name: "grok.searchMintReport",
    description:
      "Search X for a mint and return a DevScan-style structured report.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string" },
        symbol: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        model: { type: "string" },
        purpose: { type: "string" },
      },
      required: ["mint"],
      additionalProperties: false,
    },
    handler: async ({ mint, symbol, aliases, model, purpose }) => {
      const {
        runGrokMintSearchReport,
      } = require("../jobs/grokMintSearchReport");
      return runGrokMintSearchReport({
        mint,
        symbol,
        aliases,
        model,
        purpose,
      });
    },
  },
  {
    name: "walletChart.normalizeChartPoints",
    description:
      "Normalize raw wallet chart points to sorted {t, pnl} entries.",
    parameters: {
      type: "object",
      properties: {
        rawChart: { type: "array", items: { type: "object" } },
      },
      required: ["rawChart"],
      additionalProperties: false,
    },
    handler: ({ rawChart }) => normalizeChartPoints(rawChart),
  },
  {
    name: "walletChart.buildWalletStatsFromChart",
    description:
      "Compute wallet-level stats from a raw chart (timeframe, deltas, trend).",
    parameters: {
      type: "object",
      properties: {
        rawChart: { type: "array", items: { type: "object" } },
      },
      required: ["rawChart"],
      additionalProperties: false,
    },
    handler: ({ rawChart }) => buildWalletStatsFromChart(rawChart),
  },
  {
    name: "walletChart.buildRegimeEventsFromChart",
    description: "Derive regime events (major runs/nukes) from a raw chart.",
    parameters: {
      type: "object",
      properties: {
        rawChart: { type: "array", items: { type: "object" } },
      },
      required: ["rawChart"],
      additionalProperties: false,
    },
    handler: ({ rawChart }) => buildRegimeEventsFromChart(rawChart),
  },
  {
    name: "tradeMints.isBase58Mint",
    description: "Check whether a string is a base58 Solana mint address.",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    handler: ({ value }) => isBase58Mint(value),
  },
  {
    name: "tradeMints.isSolToStableSwap",
    description: "Heuristic check for SOL→stable profit-taking swaps.",
    parameters: {
      type: "object",
      properties: {
        trade: { type: "object" },
      },
      required: ["trade"],
      additionalProperties: false,
    },
    handler: ({ trade }) => isSolToStableSwap(trade),
  },
  {
    name: "autopsy.extractTimestamp",
    description: "Extract a timestamp (epoch ms) from a trade object.",
    parameters: {
      type: "object",
      properties: {
        trade: { type: "object" },
      },
      required: ["trade"],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractTimestamp(trade),
  },
  {
    name: "autopsy.extractSide",
    description:
      "Extract trade side (buy/sell) using a wallet context when needed.",
    parameters: {
      type: "object",
      properties: {
        trade: { type: "object" },
        wallet: { type: "string" },
      },
      required: ["trade"],
      additionalProperties: false,
    },
    handler: ({ trade, wallet }) => extractSide(trade, wallet),
  },
  {
    name: "autopsy.extractAmount",
    description: "Extract token amount from a trade object.",
    parameters: {
      type: "object",
      properties: {
        trade: { type: "object" },
      },
      required: ["trade"],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractAmount(trade),
  },
  {
    name: "autopsy.extractPrice",
    description:
      "Extract unit price (USD/SOL as provided) from a trade object.",
    parameters: {
      type: "object",
      properties: {
        trade: { type: "object" },
      },
      required: ["trade"],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractPrice(trade),
  },
  {
    name: "autopsy.extractFees",
    description: "Extract fee amount from a trade object.",
    parameters: {
      type: "object",
      properties: {
        trade: { type: "object" },
      },
      required: ["trade"],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractFees(trade),
  },
];

module.exports = { toolDefinitions };
