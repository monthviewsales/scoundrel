'use strict';

const { createWsSupervisor } = require('../../lib/warchest/wsSupervisor');

describe('warchest wsSupervisor', () => {
  test('does not restart when lastSlotAt is missing', () => {
    const supervisor = createWsSupervisor({ now: () => 1000, staleAfterMs: 10 });
    expect(supervisor.shouldRestartForStale(null)).toEqual({ shouldRestart: false, reason: null });
    expect(supervisor.shouldRestartForStale(undefined)).toEqual({ shouldRestart: false, reason: null });
  });

  test('restarts when slot age exceeds stale threshold', () => {
    const supervisor = createWsSupervisor({ now: () => 1000, staleAfterMs: 100, minRestartGapMs: 0 });
    const res = supervisor.shouldRestartForStale(800);
    expect(res.shouldRestart).toBe(true);
    expect(res.reason).toMatch(/^ws_stale_/);
  });

  test('begin/end restart updates status and backoff', () => {
    let t = 0;
    const supervisor = createWsSupervisor({
      now: () => t,
      staleAfterMs: 10,
      minRestartGapMs: 0,
      maxBackoffMs: 10_000,
    });

    expect(supervisor.beginRestart('ws_stale')).toBe(true);
    let status = supervisor.getStatus();
    expect(status.restartInFlight).toBe(true);
    expect(status.restarts).toBe(1);
    expect(status.lastRestartReason).toBe('ws_stale');

    supervisor.endRestart(false, new Error('boom'));
    status = supervisor.getStatus();
    expect(status.restartInFlight).toBe(false);
    expect(status.backoffMs).toBe(2000);
    expect(status.lastError).toContain('restart: boom');
  });

  test('cooldown/backoff prevents rapid restart loops', () => {
    let t = 0;
    const supervisor = createWsSupervisor({
      now: () => t,
      staleAfterMs: 10,
      minRestartGapMs: 5000,
      maxBackoffMs: 60_000,
    });

    t = 20_000;
    expect(supervisor.shouldRestartForStale(1).shouldRestart).toBe(true);
    expect(supervisor.beginRestart('ws_stale')).toBe(true);
    supervisor.endRestart(false, new Error('nope'));

    // Immediately after a failed restart, backoff applies and we should not restart again.
    t = 20_100;
    expect(supervisor.shouldRestartForStale(1).shouldRestart).toBe(false);

    // After minRestartGapMs but before backoff, still blocked.
    t = 24_900;
    expect(supervisor.shouldRestartForStale(1).shouldRestart).toBe(false);

    // After both minRestartGapMs and backoff, restart can be attempted again.
    t = 30_000;
    expect(supervisor.shouldRestartForStale(1).shouldRestart).toBe(true);
  });
});
