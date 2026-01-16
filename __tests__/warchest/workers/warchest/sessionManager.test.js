'use strict';

const { createSessionManager } = require('../../../../lib/warchest/workers/warchest/sessionManager');

describe('sessionManager', () => {
  test('starts and finalizes a session', async () => {
    const bootyBox = {
      startSession: jest.fn(() => 42),
      endSession: jest.fn(() => ({ id: 42 })),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const getChainState = jest.fn(() => ({ slot: 50 }));
    const closeLingeringSession = jest.fn();
    const fetchSlotAnchor = jest.fn().mockResolvedValue({ slot: 10, blockTimeMs: 1000 });
    const wait = jest.fn().mockResolvedValue();

    const manager = createSessionManager({
      bootyBox,
      logger,
      getChainState,
      closeLingeringSession,
      statusPath: '/tmp/status.json',
      serviceName: 'hud',
      serviceInstanceId: 'instance-1',
      fetchSlotAnchor,
      wait,
    });

    await manager.ensureSessionStarted();
    expect(bootyBox.startSession).toHaveBeenCalled();
    expect(manager.sessionState.id).toBe(42);

    await manager.finalizeSession('shutdown', { slot: 99, blockTimeMs: 2000 });
    expect(bootyBox.endSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 42,
      endSlot: 99,
      endBlockTime: 2000,
      reason: 'shutdown',
    }));
  });

  test('closes stale sessions via helper', async () => {
    const closeLingeringSession = jest.fn().mockResolvedValue();
    const manager = createSessionManager({
      bootyBox: {},
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      getChainState: jest.fn(),
      closeLingeringSession,
      statusPath: '/tmp/status.json',
      serviceName: 'hud',
      serviceInstanceId: 'instance-1',
      fetchSlotAnchor: jest.fn(),
      wait: jest.fn(),
    });

    await manager.closeStaleSession();
    expect(closeLingeringSession).toHaveBeenCalledWith(expect.objectContaining({
      service: 'hud',
      statusPath: '/tmp/status.json',
      reason: 'crash',
    }));
  });
});
