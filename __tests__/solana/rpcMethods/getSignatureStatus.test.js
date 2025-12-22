'use strict';

const { createGetSignatureStatus } = require('../../../lib/solana/rpcMethods/getSignatureStatus');

describe('createGetSignatureStatus', () => {
  test('returns normalized signature status', async () => {
    const rpc = {
      getSignatureStatuses: jest.fn(() => ({
        send: jest.fn(async () => ({
          value: [
            {
              confirmationStatus: 'confirmed',
              err: null,
              slot: 77,
            },
          ],
        })),
      })),
    };

    const getSignatureStatus = createGetSignatureStatus(rpc);
    const result = await getSignatureStatus('sig123');

    expect(rpc.getSignatureStatuses).toHaveBeenCalledWith(['sig123'], {
      searchTransactionHistory: true,
    });
    expect(result).toEqual({
      signature: 'sig123',
      confirmationStatus: 'confirmed',
      err: null,
      slot: 77,
      raw: {
        confirmationStatus: 'confirmed',
        err: null,
        slot: 77,
      },
    });
  });

  test('returns null when status missing', async () => {
    const rpc = {
      getSignatureStatuses: jest.fn(() => ({
        send: jest.fn(async () => ({ value: [null] })),
      })),
    };

    const getSignatureStatus = createGetSignatureStatus(rpc);
    const result = await getSignatureStatus('sig-missing');

    expect(result).toBeNull();
  });

  test('throws when rpc method missing', async () => {
    expect(() => createGetSignatureStatus({})).toThrow(/does not provide getSignatureStatuses/);
  });
});
