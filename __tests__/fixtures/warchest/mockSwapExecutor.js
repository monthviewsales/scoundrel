'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  async performTrade(request) {
    if (process.env.SWAP_WORKER_TEST_LOG) {
      const logPath = process.env.SWAP_WORKER_TEST_LOG;
      const payload = {
        side: request.side,
        mint: request.mint,
        amount: request.amount,
        walletPubkey: request.walletPubkey,
        slippagePercent: request.slippagePercent,
        priorityFee: request.priorityFee,
        useJito: request.useJito,
        dryRun: request.dryRun,
      };
      fs.writeFileSync(path.resolve(logPath), JSON.stringify(payload, null, 2), 'utf8');
    }

    return {
      txid: 'stub-txid',
      signature: 'stub-sig',
      slot: 12345,
      tokensReceivedDecimal: 42,
      priceImpact: 0.1,
      quote: { amountIn: 1, amountOut: 2 },
    };
  },
};
