'use strict';

const makeGetPositionByTradeUUID = require('../src/adapters/sqlite/trading/getPositionByTradeUUID');

describe('getPositionByTradeUUID', () => {
  test('throws when db is missing', () => {
    expect(() => makeGetPositionByTradeUUID()).toThrow('requires a sqlite db instance');
  });

  test('returns null when tradeUuid is invalid', () => {
    const stmt = { get: jest.fn() };
    const db = { prepare: jest.fn(() => stmt) };
    const getPositionByTradeUUID = makeGetPositionByTradeUUID(db);

    expect(getPositionByTradeUUID(null)).toBeNull();
    expect(getPositionByTradeUUID(123)).toBeNull();
    expect(stmt.get).not.toHaveBeenCalled();
  });

  test('returns row when tradeUuid matches', () => {
    const stmt = { get: jest.fn().mockReturnValue({ position_id: 7 }) };
    const db = { prepare: jest.fn(() => stmt) };
    const getPositionByTradeUUID = makeGetPositionByTradeUUID(db);

    const result = getPositionByTradeUUID('trade-123');

    expect(stmt.get).toHaveBeenCalledWith('trade-123');
    expect(result).toEqual({ position_id: 7 });
  });
});
