'use strict';

function createMockContext(overrides = {}) {
  const log = overrides.log || {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const call = overrides.call || jest.fn((op, exec) => exec());
  const client = overrides.client || {};

  return { client, call, log };
}

module.exports = { createMockContext };
