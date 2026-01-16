'use strict';

const React = require('react');
const { createTxSummaryCardComponents } = require('../../lib/tui/txSummaryCard');

const h = React.createElement;
let render;
let ink;

describe('tx summary card', () => {
  beforeAll(async () => {
    const inkTestingLibrary = await import('ink-testing-library');
    const inkModule = await import('ink');
    render = inkTestingLibrary.render;
    ink = inkModule;
  });

  test('renders summary details', () => {
    const { TxSummaryCard } = createTxSummaryCardComponents(ink);
    const summary = {
      status: 'ok',
      txid: 'ABCDEFGH1234567890',
      explorerUrl: 'https://example.test/tx/ABCDEFGH',
      durationMs: 1200,
      slot: 123,
      blockTimeIso: '2024-01-01T00:00:00Z',
      tokens: 1.2345,
      sol: 0.0123,
      totalFeesSol: 0.000005,
      priceImpactPct: 0.55,
    };

    const { lastFrame, unmount } = render(h(TxSummaryCard, { summary }));
    const frame = lastFrame();

    expect(frame).toContain('transaction summary');
    expect(frame).toContain('txid');
    expect(frame).toContain('duration');
    expect(frame).toContain('priceImpact');

    unmount();
  });
});
