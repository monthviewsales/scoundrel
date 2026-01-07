'use strict';

const path = require('path');

const monitorWorker = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockTxMonitorWorker.js');
const { createHubCoordinator } = require('../../../lib/warchest/hubCoordinator');

describe('swap worker tx monitor handoff', () => {
  test('propagates swap context into monitor worker IPC', async () => {
    const monitorPayload = {
      txid: 'stub-txid',
      mint: 'So11111111111111111111111111111111111111112',
      side: 'buy',
    };

    const coordinator = createHubCoordinator({
      txMonitorWorkerPath: monitorWorker,
      lockPrefix: `test-${Date.now()}`,
    });

    const result = await coordinator.runTxMonitor(monitorPayload, {
      timeoutMs: 5000,
    });

    coordinator.close();

    expect(result.echoedPayload.txid).toBe('stub-txid');
    expect(result.echoedPayload.mint).toBe('So11111111111111111111111111111111111111112');
    expect(result.echoedPayload.side).toBe('buy');
  });
});
