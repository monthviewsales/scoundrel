jest.mock('../../lib/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../lib/logger');
const { fetchAllTokenAccounts } = require('../../lib/warchest/fetchAllTokenAccounts');

describe('fetchAllTokenAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('paginates through all pages with cursor', async () => {
    const rpcMethods = {
      getTokenAccountsByOwnerV2: jest
        .fn()
        .mockResolvedValueOnce({
          accounts: [
            { pubkey: 'acct1', mint: 'mintA', uiAmount: 1 },
          ],
          hasMore: true,
          nextCursor: 'cursor-1',
          totalCount: 2,
        })
        .mockResolvedValueOnce({
          accounts: [
            { pubkey: 'acct2', mint: 'mintB', uiAmount: 2 },
          ],
          hasMore: false,
          nextCursor: null,
          totalCount: 2,
        }),
    };

    const result = await fetchAllTokenAccounts(rpcMethods, 'owner1', {
      programId: 'programX',
      limit: 1,
    });

    expect(rpcMethods.getTokenAccountsByOwnerV2).toHaveBeenCalledTimes(2);
    expect(rpcMethods.getTokenAccountsByOwnerV2).toHaveBeenNthCalledWith(2, 'owner1', expect.objectContaining({
      paginationKey: 'cursor-1',
    }));
    expect(result.accounts).toHaveLength(2);
    expect(result.pageCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('deduplicates accounts across pages', async () => {
    const rpcMethods = {
      getTokenAccountsByOwnerV2: jest.fn().mockResolvedValue({
        accounts: [
          { pubkey: 'acct1', mint: 'mintA', uiAmount: 1 },
          { pubkey: 'acct1', mint: 'mintA', uiAmount: 1 },
        ],
        hasMore: false,
        nextCursor: null,
        totalCount: 2,
      }),
    };

    const result = await fetchAllTokenAccounts(rpcMethods, 'owner2');

    expect(result.accounts).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('flags truncation when page limit is hit', async () => {
    const rpcMethods = {
      getTokenAccountsByOwnerV2: jest.fn().mockResolvedValue({
        accounts: [
          { pubkey: 'acct1', mint: 'mintA', uiAmount: 1 },
        ],
        hasMore: true,
        nextCursor: 'cursor-next',
        totalCount: 100,
      }),
    };

    const result = await fetchAllTokenAccounts(rpcMethods, 'owner3', { pageLimit: 1 });

    expect(result.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
