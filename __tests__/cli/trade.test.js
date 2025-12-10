'use strict';

jest.mock('../../lib/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../lib/warchest/workers/harness', () => ({
  forkWorkerWithPayload: jest.fn(() => Promise.resolve({ result: { txid: 'worker-txid' } })),
  buildWorkerEnv: jest.fn(() => ({})),
}));

const logger = require('../../lib/logger');
const { forkWorkerWithPayload } = require('../../lib/warchest/workers/harness');
const tradeCli = require('../../lib/cli/trade');

describe('trade CLI (worker-based)', () => {
  test('propagates txid from swap worker', async () => {
    await tradeCli('So11111111111111111111111111111111111111112', {
      wallet: 'alias',
      buy: 1,
    });

    expect(forkWorkerWithPayload).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('txid: worker-txid'));
  });
});
