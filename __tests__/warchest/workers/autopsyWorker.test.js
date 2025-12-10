'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const workerPath = path.join(__dirname, '..', '..', '..', 'lib', 'warchest', 'workers', 'autopsyWorker.js');
const mockRunner = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockAutopsyRunner.js');
const mockClientFactory = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'warchest',
  'mockAutopsyClientFactory.js'
);

// eslint-disable-next-line global-require
const { forkWorkerWithPayload } = require('../../../lib/warchest/workers/harness');
// eslint-disable-next-line global-require
const { validateAutopsyPayload } = require('../../../lib/warchest/workers/autopsyWorker');

describe('autopsy worker payload validation', () => {
  test('requires wallet and mint', () => {
    expect(() => validateAutopsyPayload({ mint: 'm' })).toThrow(/walletAddress/);
    expect(() => validateAutopsyPayload({ walletAddress: 'w' })).toThrow(/mint/);
  });

  test('passes through optional label', () => {
    const res = validateAutopsyPayload({ walletAddress: 'w', mint: 'm', walletLabel: ' Label ' });
    expect(res.walletLabel).toBe('Label');
  });
});

describe('autopsy worker orchestration', () => {
  test('routes payloads to runner and closes clients', async () => {
    const payloadLog = path.join(os.tmpdir(), `autopsy-worker-log-${Date.now()}.json`);
    const closeLog = path.join(os.tmpdir(), `autopsy-client-close-${Date.now()}.log`);

    const { result } = await forkWorkerWithPayload(workerPath, {
      payload: { walletAddress: 'wallet111', mint: 'mint222', walletLabel: 'Label' },
      env: {
        AUTOPSY_WORKER_RUNNER: mockRunner,
        AUTOPSY_WORKER_CLIENT_FACTORY: mockClientFactory,
        AUTOPSY_WORKER_LOG: payloadLog,
        AUTOPSY_CLIENT_LOG: closeLog,
      },
      timeoutMs: 4000,
    });

    const logged = JSON.parse(fs.readFileSync(payloadLog, 'utf8'));
    expect(logged.payload.walletAddress).toBe('wallet111');
    expect(result.ai.verdict).toBe('ok');
    expect(result.artifactPath).toContain('mock-autopsy');
    expect(fs.readFileSync(closeLog, 'utf8')).toBe('closed');
  });
});
