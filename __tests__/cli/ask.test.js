'use strict';

jest.mock('../../ai/warlordAI', () => ({
  runTask: jest.fn(),
}));

jest.mock('../../db', () => ({
  init: jest.fn(),
  recordAsk: jest.fn(),
}));

jest.mock('../../lib/id/issuer', () => ({
  requestId: jest.fn(),
}));

const { runTask } = require('../../ai/warlordAI');
const BootyBox = require('../../db');
const { requestId } = require('../../lib/id/issuer');

describe('ask CLI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires a question', async () => {
    const ask = require('../../lib/cli/ask');
    await expect(ask({})).rejects.toThrow('[ask] question (string) is required');
  });

  test('persists asks and formats bullets/actions', async () => {
    requestId.mockResolvedValue('ask_0000000000000000000000000001');
    runTask.mockResolvedValue({
      answer: 'Hello there',
      bullets: ['One', 'Two'],
      actions: ['Follow up'],
    });
    BootyBox.init.mockResolvedValue();
    BootyBox.recordAsk.mockResolvedValue();

    const rows = Array.from({ length: 201 }, (_, idx) => ({ id: idx }));
    const ask = require('../../lib/cli/ask');
    const result = await ask({
      question: '  Hello   there ',
      profile: { handle: 'tester' },
      rows,
    });

    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      task: 'ask',
      payload: expect.objectContaining({
        question: 'Hello there',
        profile: { handle: 'tester' },
      }),
    }));
    const payloadRows = runTask.mock.calls[0][0].payload.rows;
    expect(payloadRows).toHaveLength(200);
    expect(BootyBox.recordAsk).toHaveBeenCalled();
    expect(result).toContain('Hello there');
    expect(result).toContain('• One');
    expect(result).toContain('Next actions:');
  });

  test('returns answer when persistence fails', async () => {
    requestId.mockResolvedValue('ask_0000000000000000000000000002');
    runTask.mockResolvedValue({ answer: 'ok' });
    BootyBox.init.mockResolvedValue();
    BootyBox.recordAsk.mockRejectedValue(new Error('db down'));

    const ask = require('../../lib/cli/ask');
    const result = await ask({ question: 'hi' });

    expect(result).toBe('ok');
    expect(BootyBox.recordAsk).toHaveBeenCalled();
  });
});
