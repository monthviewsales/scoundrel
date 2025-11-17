const originalKey = process.env.OPENAI_API_KEY;

jest.mock('openai', () => {
  const mockCreate = jest.fn();
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    responses: { create: mockCreate }
  }));
  MockOpenAI.__mockCreate = mockCreate;
  return MockOpenAI;
});

describe('ai/client helpers', () => {
  let clientModule;
  let parseResponsesJSON;
  let callResponses;
  let OpenAI;

  beforeAll(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    clientModule = require('../ai/client');
    ({ parseResponsesJSON, callResponses } = clientModule);
    OpenAI = require('openai');
  });

  afterAll(() => {
    process.env.OPENAI_API_KEY = originalKey;
    jest.resetModules();
  });

  test('parseResponsesJSON prefers output_text', () => {
    const json = { hello: 'world' };
    const res = parseResponsesJSON({ output_text: JSON.stringify(json) });
    expect(res).toEqual(json);
  });

  test('parseResponsesJSON falls back to content array', () => {
    const json = { foo: 123 };
    const res = parseResponsesJSON({
      output: [
        { content: [{ text: JSON.stringify(json) }] }
      ]
    });
    expect(res).toEqual(json);
  });
});
