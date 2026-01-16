'use strict';

describe('BootyBox migrations', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('warns and skips when sqlite is missing', async () => {
    const logger = { warn: jest.fn(), info: jest.fn() };
    const { runMigrations } = require('../migrations');

    await runMigrations({ sqlite: null, logger });

    expect(logger.warn).toHaveBeenCalledWith(
      '[BootyBox:migrations] SQLite db not provided, skipping migrations'
    );
  });

  test('applies pending migrations and records them', async () => {
    const mockFs = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['001_test.sql']),
      readFileSync: jest.fn().mockReturnValue('SELECT 1;'),
    };
    jest.doMock('fs', () => mockFs);

    const exec = jest.fn();
    const insertRun = jest.fn();
    const prepare = jest.fn((sql) => {
      if (sql.includes('SELECT name')) {
        return { all: () => [] };
      }
      if (sql.includes('INSERT INTO bootybox_migrations')) {
        return { run: insertRun };
      }
      return { all: () => [] };
    });
    const sqlite = { exec, prepare };
    const logger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    let runMigrations;
    jest.isolateModules(() => {
      ({ runMigrations } = require('../migrations'));
    });

    await runMigrations({ sqlite, logger });

    expect(mockFs.readdirSync).toHaveBeenCalled();
    expect(mockFs.readFileSync).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS'));
    expect(exec).toHaveBeenCalledWith('BEGIN');
    expect(exec).toHaveBeenCalledWith('COMMIT');
    expect(insertRun).toHaveBeenCalledWith('001_test.sql', expect.any(Number));
  });
});
