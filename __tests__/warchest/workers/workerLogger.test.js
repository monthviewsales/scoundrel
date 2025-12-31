'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const baseLogger = require('../../../lib/logger');
const { createWorkerLogger } = require('../../../lib/warchest/workers/workerLogger');

const waitForWrite = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('workerLogger', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-worker-logs-'));
  });

  test('creates worker log file', async () => {
    const logger = createWorkerLogger({
      workerName: 'unit-worker',
      logDir: tmpDir,
      silentConsole: true,
      baseLogger,
    });

    logger.info('hello');
    await waitForWrite();
    logger.close();

    const files = fs.readdirSync(tmpDir);
    expect(files.some((name) => name.startsWith('unit-worker_'))).toBe(true);
  });

  test('does not write to stdout when silentConsole is true', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createWorkerLogger({
      workerName: 'quiet-worker',
      logDir: tmpDir,
      silentConsole: true,
      baseLogger,
    });

    logger.info('quiet');
    await waitForWrite();
    logger.close();

    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  test('formats metadata consistently with base logger', async () => {
    const logger = createWorkerLogger({
      workerName: 'meta-worker',
      logDir: tmpDir,
      silentConsole: true,
      baseLogger,
    });

    logger.info('metadata-check', { foo: 'bar' });
    await waitForWrite();
    logger.close();

    const files = fs.readdirSync(tmpDir);
    const logFile = files.find((name) => name.startsWith('meta-worker_'));
    const contents = fs.readFileSync(path.join(tmpDir, logFile), 'utf8');

    expect(contents).toMatch(/\[meta-worker\] \[pid=\d+(?: req=[^\]]+)?\] metadata-check/);
    expect(contents).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} info:/);
  });
});
