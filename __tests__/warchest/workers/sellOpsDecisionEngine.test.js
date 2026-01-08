'use strict';

const { chooseStrategy } = require('../../../lib/warchest/workers/sellOps/decisionEngine');
const { loadStrategyDocs } = require('../../../lib/warchest/workers/sellOps/strategyDocs');

describe('sellOps decisionEngine strategy source', () => {
  test('reports position-sourced strategy when strategyName is set', () => {
    const docs = loadStrategyDocs();
    const result = chooseStrategy({ strategyName: 'FLASH' }, docs, {});
    expect(result.source).toBe('position');
  });

  test('reports inferred strategy when no strategyName is set', () => {
    const docs = loadStrategyDocs();
    const result = chooseStrategy({}, docs, {});
    expect(result.source).toBe('inferred');
  });
});
