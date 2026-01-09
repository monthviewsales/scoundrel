'use strict';

const React = require('react');

function shorten(v, left = 6, right = 6) {
  if (!v || typeof v !== 'string') return '';
  if (v.length <= left + right + 3) return v;
  return `${v.slice(0, left)}...${v.slice(-right)}`;
}

function fmtNum(n, maxDp = 6) {
  if (n == null) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  // keep it readable; trim trailing zeros
  return x.toFixed(maxDp).replace(/\.?0+$/, '');
}

function fmtPct(p) {
  if (p == null) return null;
  const x = Number(p);
  if (!Number.isFinite(x)) return null;
  return `${fmtNum(x, 4)}%`;
}

/**
 * Factory: inject Ink bindings.
 * @param {object} ink - namespace from `import('ink')`
 */
function createTxSummaryCardComponents(ink) {
  const { Box, Text } = ink;
  const h = React.createElement;

  function Line({ label, value, dim = false }) {
    if (value == null || value === '') return null;
    return h(
      Box,
      { flexDirection: 'row' },
      h(Text, { dimColor: true }, `${label}: `),
      h(Text, { dimColor: dim }, String(value))
    );
  }

  function BorderBox({ children }) {
    // Simple unicode border that works everywhere
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, '┌──────────────────────────────────────────────┐'),
      h(
        Box,
        { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
        children
      ),
      h(Text, null, '└──────────────────────────────────────────────┘')
    );
  }

  /**
   * @param {{ summary: object, title?: string, showFullTxid?: boolean }} props
   */
  function TxSummaryCard({ summary, title, showFullTxid = false }) {
    const s = summary || {};
    const status = s.status || 'unknown';
    const ok = status === 'ok';
    const icon = ok ? '✅' : status === 'failed' ? '❌' : 'ℹ️';
    const errText =
      s.errMessage ||
      (s.errorSummary && s.errorSummary.userMessage) ||
      (s.err && (s.err.message || String(s.err))) ||
      null;

    const headline =
      title ||
      s.label ||
      (s.side ? `${s.side} swap` : 'transaction summary');

    const txidDisplay = showFullTxid ? s.txid : shorten(s.txid, 10, 6);

    return h(
      BorderBox,
      null,
      h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true }, `${icon} ${headline}`),
        h(Line, { label: 'txid', value: txidDisplay }),
        showFullTxid ? null : h(Line, { label: 'txid full', value: s.txid, dim: true }),
        h(Line, { label: 'explorer', value: s.explorerUrl }),
        h(Line, { label: 'duration', value: s.durationMs != null ? `${s.durationMs}ms` : null }),
        h(Line, { label: 'slot', value: s.slot }),
        h(Line, { label: 'blockTime', value: s.blockTimeIso }),

        // Swap-ish section
        h(Text, { dimColor: true }, '—'),
        h(Line, { label: 'tokens', value: fmtNum(s.tokens, 9) }),
        h(Line, { label: 'sol', value: fmtNum(s.sol, 9) }),
        h(Line, { label: 'totalFees (SOL)', value: fmtNum(s.totalFeesSol, 9) }),
        h(Line, { label: 'priceImpact', value: fmtPct(s.priceImpactPct) }),
        status === 'failed' ? h(Line, { label: 'error', value: errText }) : null,

        // Quote (string or object)
        s.quote != null
          ? h(
              Box,
              { flexDirection: 'column', marginTop: 1 },
              h(Text, { dimColor: true }, 'quote:'),
              h(Text, null, typeof s.quote === 'string' ? s.quote : JSON.stringify(s.quote))
            )
          : null
      )
    );
  }

  return { TxSummaryCard };
}

async function loadTxSummaryCard() {
  const ink = await import('ink');
  return createTxSummaryCardComponents(ink);
}

module.exports = {
  createTxSummaryCardComponents,
  loadTxSummaryCard,
};
