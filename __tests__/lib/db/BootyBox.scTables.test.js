'use strict';

const mockQuery = jest.fn().mockResolvedValue([[], []]);
const mockGetConnection = jest.fn().mockResolvedValue({
  query: jest.fn(),
  beginTransaction: jest.fn(),
  commit: jest.fn(),
  rollback: jest.fn(),
  release: jest.fn(),
});
const mockPool = {
  query: mockQuery,
  getConnection: mockGetConnection,
};
const mockGetPool = jest.fn(() => mockPool);
const mockPing = jest.fn().mockResolvedValue();
const mockClose = jest.fn().mockResolvedValue();

jest.mock('../../../lib/db/mysql', () => ({
  getPool: mockGetPool,
  ping: mockPing,
  close: mockClose,
}));

describe('BootyBox sc_* helpers', () => {
  let BootyBox;

  const loadBootyBox = async () => {
    jest.resetModules();
    BootyBox = require('../../../lib/db/BootyBox.mysql');
    mockQuery.mockResolvedValue([[], []]);
    await BootyBox.init();
    mockQuery.mockClear();
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await loadBootyBox();
  });

  test('listWarchestWallets normalizes rows', async () => {
    mockQuery.mockResolvedValueOnce([
      [
        {
          walletId: 5,
          alias: 'alpha',
          pubkey: 'Pubkey111',
          color: null,
          hasPrivateKey: 1,
          keySource: 'none',
          keyRef: null,
          createdAt: 'now',
          updatedAt: 'now',
        },
      ],
    ]);

    const rows = await BootyBox.listWarchestWallets();

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM sc_wallets'));
    expect(rows).toEqual([
      expect.objectContaining({
        walletId: 5,
        alias: 'alpha',
        hasPrivateKey: true,
      }),
    ]);
  });

  test('insertWarchestWallet includes wallet_id when provided', async () => {
    mockQuery
      .mockResolvedValueOnce([{}, undefined])
      .mockResolvedValueOnce([
        [
          {
            walletId: 'custom123',
            alias: 'bravo',
            pubkey: 'Pubkey222',
            hasPrivateKey: 0,
            keySource: 'none',
            keyRef: null,
            color: null,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ],
      ]);

    const row = await BootyBox.insertWarchestWallet({
      walletId: 'custom123',
      alias: 'bravo',
      pubkey: 'Pubkey222',
      hasPrivateKey: false,
      keySource: 'none',
    });

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('wallet_id'),
      expect.arrayContaining(['custom123', 'bravo', 'Pubkey222'])
    );
    expect(row).toMatchObject({
      walletId: 'custom123',
      alias: 'bravo',
      hasPrivateKey: false,
    });
  });

  test('recordAsk serializes JSON payloads', async () => {
    mockQuery.mockResolvedValueOnce([{}, undefined]);

    await BootyBox.recordAsk({
      askId: 'ask123',
      correlationId: 'ask123',
      question: 'What now?',
      profile: { foo: 'bar' },
      rows: [{ id: 1 }],
      model: 'gpt',
      temperature: 0.2,
      responseRaw: { answer: 'hi' },
      answer: 'hi',
      bullets: ['a', 'b'],
      actions: ['do stuff'],
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('ask123');
    expect(params[3]).toBe(JSON.stringify({ foo: 'bar' }));
    expect(params[4]).toBe(JSON.stringify([{ id: 1 }]));
    expect(params[7]).toBe(JSON.stringify({ answer: 'hi' }));
    expect(params[9]).toBe(JSON.stringify(['a', 'b']));
    expect(params[10]).toBe(JSON.stringify(['do stuff']));
  });

  test('persistWalletProfileArtifacts increments version and writes all tables', async () => {
    mockQuery
      .mockResolvedValueOnce([[], []]) // getLatestWalletProfileVersion
      .mockResolvedValueOnce([{}, undefined]) // profiles
      .mockResolvedValueOnce([{}, undefined]) // versions
      .mockResolvedValueOnce([{}, undefined]); // index

    const result = await BootyBox.persistWalletProfileArtifacts({
      wallet: 'Wallet111',
      technique: { style: 'scalp' },
      outcomes: { winRate: 0.5, medianExitPct: 12 },
      heuristics: { foo: 'bar' },
      enrichment: null,
    });

    expect(result).toEqual({ wallet: 'Wallet111', version: 1 });
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM sc_wallet_profiles'),
      ['Wallet111']
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INTO sc_wallet_profiles'),
      expect.arrayContaining(['Wallet111', 1])
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INTO sc_wallet_profile_versions'),
      expect.arrayContaining(['Wallet111', 1])
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INTO sc_wallet_profile_index'),
      expect.arrayContaining(['Wallet111', 'scalp'])
    );
  });
});
