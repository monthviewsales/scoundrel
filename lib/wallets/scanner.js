'use strict';

// Raw wallet scan via Solana RPC (jsonParsed token accounts + SOL balance).
// Delegates to the existing WalletScanner helper.
const { scanWalletViaRpc } = require('../WalletScanner');

module.exports = {
  scanWalletViaRpc,
};
