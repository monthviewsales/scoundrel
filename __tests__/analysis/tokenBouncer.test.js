'use strict';

const fs = require('fs');
const path = require('path');

const { bounceTokens } = require('../../lib/analysis/tokenBouncer');

const fixturePath = path.join(__dirname, '..', '__fixtures__', 'badTokensSample.json');

describe('tokenBouncer', () => {
  test('rejects all tokens in badTokensSample', () => {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const payload = JSON.parse(raw);
    const logger = { info: jest.fn() };

    const result = bounceTokens(payload, { logger });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledTimes(3);
    for (const call of logger.info.mock.calls) {
      expect(call[0]).toMatch(/BOUNCED!/);
    }
  });
});
