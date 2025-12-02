'use strict';

// Shared live wallet state helpers (SOL/token snapshots).
// This wraps the singleton from solana/rpcMethods/internal/walletState.
const walletState = require('../solana/rpcMethods/internal/walletState');

module.exports = walletState;
