'use strict';

jest.mock('../../../lib/services/txInsightService', () => ({
  recoverSwapInsightFromTransaction: jest.fn(async () => ({ foo: 'bar' })),
}));

const os = require('os');
const path = require('path');

jest.mock('../../../lib/warchest/events', () => ({
  appendHubEvent: jest.fn(),
  DEFAULT_EVENT_PATH: '/tmp/mock-events.json',
}));

const { monitorTransaction } = require('../../../lib/warchest/workers/txMonitorWorker');
const txInsightService = require('../../../lib/services/txInsightService');
const { appendHubEvent } = require('../../../lib/warchest/events');

function makeTxid() {
  return 'CyRxoFDzBHtuD6PcE83H1SUtCqFkcApDTBJpnZpX9BSgVtN3FdZkRqQUWgimYGPzBX7SbseZxWSnjEvGz5eoQA5';
}

function makeHudPath() {
  return path.join(os.tmpdir(), `hud-events-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

describe('txMonitorWorker.monitorTransaction', () => {
  test('resolves via log subscription and writes HUD event', async () => {
    const hudPath = makeHudPath();
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
    expect(appendHubEvent).toHaveBeenCalledTimes(1);
    const eventPayload = appendHubEvent.mock.calls[0][0];
    expect(eventPayload.txid).toBe(makeTxid());
    expect(eventPayload.context.side).toBe('buy');
    expect(eventPayload.insight).toEqual({ foo: 'bar' });
    expect(eventPayload.txSummary.statusEmoji).toBeDefined();
  });

  test('falls back to polling when logs are unavailable', async () => {
    const hudPath = makeHudPath();
    const rpcMethods = {
      getTransaction: jest.fn().mockResolvedValue({
        slot: 5,
        status: 'err',
        err: { InstructionError: [0, 'custom'] },
      }),
    };

    const result = await monitorTransaction(
      { txid: makeTxid(), wallet: null, size: 'auto', hudEventPath: hudPath },
      { rpcMethods }
    );

    expect(result.status).toBe('failed');
    expect(result.slot).toBe(5);
    expect(result.errorSummary).toBeTruthy();
    expect(result.errorSummary.kind).toBe('instruction_error');
  });

  test('fails fast when transaction lookups keep failing', async () => {
    const hudPath = makeHudPath();
    const rpcMethods = {
      getTransaction: jest.fn().mockRejectedValue(Object.assign(new Error('offline'), { code: 'EAI_AGAIN' })),
    };

    await expect(
      monitorTransaction({ txid: makeTxid(), wallet: null, hudEventPath: hudPath }, {
        rpcMethods,
        retryDelayFn: () => Promise.resolve(),
        retryOptions: { attempts: 2 },
      })
    ).rejects.toThrow(/Retry failed/);
    expect(rpcMethods.getTransaction).toHaveBeenCalledTimes(2);
  });
});
