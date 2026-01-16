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

function fmtUsd(n, maxDp = 8) {
  const num = fmtNum(n, maxDp);
  if (num == null) return null;
  return `$${num}`;
}

function formatBlockTimeIso(blockTime) {
  if (blockTime == null) return null;
  let bt = blockTime;
  try {
    bt = typeof blockTime === 'bigint' ? Number(blockTime) : Number(blockTime);
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(bt) || bt <= 0) return null;
  return new Date(bt * 1000).toISOString();
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
      h(Text, { dimColor: true }, `${label}:`),
      h(Text, { dimColor: dim }, ` ${String(value)}`)
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
    const statusRaw = s.status || 'unknown';
    const status = statusRaw === 'err' ? 'failed' : statusRaw;
    const ok = status === 'ok';
    const failed = status === 'failed';
    const icon = ok ? '✅' : failed ? '❌' : 'ℹ️';
    const txidValue = s.txid || s.signature || s.sig || s.txSignature || null;
    const blockTimeIso = s.blockTimeIso || formatBlockTimeIso(s.blockTime);
    const totalFeesSol = s.totalFeesSol != null ? s.totalFeesSol : s.networkFeeSol;
    const explorerUrl = s.explorerUrl || (txidValue ? `https://solscan.io/tx/${txidValue}` : null);
    const errText =
      s.errMessage ||
      (s.errorSummary && s.errorSummary.userMessage) ||
      (s.err && (s.err.message || String(s.err))) ||
      null;

    const headline =
      title ||
      s.label ||
      (s.side ? `${s.side} swap` : 'transaction summary');

    const walletAlias = s.walletAlias || s.walletLabel || null;
    const walletAddress = s.walletAddress || s.walletPubkey || s.wallet || null;
    const walletDisplay = walletAlias
      ? `${walletAlias}${walletAddress ? ` (${shorten(walletAddress, 6, 4)})` : ''}`
      : (walletAddress ? shorten(walletAddress, 6, 4) : null);

    const symbol = s.symbol || s.tokenSymbol || null;
    const mint = s.mint || null;
    const mintDisplay = symbol
      ? `${symbol}${mint ? ` (${shorten(mint, 6, 4)})` : ''}`
      : (mint ? shorten(mint, 6, 4) : null);
    const tokenLabel = symbol ? `tokens (${symbol})` : 'tokens';

    const priceUsd = fmtUsd(s.priceUsdPerToken, 8);
    const priceSol = s.priceSolPerToken != null ? `${fmtNum(s.priceSolPerToken, 9)} SOL` : null;

    const txidDisplay = showFullTxid ? txidValue : shorten(txidValue, 10, 6);

    return h(
      BorderBox,
      null,
      h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true }, `${icon} ${headline}`),
        h(Line, { label: 'txid', value: txidDisplay }),
        showFullTxid ? h(Line, { label: 'txid full', value: txidValue, dim: true }) : null,
        h(Line, { label: 'explorer', value: explorerUrl }),
        h(Line, { label: 'duration', value: s.durationMs != null ? `${s.durationMs}ms` : null }),
        h(Line, { label: 'slot', value: s.slot }),
        h(Line, { label: 'blockTime', value: blockTimeIso }),
        h(Line, { label: 'wallet', value: walletDisplay }),
        h(Line, { label: 'mint', value: mintDisplay }),
        h(Line, { label: 'side', value: s.side || null }),

        // Swap-ish section
        h(Text, { dimColor: true }, '—'),
        h(Line, { label: tokenLabel, value: fmtNum(s.tokens, 9) }),
        h(Line, { label: 'sol', value: fmtNum(s.sol, 9) }),
        h(Line, { label: 'price (USD)', value: priceUsd }),
        h(Line, { label: 'price (SOL)', value: priceSol }),
        h(Line, { label: 'totalFees (SOL)', value: fmtNum(totalFeesSol, 9) }),
        h(Line, { label: 'priceImpact', value: fmtPct(s.priceImpactPct) }),
        failed ? h(Line, { label: 'error', value: errText }) : null,

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
