'use strict';

const mockCreateCommandRun = jest.fn();
const mockWrite = jest.fn();

jest.mock('../../lib/cli/aiRun', () => ({
  createCommandRun: (...args) => mockCreateCommandRun(...args),
}));

describe('analysisFlow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWrite.mockImplementation((_stage, prefix) => `/tmp/${prefix}.json`);
    mockCreateCommandRun.mockReturnValue({
      runId: 'run-123',
      isDev: false,
      artifacts: { write: mockWrite },
    });
  });

  test('runs build, analyze, and persist with artifacts', async () => {
    const { createAnalysisFlow } = require('../../lib/cli/analysisFlow');

    const build = jest.fn(async ({ createArtifacts }) => {
      const run = createArtifacts(['alpha']);
      expect(run.runId).toBe('run-123');
      return { payload: { ok: true } };
    });
    const analyze = jest.fn(async () => ({ result: 'ok' }));
    const persist = jest.fn(async () => {});

    const runFlow = createAnalysisFlow({
      command: 'alpha',
      build,
      analyze,
      persist,
    });

    const result = await runFlow({});

    expect(build).toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ payload: { ok: true } }));
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ analysis: { result: 'ok' } }));
    expect(mockWrite).toHaveBeenCalledWith('prompt', 'prompt', { ok: true });
    expect(mockWrite).toHaveBeenCalledWith('response', 'response', { result: 'ok' });
    expect(result.promptPath).toBe('/tmp/prompt.json');
    expect(result.responsePath).toBe('/tmp/response.json');
  });

  test('skips analysis when runAnalysis=false', async () => {
    const { createAnalysisFlow } = require('../../lib/cli/analysisFlow');

    const build = jest.fn(async ({ createArtifacts }) => {
      createArtifacts(['alpha']);
      return { payload: { ok: true } };
    });
    const analyze = jest.fn();
    const persist = jest.fn();

    const runFlow = createAnalysisFlow({
      command: 'alpha',
      build,
      analyze,
      persist,
    });

    const result = await runFlow({ runAnalysis: false });

    expect(analyze).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(result.analysis).toBeNull();
    expect(mockWrite).toHaveBeenCalledWith('prompt', 'prompt', { ok: true });
  });

  test('skips analysis when build sets runAnalysis=false', async () => {
    const { createAnalysisFlow } = require('../../lib/cli/analysisFlow');

    const build = jest.fn(async ({ createArtifacts }) => {
      createArtifacts(['alpha']);
      return { payload: null, runAnalysis: false, promptPath: null };
    });
    const analyze = jest.fn();

    const runFlow = createAnalysisFlow({
      command: 'alpha',
      build,
      analyze,
    });

    const result = await runFlow({});

    expect(analyze).not.toHaveBeenCalled();
    expect(result.analysis).toBeNull();
    expect(result.promptPath).toBeNull();
  });
});
