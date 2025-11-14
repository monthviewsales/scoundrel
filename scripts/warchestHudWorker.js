#!/usr/bin/env node
'use strict';

// scripts/warchestHudWorker.js
// Long-running HUD worker: given wallet info via CLI args,
// connect to SolanaTracker RPC, maintain simple state, and render a
// multi-wallet dashboard in the terminal.
//
// NOTE: v1 stops before metadata/price pulls. Tokens/prices are stubbed.

require('dotenv').config();

const chalk = require('chalk');
const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
const { createRpcMethods } = require('../lib/solana/rpcMethods');

// ---------- env helpers ----------
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HUD_RENDER_INTERVAL_MS = intFromEnv('HUD_RENDER_INTERVAL_MS', 750);
const HUD_SOL_REFRESH_SEC = intFromEnv('HUD_SOL_REFRESH_SEC', 15);

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

// ---------- CLI arg parsing ----------
// For now we keep it dead simple and independent of commander:
//   --wallet alias:pubkey:color
//   --wallet sniper:AbCd...:magenta
//
// Later, warchest will launch this worker like:
//   node scripts/warchestHudWorker.js \
//     --wallet warlord:DDkF...:green \
//     --wallet sniper:ABCD...:magenta

function parseArgs(argv) {
  const wallets = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--wallet') {
      const spec = args[i + 1];
      i += 1;
      if (!spec) continue;
      const [alias, pubkey, color] = spec.split(':');
      if (!alias || !pubkey) {
        // eslint-disable-next-line no-console
        console.warn('[HUD] ignoring malformed --wallet spec:', spec);
        continue;
      }
      wallets.push({ alias, pubkey, color: color || null });
    }
  }

  return { wallets };
}

// ---------- HUD state ----------

/**
 * @typedef {Object} TokenRow
 * @property {string} symbol
 * @property {string} mint
 * @property {number} balance
 * @property {number} deltaSinceOpen
 * @property {number|null} usdEstimate
 */

/**
 * @typedef {Object} WalletState
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} color
 * @property {number|null} startSolBalance
 * @property {number} solBalance
 * @property {number} solDelta
 * @property {number} openedAt
 * @property {number} lastActivityTs
 * @property {TokenRow[]} tokens
 */

/**
 * Build initial HUD state from CLI wallets.
 * In v1, tokens are just an empty list (to be filled later).
 * @param {{alias:string,pubkey:string,color:string|null}[]} walletSpecs
 * @returns {Record<string,WalletState>}
 */
function buildInitialState(walletSpecs) {
  const now = Date.now();
  const state = {};
  for (const w of walletSpecs) {
    state[w.alias] = {
      alias: w.alias,
      pubkey: w.pubkey,
      color: w.color || null,
      startSolBalance: null,
      solBalance: 0,
      solDelta: 0,
      openedAt: now,
      lastActivityTs: now,
      tokens: [],
    };
  }
  return state;
}

// ---------- HUD rendering ----------

function shortenPubkey(pubkey) {
  if (!pubkey || pubkey.length <= 8) return pubkey;
  return `${pubkey.slice(0, 3)}...${pubkey.slice(-5)}`;
}

/**
 * Format a number with fixed decimals and thousands separators.
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
 * @param {WalletState} w
 * @returns {string}
 */
function renderWalletSection(w) {
  const c = colorizer(w.color);

  const headerWidth = 65;
  const borderTop = `┌${'─'.repeat(headerWidth)}┐`;
  const borderMid = `├${'─'.repeat(headerWidth)}┤`;
  const borderBottom = `└${'─'.repeat(headerWidth)}┘`;

  const shortPk = shortenPubkey(w.pubkey);
  const solStr = `SOL: ${fmtNum(w.solBalance, 3)}`;
  const deltaStr = w.solDelta === 0
    ? ''
    : ` (${w.solDelta > 0 ? '+' : ''}${fmtNum(w.solDelta, 3)})`;
  const solWithDelta = `${solStr}${deltaStr}`;

  const headerText = `${c(w.alias)} (${shortPk})   ${solWithDelta}`;
  const headerLine = `│ ${headerText.padEnd(headerWidth - 1, ' ')}│`;

  // Table header
  const colSym = 'Sym'.padEnd(6, ' ');
  const colMint = 'Mint'.padEnd(15, ' ');
  const colBal = 'Balance'.padEnd(14, ' ');
  const colDelta = 'Δ since open'.padEnd(14, ' ');
  const colUsd = 'Est. USD'.padEnd(10, ' ');

  const colsHeader = `│ ${colSym}│ ${colMint}│ ${colBal}│ ${colDelta}│ ${colUsd}│`;

  const sepRow = '├────────┼───────────────┼──────────────┼──────────────┼──────────┤';

  const rows = [];
  if (!w.tokens || w.tokens.length === 0) {
    const emptyMsg = '(no tokens yet)';
    const line = `│ ${emptyMsg.padEnd(headerWidth - 1, ' ')}│`;
    rows.push(line);
  } else {
    for (const t of w.tokens) {
      const sym = (t.symbol || '').slice(0, 6).padEnd(6, ' ');
      const mint = shortenPubkey(t.mint || '').slice(0, 15).padEnd(15, ' ');
      const bal = fmtNum(t.balance, 2).padStart(14, ' ');
      const delta = fmtNum(t.deltaSinceOpen, 2).padStart(14, ' ');
      const usd = t.usdEstimate == null
        ? '-'.padStart(10, ' ')
        : (`$${fmtNum(t.usdEstimate, 2)}`).padStart(10, ' ');

      rows.push(`│ ${sym}│ ${mint}│ ${bal}│ ${delta}│ ${usd}│`);
    }
  }

  const lines = [
    borderTop,
    headerLine,
    borderMid,
    `│ Sym   │ Mint          │ Balance      │ Δ since open │ Est. USD │`,
    sepRow,
    ...rows,
    borderBottom,
  ];

  return lines.join('\n');
}

/**
 * Render the full HUD screen for all wallets.
 * @param {Record<string,WalletState>} state
 */
function renderHud(state) {
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
  const sections = aliases.map((alias) => renderWalletSection(state[alias]));
  const combined = sections.join('\n\n');

  const footer = `Last redraw: ${new Date(now).toLocaleTimeString()}  |  Wallets: ${aliases.length}  |  Ctrl-C to exit`;

  // eslint-disable-next-line no-console
  console.log(combined);
  // eslint-disable-next-line no-console
  console.log('\n' + footer);
}

// ---------- helpers for SOL balance refresh ----------

/**
 * Fetch the SOL balance for a single wallet via RPC methods helper.
 *
 * @param {*} rpcMethods
 * @param {string} pubkey
 * @returns {Promise<number|null>} balance in SOL or null on error
 */
async function fetchSolBalance(rpcMethods, pubkey) {
  if (!rpcMethods || typeof rpcMethods.getSolBalance !== 'function') return null;
  try {
    return await rpcMethods.getSolBalance(pubkey);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[HUD] Failed to fetch SOL balance for', pubkey, '-', err.message || err);
    return null;
  }
}

/**
 * Refresh SOL balances for all wallets and update HUD state.
 * @param {*} rpcMethods
 * @param {Record<string,WalletState>} state
 */
async function refreshAllSolBalances(rpcMethods, state) {
  const aliases = Object.keys(state);
  if (!rpcMethods || aliases.length === 0) return;

  const now = Date.now();

  await Promise.all(
    aliases.map(async (alias) => {
      const w = state[alias];
      const bal = await fetchSolBalance(rpcMethods, w.pubkey);
      if (bal == null) return;

      if (w.startSolBalance == null) {
        w.startSolBalance = bal;
        w.solDelta = 0;
      } else {
        w.solDelta = bal - w.startSolBalance;
      }

      w.solBalance = bal;
      w.lastActivityTs = now;
    })
  );
}

// ---------- main loop ----------

async function main() {
  const { wallets } = parseArgs(process.argv);

  if (!wallets || wallets.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[HUD] No wallets provided. Use --wallet alias:pubkey:color');
    process.exit(1);
  }

  const state = buildInitialState(wallets);

  // Create SolanaTracker RPC client (HTTP + WS).
  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
  const rpcMethods = createRpcMethods(rpc, rpcSubs);

  // TODO (later): wire up actual subscriptions:
  // - account notifications for SOL
  // - token account notifications
  // - signature notifications (to trigger on-demand price refresh)
  //
  // For now, we just log that we created the client so we know WS is live.
  // eslint-disable-next-line no-console
  console.log('[HUD] SolanaTracker RPC client initialized.');
  if (!rpcSubs) {
    // eslint-disable-next-line no-console
    console.warn('[HUD] rpcSubs is null; WS subscriptions are disabled (no SOLANATRACKER_RPC_WS_URL?).');
  }

  // Initial SOL balance fetch
  await refreshAllSolBalances(rpcMethods, state);

  // Periodic SOL refresh using HTTP RPC
  const solTimer = setInterval(() => {
    refreshAllSolBalances(rpcMethods, state).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[HUD] Error refreshing SOL balances:', err.message || err);
    });
  }, HUD_SOL_REFRESH_SEC * 1000);

  // Render loop
  const renderTimer = setInterval(() => {
    renderHud(state);
  }, HUD_RENDER_INTERVAL_MS);

  // Graceful shutdown
  function shutdown() {
    clearInterval(solTimer);
    clearInterval(renderTimer);
    Promise.resolve()
      .then(() => close())
      .catch(() => {})
      .finally(() => {
        process.exit(0);
      });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Initial render
  renderHud(state);
}

// Run if invoked directly
if (require.main === module) {
  // eslint-disable-next-line no-console
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[HUD] Fatal error:', err?.message || err);
    process.exit(1);
  });
}