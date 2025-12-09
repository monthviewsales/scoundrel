'use strict';

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockResolver = {
  listFundingWallets: jest.fn(),
  getAllWallets: jest.fn(),
  getDefaultFundingWallet: jest.fn(),
  resolveAliasOrAddress: jest.fn(),
};

jest.mock('../../lib/wallets/resolver', () => ({
  createWalletResolver: jest.fn(() => mockResolver),
}));

const mockRegistry = {
  setDefaultFundingWallet: jest.fn(),
  getDefaultFundingWallet: jest.fn(),
  addWallet: jest.fn(),
};

jest.mock('../../lib/wallets/registry', () => mockRegistry);

const { selectWalletInteractively } = require('../../lib/wallets/walletSelection');

function createMockRl(responses) {
  const answers = Array.from(responses);
  return {
    question: jest.fn(() => Promise.resolve(answers.shift())),
    close: jest.fn(),
  };
}

describe('walletSelection.selectWalletInteractively', () => {
beforeEach(() => {
  jest.clearAllMocks();
  mockResolver.listFundingWallets.mockResolvedValue([]);
  mockResolver.getAllWallets.mockResolvedValue([]);
  mockResolver.getDefaultFundingWallet.mockResolvedValue({
    alias: 'alpha',
    pubkey: 'PubAlpha',
    color: 'green',
  });
});

  it('returns registry wallet metadata when user picks an indexed option', async () => {
    mockResolver.listFundingWallets.mockResolvedValue([
      { alias: 'alpha', pubkey: 'PubAlpha', color: 'green' },
      { alias: 'beta', pubkey: 'PubBeta', color: 'blue' },
    ]);
    const rl = createMockRl(['1']);

    const result = await selectWalletInteractively({
      rl,
      promptLabel: 'Pick a wallet',
      allowOther: true,
    });

    expect(result).toEqual({
      walletLabel: 'alpha',
      walletAddress: 'PubAlpha',
      walletColor: 'green',
    });
  });

  it('prompts for address when selecting Other and returns watch-only metadata', async () => {
    mockResolver.listFundingWallets.mockResolvedValue([
      { alias: 'alpha', pubkey: 'PubAlpha', color: 'green' },
      { alias: 'beta', pubkey: 'PubBeta', color: 'blue' },
    ]);
    const rl = createMockRl(['3', 'CustomPub']);

    const result = await selectWalletInteractively({
      rl,
      promptLabel: 'Pick a wallet',
      allowOther: true,
    });

    expect(result).toEqual({
      walletLabel: 'other',
      walletAddress: 'CustomPub',
      walletColor: null,
    });
  });
});
