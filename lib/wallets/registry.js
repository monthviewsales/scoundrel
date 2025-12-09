'use strict';

// Thin wrapper around the BootyBox-backed wallet registry.
// Exposed here so other modules can import from lib/wallets only.
const walletRegistry = require('./walletRegistry');

module.exports = walletRegistry;
