'use strict';

jest.mock('../../lib/persist/jsonArtifacts', () => ({
  formatRunId: jest.fn(() => 'run-1'),
  getArtifactConfig: jest.fn(() => ({ saveRaw: false })),
  sanitizeSegment: jest.fn((value) => String(value)),
  writeJsonArtifact: jest.fn(),
}));

const { createInspectTransaction } = require('../../lib/txInspector/inspectTransaction');

describe('inspectTransaction', () => {
  test('normalizes a single transaction', async () => {
    const rpcMethods = {
      getTransaction: jest.fn().mockResolvedValue({
        signature: 'sig-1',
        slot: 10,
        blockTime: 123,
        status: 'ok',
        err: null,
        meta: {
          fee: 5000,
          preBalances: [1000, 2000],
          postBalances: [500, 2500],
        },
        transaction: {
          message: {
            accountKeys: ['owner1', 'owner2'],
          },
        },
        raw: { value: true },
      }),
    };

    const inspectTransaction = createInspectTransaction(rpcMethods);
    const summary = await inspectTransaction('sig-1');

    expect(summary).toEqual(expect.objectContaining({
      signature: 'sig-1',
      networkFeeLamports: 5000,
      networkFeeSol: 0.000005,
    }));
    expect(summary.solChanges).toHaveLength(2);
  });

  test('returns array for batched signatures', async () => {
    const rpcMethods = {
      getTransaction: jest.fn().mockResolvedValue([
        {
          signature: 'sig-1',
          slot: 10,
          blockTime: 123,
          status: 'ok',
          err: null,
          meta: {
            fee: 5000,
            preBalances: [1000],
            postBalances: [800],
          },
          transaction: {
            message: {
              accountKeys: ['owner1'],
            },
          },
          raw: {},
        },
        null,
      ]),
    };

    const inspectTransaction = createInspectTransaction(rpcMethods);
    const summaries = await inspectTransaction(['sig-1', 'sig-2']);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual(expect.objectContaining({ signature: 'sig-1' }));
    expect(summaries[1]).toBeNull();
  });

  test('returns empty array for empty batch', async () => {
    const rpcMethods = {
      getTransaction: jest.fn(),
    };

    const inspectTransaction = createInspectTransaction(rpcMethods);
    const summaries = await inspectTransaction([]);

    expect(summaries).toEqual([]);
    expect(rpcMethods.getTransaction).not.toHaveBeenCalled();
  });
});
