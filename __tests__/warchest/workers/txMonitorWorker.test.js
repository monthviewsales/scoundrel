'use strict';

jest.mock('../../../lib/services/txInsightService', () => ({
  recoverSwapInsightFromTransaction: jest.fn(async () => ({ foo: 'bar' })),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { monitorTransaction } = require('../../../lib/warchest/workers/txMonitorWorker');
const txInsightService = require('../../../lib/services/txInsightService');

function makeTxid() {
  return 'So11111111111111111111111111111111111111112';
}

describe('txMonitorWorker.monitorTransaction', () => {
  test('resolves via log subscription and writes HUD event', async () => {
    const hudPath = path.join(os.tmpdir(), `hud-events-${Date.now()}.json`);
    const unsubscribe = jest.fn();
    const rpcMethods = {
      subscribeLogs: jest.fn(async (_filter, onUpdate) => {
        onUpdate({ value: { signature: makeTxid(), err: null }, context: { slot: 77 } });
        return { unsubscribe };
      }),
      getTransaction: jest.fn(),
    };

    const tracked = [];
    const result = await monitorTransaction(
      {
        txid: makeTxid(),
        wallet: 'wallet123',
        mint: 'Mint111111111111111111111111111111111111111',
        side: 'buy',
        size: 1,
        hudEventPath: hudPath,
      },
      {
        rpcMethods,
        track: (res) => tracked.push(res),
      }
    );

    expect(result.status).toBe('confirmed');
    expect(result.slot).toBe(77);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(tracked[0]).toBeTruthy();
    expect(txInsightService.recoverSwapInsightFromTransaction).toHaveBeenCalledWith(
      makeTxid(),
      null,
      expect.objectContaining({ walletAddress: 'wallet123' })
    );

    const events = JSON.parse(fs.readFileSync(hudPath, 'utf8'));
    expect(events[0].txid).toBe(makeTxid());
    expect(events[0].context.side).toBe('buy');
    expect(events[0].insight).toEqual({ foo: 'bar' });
    expect(events[0].txSummary.statusEmoji).toBeDefined();
  });

  test('falls back to polling when logs are unavailable', async () => {
    const rpcMethods = {
      getTransaction: jest.fn().mockResolvedValue({
        slot: 5,
        status: 'err',
        err: { InstructionError: [0, 'custom'] },
      }),
    };

    const result = await monitorTransaction(
      { txid: makeTxid(), wallet: null, size: 'auto' },
      { rpcMethods }
    );

    expect(result.status).toBe('failed');
    expect(result.slot).toBe(5);
  });

  test('fails fast when transaction lookups keep failing', async () => {
    const rpcMethods = {
      getTransaction: jest.fn().mockRejectedValue(Object.assign(new Error('offline'), { code: 'EAI_AGAIN' })),
    };

    await expect(
      monitorTransaction({ txid: makeTxid(), wallet: null }, {
        rpcMethods,
        retryDelayFn: () => Promise.resolve(),
        retryOptions: { attempts: 2 },
      })
    ).rejects.toThrow(/Retry failed/);
    expect(rpcMethods.getTransaction).toHaveBeenCalledTimes(2);
  });
});
