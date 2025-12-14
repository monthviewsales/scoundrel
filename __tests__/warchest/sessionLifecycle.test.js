'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readStatusSnapshot,
  deriveSessionCloseAnchors,
  closeLingeringSession,
} = require('../../lib/warchest/workers/sessionLifecycle');

describe('warchest session lifecycle helpers', () => {
  test('deriveSessionCloseAnchors prefers session health data', () => {
    const snapshot = {
      health: {
        session: {
          lastRefreshSlot: 999,
          lastRefreshBlockTime: 1700000000000,
        },
        ws: {
          slot: 123,
          blockTimeMs: 1600000000000,
        },
      },
    };

    const anchors = deriveSessionCloseAnchors(snapshot, null);
    expect(anchors.slot).toBe(999);
    expect(anchors.blockTimeMs).toBe(1700000000000);
  });

  test('deriveSessionCloseAnchors falls back to active session row', () => {
    const snapshot = null;
    const sessionRow = {
      last_refresh_slot: 88,
      last_refresh_block_time: 1234567890,
      start_slot: 77,
      start_block_time: 111,
    };

    const anchors = deriveSessionCloseAnchors(snapshot, sessionRow);
    expect(anchors.slot).toBe(88);
    expect(anchors.blockTimeMs).toBe(1234567890);
  });

  test('closeLingeringSession closes session using snapshot anchors when available', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warchest-session-'));
    const statusPath = path.join(tmpDir, 'status.json');
    const snapshot = {
      health: {
        session: {
          lastRefreshSlot: 654321,
          lastRefreshBlockTime: 1701000000000,
        },
      },
    };
    fs.writeFileSync(statusPath, JSON.stringify(snapshot));

    const getActiveSession = jest.fn(() => ({
      session_id: 42,
      start_slot: 600000,
      start_block_time: 1600000000000,
      last_refresh_slot: 600001,
      last_refresh_block_time: 1650000000000,
    }));
    const endSession = jest.fn(() => ({ session_id: 42, ended_at: 1701000005000 }));

    const result = closeLingeringSession({
      BootyBox: { getActiveSession, endSession },
      statusPath,
      service: 'warchest-service',
      reason: 'crash',
      now: 1701000006000,
    });

    expect(result.closed).toBe(true);
    expect(result.anchors.slot).toBe(654321);
    expect(result.anchors.blockTimeMs).toBe(1701000000000);
    expect(endSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 42,
        endSlot: 654321,
        endBlockTime: 1701000000000,
        reason: 'crash',
        now: 1701000006000,
      })
    );

    const parsedSnapshot = readStatusSnapshot(statusPath);
    expect(parsedSnapshot).toMatchObject(snapshot);
  });
});
