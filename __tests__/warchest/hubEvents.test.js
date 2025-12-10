'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendHubEvent, createHubEventFollower } = require('../../lib/warchest/events');

describe('hub event followers', () => {
  test('consume snapshots then detach cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-events-'));
    const statusPath = path.join(tempDir, 'status.json');
    const eventPath = path.join(tempDir, 'events.json');

    fs.writeFileSync(statusPath, JSON.stringify({ health: { ok: true } }, null, 2), 'utf8');
    appendHubEvent({ txid: 'abc', context: { wallet: 'alpha' } }, eventPath);

    const follower = createHubEventFollower({ statusPath, eventPath });
    const seenStatuses = [];
    const seenEvents = [];

    follower.onStatus((snapshot) => seenStatuses.push(snapshot));
    follower.onEvent((ev) => seenEvents.push(ev));

    const initialStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    seenStatuses.push(initialStatus);
    const initialEvents = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    initialEvents.forEach((ev) => seenEvents.push(ev));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seenStatuses[0].health.ok).toBe(true);
    expect(seenEvents[0].txid).toBe('abc');

    follower.close();
    appendHubEvent({ txid: 'later' }, eventPath);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seenEvents.length).toBe(1);
  });
});
