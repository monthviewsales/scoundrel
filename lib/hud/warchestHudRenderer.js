"use strict";

const chalk = require('chalk');
const { getChainState } = require('../solana/rpcMethods/internal/chainState');
const { getWalletState } = require('../solana/rpcMethods/internal/walletState');

// ---------- colorizer (reuse palette semantics from warchest) ----------
function colorizer(color) {
  if (!color) return (text) => text;
  switch (color) {
    case 'green':
      return chalk.green;
    case 'cyan':
      return chalk.cyan;
    case 'magenta':
      return chalk.magenta;
    case 'yellow':
      return chalk.yellow;
    case 'blue':
      return chalk.blue;
    case 'red':
      return chalk.red;
    default:
      return (text) => text;
  }
}

function shortenPubkey(pubkey) {
  if (!pubkey || pubkey.length <= 8) return pubkey;
  return `${pubkey.slice(0, 3)}...${pubkey.slice(-5)}`;
}

/**
 * Format a number with fixed decimals and thousands separators.
 * @param {number|null} value
 * @param {number} [decimals=3]
 * @returns {string}
 */
function fmtNum(value, decimals = 3) {
  if (value == null || Number.isNaN(value)) return '-';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Render a single wallet section in the style you described.
 * For now, tokens are whatever is in state.tokens (stubbed until we wire metadata/prices).
 * @param {import('../../scripts/warchestHudWorker').WalletState} w
 * @param {Object} opts
 * @param {Set<string>} opts.stableMints
 * @param {number|null} opts.lastSolPriceUsd
 * @returns {string}
 */
function renderWalletSection(w, { stableMints, lastSolPriceUsd }) {
  const c = colorizer(w.color);

  const headerWidth = 65;
  const borderTop = `┌${'─'.repeat(headerWidth)}┐`;
  const borderMid = `├${'─'.repeat(headerWidth)}┤`;
  const borderBottom = `└${'─'.repeat(headerWidth)}┘`;

  const shortPk = shortenPubkey(w.pubkey);

  // Prefer live WS-driven SOL balance from walletState when available.
  let effectiveSolBalance = w.solBalance;
  const wsWallet = getWalletState(w.pubkey);
  if (wsWallet && typeof wsWallet.solLamports === 'number' && Number.isFinite(wsWallet.solLamports)) {
    effectiveSolBalance = wsWallet.solLamports / 1_000_000_000;
  }

  const solStr = `SOL: ${fmtNum(effectiveSolBalance, 3)}`;

  // Recompute session delta from the effective balance when we have a baseline.
  let sessionDelta = w.solSessionDelta;
  if (w.startSolBalance != null && effectiveSolBalance != null && Number.isFinite(effectiveSolBalance)) {
    sessionDelta = effectiveSolBalance - w.startSolBalance;
  }

  let deltaStr = '';
  if (sessionDelta !== 0) {
    const deltaRaw = `${sessionDelta > 0 ? '+' : ''}${fmtNum(sessionDelta, 3)}`;
    const deltaColored = sessionDelta > 0 ? chalk.green(deltaRaw) : chalk.red(deltaRaw);
    deltaStr = ` (${deltaColored})`;
  }

  const solWithDelta = `${solStr}${deltaStr}`;

  let solPriceStr = '';
  if (typeof lastSolPriceUsd === 'number' && Number.isFinite(lastSolPriceUsd)) {
    solPriceStr = ` @ $${fmtNum(lastSolPriceUsd, 2)}`;
  }

  const headerText = `${c(w.alias)} (${shortPk})   ${solWithDelta}${solPriceStr}`;
  const headerLine = `│ ${headerText.padEnd(headerWidth - 1, ' ')}│`;

  // Table header
  const colSym = 'Sym'.padEnd(6, ' ');
  const colMint = 'Mint'.padEnd(15, ' ');
  // Numeric columns: right-align headers to match right-aligned values.
  const colBal = 'Balance'.padStart(14, ' ');
  const colDelta = 'Δ Session'.padStart(14, ' ');
  const colUsd = 'Est. USD'.padStart(10, ' ');

  const colsHeader = `│ ${colSym}│ ${colMint}│ ${colBal}│ ${colDelta}│ ${colUsd}│`;

  const sepRow = '├────────┼───────────────┼──────────────┼──────────────┼──────────┤';

  const rows = [];

  if (!w.tokens || w.tokens.length === 0) {
    const emptyMsg = '(no tokens yet)';
    const line = `│ ${emptyMsg.padEnd(headerWidth - 1, ' ')}│`;
    rows.push(line);
  } else {
    const stableTokens = [];
    const otherTokens = [];

    for (const t of w.tokens) {
      if (t.mint && stableMints.has(t.mint)) {
        stableTokens.push(t);
      } else {
        otherTokens.push(t);
      }
    }

    const makeRow = (t, isStable) => {
      const sym = (t.symbol || '').slice(0, 6).padEnd(6, ' ');
      const mint = shortenPubkey(t.mint || '').slice(0, 15).padEnd(15, ' ');
      const rawBal = fmtNum(t.balance, 2);
      const bal = (isStable ? `$${rawBal}` : rawBal).padStart(14, ' ');
      const delta = fmtNum(t.sessionDelta, 2).padStart(14, ' ');
      const usd = t.usdEstimate == null
        ? '-'.padStart(10, ' ')
        : (`$${fmtNum(t.usdEstimate, 2)}`).padStart(10, ' ');

      const row = `│ ${sym}│ ${mint}│ ${bal}│ ${delta}│ ${usd}│`;
      return isStable ? chalk.green(row) : row;
    };

    if (stableTokens.length > 0) {
      for (const t of stableTokens) {
        rows.push(makeRow(t, true));
      }
      if (otherTokens.length > 0) {
        // visual divider between stables and the rest
        rows.push(sepRow);
      }
    }

    for (const t of otherTokens) {
      rows.push(makeRow(t, false));
    }
  }

  const lines = [
    borderTop,
    headerLine,
    borderMid,
    colsHeader,
    sepRow,
    ...rows,
  ];

  if (w.recentEvents && w.recentEvents.length > 0) {
    lines.push(borderMid);
    const activityHeader = 'Recent activity:';
    lines.push(`│ ${activityHeader.padEnd(headerWidth - 1, ' ')}│`);

    const maxEvents = Math.min(w.recentEvents.length, 5);
    for (let i = 0; i < maxEvents; i += 1) {
      const summary = w.recentEvents[i].summary || '';
      lines.push(`│ ${summary.slice(0, headerWidth - 1).padEnd(headerWidth - 1, ' ')}│`);
    }
  }

  lines.push(borderBottom);

  return lines.join('\n');
}

/**
 * Render the full HUD screen for all wallets.
 * @param {Record<string,import('../../scripts/warchestHudWorker').WalletState>} state
 * @param {Object} options
 * @param {number|null} options.lastSolPriceUsd
 * @param {{lastSolMs:number|null,lastTokenMs:number|null,lastDataApiMs:number|null}} options.rpcStats
 * @param {Set<string>} options.stableMints
 */
function renderHud(state, { lastSolPriceUsd, rpcStats, stableMints }) {
  // Clear the screen + move cursor to top-left
  // eslint-disable-next-line no-console
  process.stdout.write('\x1b[2J\x1b[H');

  const aliases = Object.keys(state).sort();
  if (aliases.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No wallets configured for HUD worker.\n');
    return;
  }

  const now = Date.now();
  const chain = getChainState();
  let chainLine = 'Chain: slot N/A (WS idle)';

  if (chain && chain.slot != null) {
    const ageMs = chain.lastSlotAt ? now - chain.lastSlotAt : null;
    const ageStr = ageMs != null ? `${Math.round(ageMs)}ms ago` : 'just now';
    const rootStr = chain.root != null ? `root ${chain.root}` : 'root N/A';
    chainLine = `Chain: slot ${chain.slot} (${rootStr}), last update ${ageStr}`;
  }

  const wsStatus = (() => {
    if (!chain || chain.slot == null || !chain.lastSlotAt) return 'WS: idle';
    const ageMs = now - chain.lastSlotAt;
    if (ageMs < 2000) return `WS: OK (${ageMs}ms)`;
    if (ageMs < 10000) return `WS: stale (${ageMs}ms)`;
    return `WS: lagging (${ageMs}ms)`;
  })();

  const rpcParts = [];
  if (typeof rpcStats.lastSolMs === 'number') rpcParts.push(`SOL RPC: ${rpcStats.lastSolMs}ms`);
  if (typeof rpcStats.lastTokenMs === 'number') rpcParts.push(`Tokens RPC: ${rpcStats.lastTokenMs}ms`);
  if (typeof rpcStats.lastDataApiMs === 'number') rpcParts.push(`Data API: ${rpcStats.lastDataApiMs}ms`);
  const rpcLine = rpcParts.length ? rpcParts.join('  |  ') : 'RPC: (no recent calls)';

  const sections = aliases.map((alias) => renderWalletSection(state[alias], { stableMints, lastSolPriceUsd }));
  const combined = sections.join('\n\n');

  const footer = `Last redraw: ${new Date(now).toLocaleTimeString()}  |  Wallets: ${aliases.length}  |  Ctrl-C to exit`;

  // eslint-disable-next-line no-console
  console.log(chainLine);
  // eslint-disable-next-line no-console
  console.log(`${wsStatus}  |  ${rpcLine}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(combined);
  // eslint-disable-next-line no-console
  console.log(`\n${footer}`);
}

module.exports = { renderHud };
