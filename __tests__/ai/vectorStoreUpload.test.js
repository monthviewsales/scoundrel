'use strict';

const fs = require('fs');
const path = require('path');

const mockSpawnWorkerDetached = jest.fn(() => ({
  pid: 12345,
  payloadFile: '/tmp/vector-upload.json',
}));

jest.mock('../../lib/warchest/workers/harness', () => ({
  spawnWorkerDetached: (...args) => mockSpawnWorkerDetached(...args),
}));

const { queueVectorStoreUpload } = require('../../lib/ai/vectorStoreUpload');

describe('vectorStoreUpload', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    mockSpawnWorkerDetached.mockClear();
  });

  test('uses command prefix for temp upload filenames', async () => {
    process.env = {
      ...originalEnv,
      WARLORDAI_VECTOR_STORE: 'vs-test',
      OPENAI_API_KEY: 'test-key',
    };

    const result = await queueVectorStoreUpload({
      source: 'autopsy',
      data: { hello: 'world' },
    });

    expect(result.queued).toBe(true);
    const base = path.basename(result.jsonPath);
    expect(base.startsWith('autopsy-')).toBe(true);
    expect(base.startsWith('warlordai-')).toBe(false);

    if (result.jsonPath && fs.existsSync(result.jsonPath)) {
      fs.unlinkSync(result.jsonPath);
    }
  });
});
