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
