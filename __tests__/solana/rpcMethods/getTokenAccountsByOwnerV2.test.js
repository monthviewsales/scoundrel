'use strict';

const { createGetTokenAccountsByOwnerV2 } = require('../../../lib/solana/rpcMethods/getTokenAccountsByOwnerV2');

describe('createGetTokenAccountsByOwnerV2', () => {
  test('returns normalized accounts and pagination info', async () => {
    const response = {
      accounts: [
        {
          pubkey: 'Account1',
          account: {
            data: {
              parsed: {
                info: {
                  mint: 'Mint1',
                  owner: 'Owner1',
                  tokenAmount: {
                    uiAmount: 1.23,
                    decimals: 2,
                  },
                },
              },
            },
          },
        },
      ],
      hasMore: true,
      nextCursor: 'cursor-123',
      totalCount: 99,
    };

    const rpc = {
      getTokenAccountsByOwnerV2: jest.fn(() => ({
        send: jest.fn(async () => response),
      })),
    };

    const getTokenAccountsByOwnerV2 = createGetTokenAccountsByOwnerV2(rpc);
    const result = await getTokenAccountsByOwnerV2('Owner1', { limit: 10 });

    expect(rpc.getTokenAccountsByOwnerV2).toHaveBeenCalledWith(
      'Owner1',
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { limit: 10, encoding: 'jsonParsed' },
    );
    expect(result.accounts).toEqual([
      expect.objectContaining({
        pubkey: 'Account1',
        mint: 'Mint1',
        owner: 'Owner1',
        uiAmount: 1.23,
        decimals: 2,
      }),
    ]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('cursor-123');
    expect(result.totalCount).toBe(99);
  });

  test('coerces pagination defaults', async () => {
    const response = {
      value: {
        accounts: [],
        hasMore: 0,
        nextCursor: undefined,
        totalCount: '5',
      },
    };

    const rpc = {
      getTokenAccountsByOwnerV2: jest.fn(() => ({
        send: jest.fn(async () => response),
      })),
    };

    const getTokenAccountsByOwnerV2 = createGetTokenAccountsByOwnerV2(rpc);
    const result = await getTokenAccountsByOwnerV2('Owner2');

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.totalCount).toBe(5);
  });

  test('throws when rpc method missing', async () => {
    const getTokenAccountsByOwnerV2 = createGetTokenAccountsByOwnerV2({});
    await expect(getTokenAccountsByOwnerV2('owner')).rejects.toThrow(/does not provide getTokenAccountsByOwnerV2/);
  });

  test('wraps rpc errors', async () => {
    const rpc = {
      getTokenAccountsByOwnerV2: () => ({
        send: jest.fn(async () => {
          throw new Error('kaput');
        }),
      }),
    };

    const getTokenAccountsByOwnerV2 = createGetTokenAccountsByOwnerV2(rpc);
    await expect(getTokenAccountsByOwnerV2('owner')).rejects.toThrow('getTokenAccountsByOwnerV2: failed to fetch accounts: kaput');
  });
});
