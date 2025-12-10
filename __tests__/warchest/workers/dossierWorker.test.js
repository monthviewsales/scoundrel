'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const workerPath = path.join(__dirname, '..', '..', '..', 'lib', 'warchest', 'workers', 'dossierWorker.js');
const mockRunner = path.join(__dirname, '..', '..', 'fixtures', 'warchest', 'mockDossierRunner.js');

// eslint-disable-next-line global-require
const { forkWorkerWithPayload } = require('../../../lib/warchest/workers/harness');
// eslint-disable-next-line global-require
const { validateDossierPayload } = require('../../../lib/warchest/workers/dossierWorker');

describe('dossier worker payload validation', () => {
  test('requires a wallet', () => {
    expect(() => validateDossierPayload({})).toThrow(/wallet/);
  });

  test('normalizes optional fields', () => {
    const res = validateDossierPayload({
      wallet: 'abc',
      traderName: ' T ',
      startTime: '1',
      endTime: 2,
      limit: '3',
      concurrency: '4',
      includeOutcomes: 'true',
      featureMintCount: '5',
      runAnalysis: 'false',
    });

    expect(res).toMatchObject({
      wallet: 'abc',
      traderName: 'T',
      startTime: 1,
      endTime: 2,
      limit: 3,
      concurrency: 4,
      includeOutcomes: true,
      featureMintCount: 5,
      runAnalysis: false,
    });
  });
});

describe('dossier worker orchestration', () => {
  test('forwards payloads to the runner and returns AI result', async () => {
    const logPath = path.join(os.tmpdir(), `dossier-worker-log-${Date.now()}.json`);

    const { result } = await forkWorkerWithPayload(workerPath, {
      payload: { wallet: 'wallet123', traderName: 'Trader' },
      env: {
        DOSSIER_WORKER_RUNNER: mockRunner,
        DOSSIER_WORKER_LOG: logPath,
      },
      timeoutMs: 4000,
    });

    const logged = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(logged.wallet).toBe('wallet123');
    expect(result.openAiResult.version).toBe('dossier.test');
    expect(result.merged.meta.wallet).toBe('wallet123');
  });
});
