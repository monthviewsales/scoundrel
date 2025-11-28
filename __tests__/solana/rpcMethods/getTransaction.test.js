'use strict';

const { createGetTransaction } = require('../../../lib/solana/rpcMethods/getTransaction');

describe('createGetTransaction', () => {
  test('returns normalized transaction payload', async () => {
    const response = {
      value: {
        slot: 123,
        blockTime: 456,
        transaction: { message: { instructions: [] } },
        meta: { err: null },
      },
    };

    const rpc = {
      getTransaction: jest.fn(() => ({
        send: jest.fn(async () => response),
      })),
    };

    const getTransaction = createGetTransaction(rpc);
    const result = await getTransaction('sig123', { commitment: 'confirmed' });

    expect(rpc.getTransaction).toHaveBeenCalledWith('sig123', { commitment: 'confirmed' });
    expect(result).toEqual({
      signature: 'sig123',
      slot: 123,
      blockTime: 456,
      transaction: { message: { instructions: [] } },
      meta: { err: null },
      err: null,
      status: 'ok',
      raw: response.value,
    });
  });

  test('returns null when transaction missing', async () => {
    const rpc = {
      getTransaction: jest.fn(() => ({
        send: jest.fn(async () => ({ value: null })),
      })),
    };

    const getTransaction = createGetTransaction(rpc);
    const result = await getTransaction('sig-missing');

    expect(result).toBeNull();
  });

  test('throws when rpc method missing', async () => {
    expect(() => createGetTransaction({})).toThrow(/does not provide getTransaction/);
  });

  test('wraps rpc errors', async () => {
    const rpc = {
      getTransaction: () => ({
        send: jest.fn(async () => {
          throw new Error('rpc broke');
        }),
      }),
    };

    const getTransaction = createGetTransaction(rpc);
    await expect(getTransaction('sig')).rejects.toThrow(
      'getTransaction: failed to fetch transaction for sig: rpc broke'
    );
  });
});
