'use strict';

const { createGetMultipleAccounts } = require('../../../lib/solana/rpcMethods/getMultipleAccounts');

describe('createGetMultipleAccounts', () => {
  test('normalizes account responses', async () => {
    const response = {
      value: [
        {
          pubkey: 'Account1',
          account: {
            lamports: 123,
            owner: 'Owner1',
            executable: false,
            rentEpoch: 88,
            data: ['deadbeef', 'base64'],
          },
        },
        null,
      ],
    };

    const rpc = {
      getMultipleAccounts: jest.fn(() => ({
        send: jest.fn(async () => response),
      })),
    };

    const getMultipleAccounts = createGetMultipleAccounts(rpc);
    const result = await getMultipleAccounts(['Account1', 'Account2']);

    expect(result.accounts).toEqual([
      expect.objectContaining({
        pubkey: 'Account1',
        lamports: 123,
        owner: 'Owner1',
        executable: false,
        rentEpoch: 88,
        data: ['deadbeef', 'base64'],
      }),
      expect.objectContaining({
        pubkey: 'Account2',
        lamports: null,
      }),
    ]);
  });

  test('throws for empty pubkeys array', async () => {
    const getMultipleAccounts = createGetMultipleAccounts({ getMultipleAccounts: jest.fn() });
    await expect(getMultipleAccounts([])).rejects.toThrow(/non-empty array/);
  });

  test('throws when rpc method missing', async () => {
    const getMultipleAccounts = createGetMultipleAccounts({});
    await expect(getMultipleAccounts(['abc'])).rejects.toThrow(/does not provide getMultipleAccounts/);
  });

  test('wraps rpc errors', async () => {
    const rpc = {
      getMultipleAccounts: () => ({
        send: jest.fn(async () => {
          throw new Error('rpc nope');
        }),
      }),
    };

    const getMultipleAccounts = createGetMultipleAccounts(rpc);
    await expect(getMultipleAccounts(['abc'])).rejects.toThrow('getMultipleAccounts: failed to fetch accounts: rpc nope');
  });
});
