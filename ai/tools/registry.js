'use strict';

const {
  normalizeChartPoints,
  buildWalletStatsFromChart,
  buildRegimeEventsFromChart,
} = require('../../lib/analysis/walletChart');
const { isBase58Mint, isSolToStableSwap } = require('../../lib/analysis/tradeMints');
const {
  extractTimestamp,
  extractSide,
  extractAmount,
  extractPrice,
  extractFees,
} = require('../../lib/autopsy/tradeExtractors');
const { createSolanaTrackerDataClient } = require('../../lib/solanaTrackerDataClient');

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
    name: 'solanaTrackerData.getWalletTrades',
    description: 'Fetch wallet trades from SolanaTracker with optional time filtering.',
    parameters: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
        startTime: { type: 'number' },
        endTime: { type: 'number' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['wallet'],
      additionalProperties: false,
    },
    handler: async ({
      wallet,
      limit,
      startTime,
      endTime,
      apiKey,
      baseUrl,
      maxAttempts,
      retryBaseMs,
    }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getWalletTrades({ wallet, limit, startTime, endTime });
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getWalletChart',
    description: 'Fetch wallet chart (PnL history) from SolanaTracker.',
    parameters: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['wallet'],
      additionalProperties: false,
    },
    handler: async ({ wallet, apiKey, baseUrl, maxAttempts, retryBaseMs }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getWalletChart(wallet);
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getPriceRange',
    description: 'Fetch a token price range for a time window from SolanaTracker.',
    parameters: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string' },
        timeFrom: { type: 'number' },
        timeTo: { type: 'number' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['tokenAddress', 'timeFrom', 'timeTo'],
      additionalProperties: false,
    },
    handler: async ({
      tokenAddress,
      timeFrom,
      timeTo,
      apiKey,
      baseUrl,
      maxAttempts,
      retryBaseMs,
    }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getPriceRange(tokenAddress, timeFrom, timeTo);
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getTokenOverview',
    description: 'Fetch the token overview feed from SolanaTracker.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1 },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: async ({ limit, apiKey, baseUrl, maxAttempts, retryBaseMs }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getTokenOverview({ limit });
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getTokenPrice',
    description: 'Fetch the latest token price snapshot from SolanaTracker.',
    parameters: {
      type: 'object',
      properties: {
        mint: { type: 'string' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['mint'],
      additionalProperties: false,
    },
    handler: async ({ mint, apiKey, baseUrl, maxAttempts, retryBaseMs }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getTokenPrice(mint);
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getTokenSnapshotNow',
    description: 'Fetch the latest token snapshot (overview + pricing) from SolanaTracker.',
    parameters: {
      type: 'object',
      properties: {
        mint: { type: 'string' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['mint'],
      additionalProperties: false,
    },
    handler: async ({ mint, apiKey, baseUrl, maxAttempts, retryBaseMs }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getTokenSnapshotNow(mint);
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getTokenRiskScores',
    description: 'Fetch SolanaTracker token risk scores.',
    parameters: {
      type: 'object',
      properties: {
        mint: { type: 'string' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['mint'],
      additionalProperties: false,
    },
    handler: async ({ mint, apiKey, baseUrl, maxAttempts, retryBaseMs }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getTokenRiskScores(mint);
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'solanaTrackerData.getAthPrice',
    description: 'Fetch the token all-time-high price from SolanaTracker.',
    parameters: {
      type: 'object',
      properties: {
        mint: { type: 'string' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        maxAttempts: { type: 'integer', minimum: 1 },
        retryBaseMs: { type: 'number', minimum: 0 },
      },
      required: ['mint'],
      additionalProperties: false,
    },
    handler: async ({ mint, apiKey, baseUrl, maxAttempts, retryBaseMs }) => {
      const client = createSolanaTrackerDataClient({ apiKey, baseUrl, maxAttempts, retryBaseMs });
      try {
        return await client.getAthPrice(mint);
      } finally {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      }
    },
  },
  {
    name: 'walletChart.normalizeChartPoints',
    description: 'Normalize raw wallet chart points to sorted {t, pnl} entries.',
    parameters: {
      type: 'object',
      properties: {
        rawChart: { type: 'array', items: { type: 'object' } },
      },
      required: ['rawChart'],
      additionalProperties: false,
    },
    handler: ({ rawChart }) => normalizeChartPoints(rawChart),
  },
  {
    name: 'walletChart.buildWalletStatsFromChart',
    description: 'Compute wallet-level stats from a raw chart (timeframe, deltas, trend).',
    parameters: {
      type: 'object',
      properties: {
        rawChart: { type: 'array', items: { type: 'object' } },
      },
      required: ['rawChart'],
      additionalProperties: false,
    },
    handler: ({ rawChart }) => buildWalletStatsFromChart(rawChart),
  },
  {
    name: 'walletChart.buildRegimeEventsFromChart',
    description: 'Derive regime events (major runs/nukes) from a raw chart.',
    parameters: {
      type: 'object',
      properties: {
        rawChart: { type: 'array', items: { type: 'object' } },
      },
      required: ['rawChart'],
      additionalProperties: false,
    },
    handler: ({ rawChart }) => buildRegimeEventsFromChart(rawChart),
  },
  {
    name: 'tradeMints.isBase58Mint',
    description: 'Check whether a string is a base58 Solana mint address.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    handler: ({ value }) => isBase58Mint(value),
  },
  {
    name: 'tradeMints.isSolToStableSwap',
    description: 'Heuristic check for SOL→stable profit-taking swaps.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'object' },
      },
      required: ['trade'],
      additionalProperties: false,
    },
    handler: ({ trade }) => isSolToStableSwap(trade),
  },
  {
    name: 'autopsy.extractTimestamp',
    description: 'Extract a timestamp (epoch ms) from a trade object.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'object' },
      },
      required: ['trade'],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractTimestamp(trade),
  },
  {
    name: 'autopsy.extractSide',
    description: 'Extract trade side (buy/sell) using a wallet context when needed.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'object' },
        wallet: { type: 'string' },
      },
      required: ['trade'],
      additionalProperties: false,
    },
    handler: ({ trade, wallet }) => extractSide(trade, wallet),
  },
  {
    name: 'autopsy.extractAmount',
    description: 'Extract token amount from a trade object.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'object' },
      },
      required: ['trade'],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractAmount(trade),
  },
  {
    name: 'autopsy.extractPrice',
    description: 'Extract unit price (USD/SOL as provided) from a trade object.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'object' },
      },
      required: ['trade'],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractPrice(trade),
  },
  {
    name: 'autopsy.extractFees',
    description: 'Extract fee amount from a trade object.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'object' },
      },
      required: ['trade'],
      additionalProperties: false,
    },
    handler: ({ trade }) => extractFees(trade),
  },
];

module.exports = { toolDefinitions };
