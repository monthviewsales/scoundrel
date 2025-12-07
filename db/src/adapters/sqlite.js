'use strict';

const context = require('./sqlite/context');
const wallets = require('./sqlite/wallets');
const profiles = require('./sqlite/profiles');
const coins = require('./sqlite/coins');
const trading = require('./sqlite/trading');
const sessions = require('./sqlite/sessions');
const legacy = require('./sqlite/legacyAdapter');

// Prefer specialized submodules where available; fall back to legacy implementations for the rest.
const BootyBox = {
  ...legacy,
  ...wallets,
  ...profiles,
  ...coins,
  ...trading,
  ...sessions,
  engine: 'sqlite',
};

BootyBox.init = async (options = {}) => {
  if (typeof legacy.init === 'function') {
    await legacy.init(options);
  }
};

BootyBox.close = async () => {
  if (typeof legacy.close === 'function') {
    await legacy.close();
  }
};

module.exports = BootyBox;
module.exports.modules = {
  context,
  wallets,
  profiles,
  coins,
  trading,
  sessions,
  legacy,
};
