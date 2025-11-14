'use strict';

const { createGetFirstAvailableBlock } = require('../../../lib/solana/rpcMethods/getFirstAvailableBlock');

describe('createGetFirstAvailableBlock', () => {
  test('resolves block slot number', async () => {
    const rpc = {
      getFirstAvailableBlock: jest.fn(() => ({
        send: jest.fn(async () => ({ value: 123456 })),
      })),
    };

    const getFirstAvailableBlock = createGetFirstAvailableBlock(rpc);
    await expect(getFirstAvailableBlock()).resolves.toBe(123456);
    expect(rpc.getFirstAvailableBlock).toHaveBeenCalledTimes(1);
  });

  test('throws when rpc missing method', async () => {
    const getFirstAvailableBlock = createGetFirstAvailableBlock({});
    await expect(getFirstAvailableBlock()).rejects.toThrow(/does not provide getFirstAvailableBlock/);
  });

  test('wraps rpc errors', async () => {
    const rpc = {
      getFirstAvailableBlock: () => ({
        send: jest.fn(async () => {
          throw new Error('offline');
        }),
      }),
    };

    const getFirstAvailableBlock = createGetFirstAvailableBlock(rpc);
    await expect(getFirstAvailableBlock()).rejects.toThrow('getFirstAvailableBlock: failed to fetch block: offline');
  });
});
