'use strict';

const { createGetSolBalance } = require('../../../lib/solana/rpcMethods/getSolBalance');

describe('createGetSolBalance', () => {
  function createRpcMock(response) {
    const send = jest.fn(async () => response);
    const request = { send };
    const getBalance = jest.fn(() => request);
    return { getBalance, send };
  }

  test('returns SOL balance when rpc returns lamports in value field', async () => {
    const rpcMock = createRpcMock({ value: 2_000_000_000 });
    const getSolBalance = createGetSolBalance({ getBalance: rpcMock.getBalance });

    const balance = await getSolBalance('ExamplePubkey');

    expect(balance).toBeCloseTo(2);
    expect(rpcMock.getBalance).toHaveBeenCalledWith('ExamplePubkey');
    expect(rpcMock.send).toHaveBeenCalled();
  });

  test('handles direct lamport number response', async () => {
    const getSolBalance = createGetSolBalance({
      getBalance: () => 500_000_000,
    });

    const balance = await getSolBalance('AnotherPubkey');

    expect(balance).toBeCloseTo(0.5);
  });

  test('throws when rpc client is missing getBalance', async () => {
    const getSolBalance = createGetSolBalance({});

    await expect(getSolBalance('abc')).rejects.toThrow(/does not provide getBalance/);
  });

  test('wraps rpc errors with helpful context', async () => {
    const rpc = {
      getBalance: () => ({
        send: jest.fn(async () => {
          throw new Error('network down');
        }),
      }),
    };
    const getSolBalance = createGetSolBalance(rpc);

    await expect(getSolBalance('pub')).rejects.toThrow('getSolBalance: failed to fetch balance: network down');
  });
});
