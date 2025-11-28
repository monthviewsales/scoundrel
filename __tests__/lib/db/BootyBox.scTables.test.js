'use strict';

jest.mock('../../../packages/BootyBox/src/adapters/mysql', () => ({
  engine: 'mysql',
  init: jest.fn(),
}));

jest.mock('../../../packages/BootyBox/src/adapters/sqlite', () => ({
  engine: 'sqlite',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
}));

describe('BootyBox adapter selection (sqlite)', () => {
  const loadBootyBox = () => {
    jest.resetModules();
    return require('../../../packages/BootyBox');
  };

  afterEach(() => {
    delete process.env.DB_ENGINE;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('defaults to sqlite adapter', () => {
    delete process.env.DB_ENGINE;

    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../packages/BootyBox/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
    expect(BootyBox.engine).toBe('sqlite');
  });

  test('falls back to sqlite and warns on unknown engine', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DB_ENGINE = 'postgres';

    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../packages/BootyBox/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      '[BootyBox] Unknown DB_ENGINE "postgres", defaulting to sqlite'
    );
    warnSpy.mockRestore();
  });
});
