'use strict';

const { validateTargetListPayload } = require('../../../lib/warchest/workers/targetListWorker');

describe('targetListWorker payloads', () => {
  test('honors skipTargetScan flag', () => {
    const res = validateTargetListPayload({ runOnce: true, intervalMs: 1234, skipTargetScan: true });
    expect(res.skipTargetScan).toBe(true);
  });

  test('defaults skipTargetScan to false', () => {
    const res = validateTargetListPayload({ runOnce: true, intervalMs: 1234 });
    expect(res.skipTargetScan).toBe(false);
  });
});
