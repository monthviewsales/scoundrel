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
    delete process.env.DB_ENGINE;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('defaults to sqlite adapter', () => {
    delete process.env.DB_ENGINE;

    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../db/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
    expect(BootyBox.engine).toBe('sqlite');
  });

  test('falls back to sqlite on unknown engine', () => {
    process.env.DB_ENGINE = 'postgres';

    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../db/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
  });
});
