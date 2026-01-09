'use strict';

const {
  chooseStrategy,
  evalQualify,
  recommendAction,
} = require('../../../../lib/warchest/workers/sellOps/decisionEngine');

describe('sellOps decisionEngine', () => {
  const docs = {
    flash: {
      strategyId: 'flash.v1',
      schemaVersion: '1',
      name: 'Flash',
      qualify: {
        gates: [
          { id: 'risk.max', type: 'number_lte', params: { path: 'risk.score', max: 50 }, severityOnFail: 'exit' },
        ],
      },
    },
    hybrid: {
      strategyId: 'hybrid.v1',
      schemaVersion: '1',
      name: 'Hybrid',
      qualify: {
        gates: [
          { id: 'risk.max', type: 'number_lte', params: { path: 'risk.score', max: 75 }, severityOnFail: 'warn' },
        ],
      },
    },
    campaign: {
      strategyId: 'campaign.v1',
      schemaVersion: '1',
      name: 'Campaign',
      qualify: { gates: [] },
    },
  };

  test('prefers DB strategy name when provided', () => {
    const position = { strategyName: 'Flash' };
    const evaluation = { risk: { score: 40 }, warnings: [] };
    const chosen = chooseStrategy(position, docs, evaluation);
    expect(chosen.source).toBe('position');
    expect(chosen.strategy.name).toBe('Flash');
  });

  test('infers strongest passing strategy and recommendation', () => {
    const position = {};
    const evaluation = { risk: { score: 60 }, warnings: [] };
    const chosen = chooseStrategy(position, docs, evaluation);
    expect(chosen.source).toBe('inferred');
    expect(chosen.strategy.name).toBe('Hybrid');
    const qualify = evalQualify(chosen.strategy, evaluation);
    expect(qualify.failed).toHaveLength(0);
    expect(recommendAction(qualify.worstSeverity)).toBe('hold');
  });
});
