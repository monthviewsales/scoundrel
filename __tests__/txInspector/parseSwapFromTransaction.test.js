'use strict';

jest.mock('../../lib/persist/jsonArtifacts', () => ({
  formatRunId: jest.fn(() => 'run-1'),
  getArtifactConfig: jest.fn(() => ({ saveRaw: false })),
  sanitizeSegment: jest.fn((value) => String(value)),
  writeJsonArtifact: jest.fn(),
}));

jest.mock('../../lib/services/tokenInfoService', () => ({
  ensureTokenInfo: jest.fn(),
  getTokenInfo: jest.fn(),
}));

const tokenInfoService = require('../../lib/services/tokenInfoService');
const {
  parseSwapFromTransaction,
  parseSwapFromTransactionWithTokenInfo,
} = require('../../lib/txInspector/parseSwapFromTransaction');

describe('parseSwapFromTransaction', () => {
  test('parses token and sol deltas for a wallet', () => {
    const rawTx = {
      slot: 42,
      blockTime: 123,
      meta: {
        fee: 5000,
        preBalances: [1_000_000_000, 2_000_000_000],
        postBalances: [900_000_000, 2_100_000_000],
        preTokenBalances: [
          {
            mint: 'MintAAA',
            owner: 'Wallet1',
            uiTokenAmount: { uiAmount: 1 },
          },
        ],
        postTokenBalances: [
          {
            mint: 'MintAAA',
            owner: 'Wallet1',
            uiTokenAmount: { uiAmount: 3 },
          },
        ],
      },
      transaction: {
        message: {
          accountKeys: ['Wallet1', 'Wallet2'],
        },
      },
    };

    const parsed = parseSwapFromTransaction(rawTx, {
      mint: 'MintAAA',
      payerPubkey: 'Wallet1',
    });

    expect(parsed).toEqual(expect.objectContaining({
      mint: 'MintAAA',
      payerPubkey: 'Wallet1',
      tokenDelta: 2,
      tokenDecrease: 0,
      solDiffLamports: -100_000_000,
      feeLamports: 5000,
    }));
  });

  test('returns null when input is missing', () => {
    expect(parseSwapFromTransaction(null, null)).toBeNull();
  });
});

describe('parseSwapFromTransactionWithTokenInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('enriches parsed swap with token info', async () => {
    tokenInfoService.getTokenInfo.mockResolvedValue({ symbol: 'AAA', decimals: 6 });

    const rawTx = {
      slot: 42,
      meta: {
        preBalances: [1_000_000_000],
        postBalances: [900_000_000],
        preTokenBalances: [
          {
            mint: 'MintAAA',
            owner: 'Wallet1',
            uiTokenAmount: { uiAmount: 1 },
          },
        ],
        postTokenBalances: [
          {
            mint: 'MintAAA',
            owner: 'Wallet1',
            uiTokenAmount: { uiAmount: 2 },
          },
        ],
      },
      transaction: {
        message: {
          accountKeys: ['Wallet1'],
        },
      },
    };

    const result = await parseSwapFromTransactionWithTokenInfo(rawTx, {
      mint: 'MintAAA',
      payerPubkey: 'Wallet1',
      client: {},
    });

    expect(result.tokenInfo).toEqual(expect.objectContaining({ symbol: 'AAA' }));
  });
});
