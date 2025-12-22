'use strict';

const { createFetchSignatureDiagnostics } = require('../../../lib/solana/rpcMethods/internal/fetchSignatureDiagnostics');

describe('createFetchSignatureDiagnostics', () => {
  test('returns signature status and tx meta diagnostics', async () => {
    const rpc = {
      getSignatureStatuses: jest.fn(() => ({
        send: jest.fn(async () => ({
          value: [
            {
              confirmationStatus: 'confirmed',
              err: null,
              slot: 88,
            },
          ],
        })),
      })),
      getTransaction: jest.fn(() => ({
        send: jest.fn(async () => ({
          value: {
            slot: 99,
            meta: { err: null, fee: 5000, logMessages: ['a', 'b', 'c'] },
          },
        })),
      })),
    };

    const fetchSignatureDiagnostics = createFetchSignatureDiagnostics(rpc);
    const result = await fetchSignatureDiagnostics('sig123');

    expect(result.signatureStatus).toEqual({
      confirmationStatus: 'confirmed',
      err: null,
      slot: 88,
    });
    expect(result.txMeta).toEqual({
      err: null,
      fee: 5000,
      logMessages: ['a', 'b', 'c'],
    });
  });

  test('surfaces rpc errors in diagnostics', async () => {
    const rpc = {
      getSignatureStatuses: jest.fn(() => ({
        send: jest.fn(async () => {
          throw new Error('status offline');
        }),
      })),
      getTransaction: jest.fn(() => ({
        send: jest.fn(async () => {
          throw new Error('tx offline');
        }),
      })),
    };

    const fetchSignatureDiagnostics = createFetchSignatureDiagnostics(rpc);
    const result = await fetchSignatureDiagnostics('sig456');

    expect(result.signatureStatus).toBeUndefined();
    expect(result.txMeta).toBeUndefined();
    expect(result.signatureStatusError).toMatch(/status offline/);
    expect(result.txMetaError).toMatch(/tx offline/);
  });
});
