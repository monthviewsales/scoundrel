'use strict';

const mockRunTuneStrategy = jest.fn();
const mockCreateCommandRun = jest.fn();
const mockWriteArtifact = jest.fn();
const mockCreateInterface = jest.fn();

jest.mock('../../ai/jobs/tuneStrategy', () => ({
  runTuneStrategy: (...args) => mockRunTuneStrategy(...args),
}));

jest.mock('../../lib/cli/aiRun', () => ({
  createCommandRun: (...args) => mockCreateCommandRun(...args),
}));

jest.mock('readline', () => ({
  createInterface: (...args) => mockCreateInterface(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteArtifact.mockImplementation((_stage, prefix) => `/tmp/tune/${prefix}.json`);
  mockCreateCommandRun.mockReturnValue({
    runId: 'run-1',
    isDev: false,
    artifacts: { write: mockWriteArtifact },
  });
});

test('tuneStrategy runs interactive chat and writes artifacts', async () => {
  const responses = ['How should I tighten stops?', ':exit'];
  const mockRl = {
    question: jest.fn((prompt, cb) => cb(responses.shift())),
    close: jest.fn(),
  };
  mockCreateInterface.mockReturnValue(mockRl);

  mockRunTuneStrategy.mockResolvedValue({
    answer: 'Consider tighter trailing stops after 2x.',
    bullets: ['Lower trailing activation to 1.8x.'],
    actions: ['Review flash strategy stop windows.'],
    questions: [],
    changes: {},
    patch: [],
    risks: [],
    rationale: '',
  });

  const tuneStrategy = require('../../lib/cli/tuneStrategy');
  await tuneStrategy({ strategyName: 'flash' });

  expect(mockCreateCommandRun).toHaveBeenCalledWith(expect.objectContaining({
    command: 'tune-strategy',
    segments: ['flash'],
  }));

  expect(mockRunTuneStrategy).toHaveBeenCalledWith(expect.objectContaining({
    question: 'How should I tighten stops?',
    history: [],
  }));

  expect(mockWriteArtifact).toHaveBeenCalledWith('prompt', 'prompt-1', expect.any(Object));
  expect(mockWriteArtifact).toHaveBeenCalledWith('response', 'response-1', expect.any(Object));
  expect(mockRl.close).toHaveBeenCalled();
});
