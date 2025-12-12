'use strict';

jest.mock('../../../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildWorkerEnv,
  createPidTag,
  createLifecycleLogger,
  forkWorkerWithPayload,
} = require('../../../lib/warchest/workers/harness');
const logger = require('../../../lib/logger');

const fixturesDir = path.join(__dirname, '..', '..', 'fixtures', 'warchest');
const echoWorker = path.join(fixturesDir, 'echoWorker.js');
const cleanupWorker = path.join(fixturesDir, 'cleanupWorker.js');
const stallWorker = path.join(fixturesDir, 'stallWorker.js');

function removeFileSafe(p) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (err) {
    // ignore test cleanup errors
  }
}

describe('warchest worker harness', () => {
  test('round-trips IPC envelopes with env hints', async () => {
    const payload = { hello: 'world', sleepMs: 10 };
    const env = buildWorkerEnv({
      rpcEndpoint: 'http://example-rpc',
      dataEndpoint: 'http://example-data',
      walletIds: [1, 2, 3],
      bootyBoxPath: '/tmp/booty.sqlite',
      extraEnv: { EXTRA_SAMPLE_VAR: 'ok' },
    });

    const res = await forkWorkerWithPayload(echoWorker, {
      payload,
      env,
      timeoutMs: 2000,
      requestId: 'ipc-test',
    });

    expect(res.requestId).toBe('ipc-test');
    expect(res.result.echo).toEqual(payload);
    expect(res.result.env).toEqual({
      rpc: 'http://example-rpc',
      data: 'http://example-data',
      wallets: '1,2,3',
      booty: '/tmp/booty.sqlite',
      extra: 'ok',
    });
  });

  test('cleans up tracked close/unsubscribe resources', async () => {
    const cleanupPath = path.join(os.tmpdir(), `cleanup-${Date.now()}.log`);
    removeFileSafe(cleanupPath);

    await forkWorkerWithPayload(cleanupWorker, {
      payload: { logPath: cleanupPath },
      timeoutMs: 2000,
    });

    const contents = fs.readFileSync(cleanupPath, 'utf8');
    expect(contents).toContain('closed');
    expect(contents).toContain('unsubscribed');
    expect(contents).toContain('onClose');

    removeFileSafe(cleanupPath);
  });

  test('rejects when a worker exceeds the timeout', async () => {
    await expect(
      forkWorkerWithPayload(stallWorker, {
        payload: {},
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test('supports pid/tag coordination helpers', async () => {
    const tagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warchest-locks-'));
    const tag = `sample-${Date.now()}`;
    const { path: lockPath, release } = createPidTag(tag, tagDir);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(() => createPidTag(tag, tagDir)).toThrow(/already exists/);

    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('emits structured lifecycle logs with metrics hook', () => {
    const metrics = jest.fn();
    const lifecycle = createLifecycleLogger('unit-worker', logger, metrics);
    const startedAt = Date.now() - 10;

    lifecycle.start('req-1', { payload: true });
    lifecycle.success('req-1', { ok: true }, startedAt);
    lifecycle.error('req-1', new Error('boom'), startedAt);
    lifecycle.cleanup('req-1');

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[unit-worker] start'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('success'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('error'));
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ event: 'start', worker: 'unit-worker' }));
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ event: 'cleanup', worker: 'unit-worker' }));
  });
});
