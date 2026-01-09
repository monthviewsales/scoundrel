'use strict';

const path = require('path');

function createInMemoryFs() {
  const files = new Map();
  const watchers = new Map();

  function emit(dir, filename) {
    const handlers = watchers.get(dir);
    if (!handlers) return;
    handlers.forEach((cb) => cb('change', filename));
  }

  return {
    existsSync(target) {
      return files.has(target);
    },
    mkdirSync(_dir, _opts) {},
    readFileSync(target) {
      if (!files.has(target)) throw new Error(`ENOENT: no such file ${target}`);
      return files.get(target);
    },
    writeFileSync(target, data) {
      files.set(target, data);
      emit(path.dirname(target), path.basename(target));
    },
    renameSync(tmp, target) {
      if (files.has(tmp)) {
        files.set(target, files.get(tmp));
        files.delete(tmp);
        emit(path.dirname(target), path.basename(target));
      }
    },
    watch(dir, _opts, cb) {
      if (!watchers.has(dir)) watchers.set(dir, []);
      watchers.get(dir).push(cb);
      const handler = { close() {} };
      handler.on = () => handler;
      return handler;
    },
  };
}

describe('hub event followers', () => {
  test('consume snapshots then detach cleanly', async () => {
    let appendHubEvent;
    let createHubEventFollower;
    const mockFs = createInMemoryFs();

    jest.isolateModules(() => {
      jest.doMock('fs', () => mockFs);
      ({ appendHubEvent, createHubEventFollower } = require('../../lib/warchest/events'));
    });

    const statusPath = '/tmp/status.json';
    const eventPath = '/tmp/events.json';

    mockFs.writeFileSync(statusPath, JSON.stringify({ health: { ok: true } }, null, 2), 'utf8');
    appendHubEvent({ txid: 'abc', context: { wallet: 'alpha' } }, eventPath);

    const follower = createHubEventFollower({ statusPath, eventPath });
    const seenStatuses = [];
    const seenEvents = [];

    follower.onStatus((snapshot) => seenStatuses.push(snapshot));
    follower.onEvent((ev) => seenEvents.push(ev));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seenStatuses.length).toBeGreaterThan(0);
    expect(seenStatuses[0].health.ok).toBe(true);
    expect(seenEvents.length).toBeGreaterThan(0);
    expect(seenEvents[0].txid).toBe('abc');

    const beforeCloseCount = seenEvents.length;
    follower.close();
    appendHubEvent({ txid: 'later' }, eventPath);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seenEvents.length).toBe(beforeCloseCount);
  });
});
