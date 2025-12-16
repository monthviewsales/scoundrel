jest.mock('../../lib/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../lib/logger');
const { resolveWalletSpecsWithRegistry } = require('../../lib/wallets/resolver');

describe('resolveWalletSpecsWithRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses existing wallet rows', async () => {
    const bootyBox = {
      getWarchestWalletByAlias: jest.fn().mockReturnValue({
        walletId: 42,
        alias: 'alpha',
        pubkey: 'pub-alpha',
        color: 'green',
      }),
    };

    const result = await resolveWalletSpecsWithRegistry([
      { alias: 'alpha', pubkey: 'pub-alpha', color: null },
    ], bootyBox);

    expect(result).toEqual([
      {
        alias: 'alpha',
        pubkey: 'pub-alpha',
        color: 'green',
        walletId: 42,
      },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('inserts missing wallets and propagates color', async () => {
    const bootyBox = {
      getWarchestWalletByAlias: jest.fn().mockReturnValue(null),
      insertWarchestWallet: jest.fn().mockReturnValue({
        walletId: 7,
        alias: 'bravo',
        pubkey: 'pub-bravo',
        color: null,
      }),
    };

    const result = await resolveWalletSpecsWithRegistry([
      { alias: 'bravo', pubkey: 'pub-bravo', color: 'blue' },
    ], bootyBox);

    expect(bootyBox.insertWarchestWallet).toHaveBeenCalledWith(expect.objectContaining({
      alias: 'bravo',
      pubkey: 'pub-bravo',
      color: 'blue',
      autoAttachWarchest: true,
      usageType: 'funding',
    }));
    expect(result[0]).toMatchObject({ walletId: 7, color: 'blue' });
  });

  it('skips mismatched aliases to avoid mis-attribution', async () => {
    const bootyBox = {
      getWarchestWalletByAlias: jest.fn().mockReturnValue({
        walletId: 99,
        alias: 'charlie',
        pubkey: 'pub-db',
      }),
    };

    const result = await resolveWalletSpecsWithRegistry([
      { alias: 'charlie', pubkey: 'pub-cli' },
    ], bootyBox);

    expect(result).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });
});
