'use strict';

describe('walletSelector re-export', () => {
  test('exposes wallet selection helpers', () => {
    const walletSelector = require('../../lib/cli/walletSelector');

    expect(typeof walletSelector.selectWalletInteractively).toBe('function');
    expect(typeof walletSelector.pickNextColor).toBe('function');
  });
});
