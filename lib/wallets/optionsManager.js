'use strict';

const walletRegistry = require('./walletRegistry');

const USAGE_TYPES = Object.freeze(['funding', 'strategy', 'kol', 'deployer', 'other']);

function normalizeUsageType(value) {
  if (typeof value !== 'string') return 'other';
  const trimmed = value.trim().toLowerCase();
  return USAGE_TYPES.includes(trimmed) ? trimmed : 'other';
}

function sanitizeStrategy(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

async function getWalletOptions(alias) {
  if (!alias) return null;
  return walletRegistry.getWalletByAlias(alias);
}

async function updateWalletOptions(alias, updates = {}) {
  if (!alias) {
    throw new Error('updateWalletOptions requires a wallet alias');
  }

  const payload = {};
  const hasProp = (prop) => Object.prototype.hasOwnProperty.call(updates, prop);

  if (hasProp('usageType')) {
    payload.usageType = normalizeUsageType(updates.usageType);
  }

  if (hasProp('autoAttachWarchest')) {
    payload.autoAttachWarchest = !!updates.autoAttachWarchest;
  }

  if (hasProp('isDefaultFunding')) {
    payload.isDefaultFunding = !!updates.isDefaultFunding;
  }

  if (hasProp('strategy')) {
    payload.strategy = sanitizeStrategy(updates.strategy);
  } else if (hasProp('strategyId')) {
    payload.strategy = sanitizeStrategy(updates.strategyId);
  }

  if (hasProp('color')) {
    payload.color = updates.color == null ? null : String(updates.color).trim().slice(0, 32);
  }

  if (hasProp('hasPrivateKey')) {
    payload.hasPrivateKey = !!updates.hasPrivateKey;
  }

  if (hasProp('keySource')) {
    payload.keySource = updates.keySource ? String(updates.keySource).trim() : 'none';
  }

  if (hasProp('keyRef')) {
    payload.keyRef = updates.keyRef == null ? null : String(updates.keyRef).trim();
  }

  if (!Object.keys(payload).length) {
    return walletRegistry.getWalletByAlias(alias);
  }

  return walletRegistry.updateWalletOptions(alias, payload);
}

module.exports = {
  USAGE_TYPES,
  normalizeUsageType,
  sanitizeStrategy,
  getWalletOptions,
  updateWalletOptions,
};
