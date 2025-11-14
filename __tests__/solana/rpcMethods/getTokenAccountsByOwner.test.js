'use strict';

const { createGetTokenAccountsByOwner } = require('../../../lib/solana/rpcMethods/getTokenAccountsByOwner');

function createRpc(response) {
  return {
    getTokenAccountsByOwner: jest.fn(() => ({
      send: jest.fn(async () => response),
    })),
  };
}

describe('createGetTokenAccountsByOwner', () => {
  test('normalizes account entries', async () => {
    const response = {
      value: [
        {
          pubkey: 'TokenAccountPubkey',
          account: {
            data: {
              parsed: {
                info: {
                  mint: 'MintPubkey',
                  owner: 'WalletPubkey',
                  tokenAmount: {
                    amount: '12345',
                    decimals: 3,
                  },
                },
              },
            },
          },
        },
      ],
    };

    const rpc = createRpc(response);
    const getTokenAccountsByOwner = createGetTokenAccountsByOwner(rpc);

    const { accounts } = await getTokenAccountsByOwner('WalletPubkey');

    expect(rpc.getTokenAccountsByOwner).toHaveBeenCalledWith('WalletPubkey', {});
    expect(accounts).toEqual([
      expect.objectContaining({
        pubkey: 'TokenAccountPubkey',
        mint: 'MintPubkey',
        owner: 'WalletPubkey',
        uiAmount: 12.345,
        decimals: 3,
        amountRaw: '12345',
      }),
    ]);
  });

  test('supports alternate response shapes', async () => {
    const response = [
      {
        account: {
          data: {
            parsed: {
              info: {
                mint: 'Mint',
                owner: 'Owner',
                tokenAmount: {
                  uiAmount: 5.5,
                  decimals: 2,
                },
              },
            },
          },
        },
      },
    ];

    const rpc = {
      getTokenAccountsByOwner: jest.fn(() => response),
    };

    const getTokenAccountsByOwner = createGetTokenAccountsByOwner(rpc);
    const { accounts } = await getTokenAccountsByOwner('Owner');

    expect(accounts[0]).toEqual(expect.objectContaining({
      mint: 'Mint',
      owner: 'Owner',
      uiAmount: 5.5,
      decimals: 2,
    }));
  });

  test('throws on rpc method missing', async () => {
    const getTokenAccountsByOwner = createGetTokenAccountsByOwner({});
    await expect(getTokenAccountsByOwner('x')).rejects.toThrow(/does not provide getTokenAccountsByOwner/);
  });

  test('wraps rpc failures', async () => {
    const rpc = {
      getTokenAccountsByOwner: () => ({
        send: jest.fn(async () => {
          throw new Error('boom');
        }),
      }),
    };

    const getTokenAccountsByOwner = createGetTokenAccountsByOwner(rpc);
    await expect(getTokenAccountsByOwner('wallet')).rejects.toThrow('getTokenAccountsByOwner: failed to fetch accounts: boom');
  });
});
