'use strict';

const mockList = jest.fn();
const mockDelete = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  files: {
    list: mockList,
    delete: mockDelete,
  },
})));

jest.mock('../../../lib/warchest/workers/harness', () => ({
  createWorkerHarness: jest.fn(),
}));

const {
  runOpenaiFilePruneWorker,
} = require('../../../lib/warchest/workers/openaiFilePruneWorker');

function buildAsyncIterable(items) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) {
        yield item;
      }
    },
  };
}

describe('openaiFilePruneWorker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
  });

  test('deletes matching files by prefix and age', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const items = [
      { id: 'file-1', filename: 'autopsy-report.json', created_at: nowSec - 7200 },
      { id: 'file-2', filename: 'warlordai-autopsy-legacy.json', created_at: nowSec - 7200 },
      { id: 'file-3', filename: 'dossier-report.json', created_at: nowSec - 7200 },
      { id: 'file-4', filename: 'autopsy-recent.json', created_at: nowSec - 30 },
    ];

    mockList.mockReturnValue(buildAsyncIterable(items));
    mockDelete.mockResolvedValue({ deleted: true });

    const progress = jest.fn();
    const result = await runOpenaiFilePruneWorker(
      {
        prefix: 'autopsy',
        olderThanSeconds: 3600,
        purpose: 'assistants',
      },
      { progress }
    );

    expect(mockList).toHaveBeenCalledWith({
      limit: 10000,
      order: 'desc',
      purpose: 'assistants',
    });
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith('file-1');
    expect(mockDelete).toHaveBeenCalledWith('file-2');
    expect(result).toEqual(expect.objectContaining({ matched: 2, deleted: 2 }));
    expect(progress).toHaveBeenCalledWith(
      'openai-fileprune:found',
      expect.objectContaining({ total: 2 })
    );
  });
});
