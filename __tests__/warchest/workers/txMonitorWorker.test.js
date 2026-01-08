'use strict';

jest.mock('../../../lib/services/txInsightService', () => ({
  recoverSwapInsightFromTransaction: jest.fn(async () => ({ foo: 'bar' })),
}));

jest.mock('../../../db', () => ({
  init: jest.fn(async () => {}),
  recordScTradeEvent: jest.fn(async () => ({})),
}));

jest.mock('../../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(),
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
const BootyBox = require('../../../db');
const { createSolanaTrackerDataClient } = require('../../../lib/solanaTrackerDataClient');

function makeTxid() {
  return 'CyRxoFDzBHtuD6PcE83H1SUtCqFkcApDTBJpnZpX9BSgVtN3FdZkRqQUWgimYGPzBX7SbseZxWSnjEvGz5eoQA5';
}

function makeHudPath() {
  return path.join(os.tmpdir(), `hud-events-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

describe('txMonitorWorker.monitorTransaction', () => {
  beforeEach(() => {
    txInsightService.recoverSwapInsightFromTransaction.mockClear();
    appendHubEvent.mockClear();
    BootyBox.init.mockClear();
    BootyBox.recordScTradeEvent.mockClear();
    createSolanaTrackerDataClient.mockReset();
  });

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

  test('falls back to SOL/USD price fetch when quote lacks it', async () => {
    const hudPath = makeHudPath();
    const unsubscribe = jest.fn();
    const rpcMethods = {
      subscribeLogs: jest.fn(async (_filter, onUpdate) => {
        onUpdate({ value: { signature: makeTxid(), err: null }, context: { slot: 11 } });
        return { unsubscribe };
      }),
      getTransaction: jest.fn(),
    };

    txInsightService.recoverSwapInsightFromTransaction.mockResolvedValue({
      mint: 'Mint111111111111111111111111111111111111111',
      tokenDeltaNet: 100,
      solDeltaNet: -1,
      executedAt: Date.now(),
    });

    createSolanaTrackerDataClient.mockReturnValue({
      getMultipleTokenPrices: jest.fn().mockResolvedValue({
        So11111111111111111111111111111111111111112: { price: 123.45 },
      }),
    });

    const result = await monitorTransaction(
      {
        txid: makeTxid(),
        walletId: 42,
        wallet: 'wallet123',
        mint: 'Mint111111111111111111111111111111111111111',
        side: 'buy',
        size: 1,
        hudEventPath: hudPath,
        swapQuote: {},
      },
      {
        rpcMethods,
      }
    );

    expect(result.status).toBe('confirmed');
    expect(BootyBox.recordScTradeEvent).toHaveBeenCalled();
    const trade = BootyBox.recordScTradeEvent.mock.calls[0][0];
    expect(trade.solUsdPrice).toBe(123.45);
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
