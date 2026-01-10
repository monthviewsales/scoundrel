'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockFilesCreate = jest.fn();
const mockFileBatchesCreate = jest.fn();
const mockVectorStoreFilesCreate = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  files: { create: mockFilesCreate },
  vectorStores: {
    fileBatches: { create: mockFileBatchesCreate },
    files: { create: mockVectorStoreFilesCreate },
  },
})));

const OpenAI = require('openai');
const { runVectorStoreWorker } = require('../../../lib/warchest/workers/vectorStoreWorker');

function writeTempJson(payload = { hello: 'world' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-'));
  const jsonPath = path.join(dir, 'payload.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
  return { dir, jsonPath };
}

describe('vectorStoreWorker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('skips when vector store id is missing', async () => {
    const { dir, jsonPath } = writeTempJson();
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.WARLORDAI_VECTOR_STORE;

    const result = await runVectorStoreWorker({ jsonPath, source: 'unit' });

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'missing_vector_store', source: 'unit' }));
    expect(OpenAI).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('skips when OpenAI api key is missing', async () => {
    const { dir, jsonPath } = writeTempJson();
    process.env.WARLORDAI_VECTOR_STORE = 'vs-test';
    delete process.env.OPENAI_API_KEY;

    const result = await runVectorStoreWorker({ jsonPath, source: 'unit' });

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'missing_openai_key', source: 'unit' }));
    expect(OpenAI).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('throws when jsonPath is missing or invalid', async () => {
    process.env.WARLORDAI_VECTOR_STORE = 'vs-test';
    process.env.OPENAI_API_KEY = 'test-key';

    await expect(runVectorStoreWorker({ jsonPath: '/tmp/does-not-exist.json' }))
      .rejects
      .toThrow('jsonPath is required and must exist');
  });

  test('uploads to vector store and cleans up jsonPath', async () => {
    const { dir, jsonPath } = writeTempJson({ payload: true });
    process.env.WARLORDAI_VECTOR_STORE = 'vs-test';
    process.env.OPENAI_API_KEY = 'test-key';

    mockFilesCreate.mockResolvedValue({ id: 'file-123' });
    mockFileBatchesCreate.mockResolvedValue({});
    const mockStream = require('stream').Readable.from(['{}']);
    const readStreamSpy = jest.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);

    const result = await runVectorStoreWorker({
      jsonPath,
      cleanupPath: true,
      source: 'unit',
      name: 'payload.json',
    });

    expect(result).toEqual(expect.objectContaining({
      vectorStoreId: 'vs-test',
      fileId: 'file-123',
      source: 'unit',
      name: 'payload.json',
    }));
    expect(mockFilesCreate).toHaveBeenCalled();
    expect(mockFileBatchesCreate).toHaveBeenCalledWith('vs-test', { file_ids: ['file-123'] });
    expect(fs.existsSync(jsonPath)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
    readStreamSpy.mockRestore();
  });
});
