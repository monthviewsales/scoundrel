'use strict';

jest.mock('../../../db/src/adapters/sqlite', () => ({
  engine: 'sqlite',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
}));

describe('BootyBox adapter selection (sqlite)', () => {
  const loadBootyBox = () => {
    jest.resetModules();
    return require('../../../db');
  };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('defaults to sqlite adapter', () => {
    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../db/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
    expect(BootyBox.engine).toBe('sqlite');
  });

  test('always loads sqlite adapter', () => {
    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../db/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
  });
});
