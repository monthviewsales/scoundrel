'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const logger = require('../logger');
const wallets = require('../wallets');
const { listAutoAttachedWarchestWallets, getDefaultFundingWallet } = require('../wallets/registry');

// Data directory and PID file for the warchest daemon
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'warchest');
const PID_PATH = path.join(DATA_DIR, 'warchest.pid');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
// Path to the actual daemon / HUD worker script
const WORKER_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'warchestHudWorker.js');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_PATH, 'utf8');
    const pid = Number(raw.trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    // signal 0 just checks for existence/permission
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(pid) {
  ensureDataDir();
  fs.writeFileSync(PID_PATH, String(pid), 'utf8');
}

function clearPid() {
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    // ignore missing file
  }
}

function clearStatusSnapshot() {
  try {
    if (fs.existsSync(STATUS_PATH)) {
      fs.unlinkSync(STATUS_PATH);
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('[warchest] warning: failed to clear status snapshot:', err?.message || err);
    }
  }
}

function readStatusSnapshot() {
  try {
    const raw = fs.readFileSync(STATUS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
/**
 * Report the current warchest daemon status and last health snapshot.
 *
 * This reads the PID file (if present) and the status.json snapshot written
 * by the HUD worker in daemon mode. It logs a human-friendly summary
 * indicating whether the daemon is running, how fresh the health snapshot is,
 * and key metrics like uptime, RSS, slot, and wallet count when available.
 *
 * @returns {Promise<void>}
 */
async function status() {
  ensureDataDir();

  const pid = readPid();
  const alive = pid && isProcessAlive(pid);

  if (!pid) {
    logger.warn('[warchest] status: no PID file found (daemon not running?)');
    return;
  }

  if (!alive) {
    logger.warn(`[warchest] status: PID file present (pid=${pid}) but process is not running`);
    return;
  }

  logger.info(`[warchest] status: daemon running (pid=${pid})`);

  const snapshot = readStatusSnapshot();
  if (!snapshot) {
    logger.warn('[warchest] status: no status.json snapshot found');
    return;
  }

  const { updatedAt, health } = snapshot;
  let ageMs = null;

  if (updatedAt) {
    const ts = Date.parse(updatedAt);
    if (!Number.isNaN(ts)) {
      ageMs = Date.now() - ts;
    }
  }

  if (ageMs != null) {
    const ageSec = Math.round(ageMs / 1000);
    logger.info(`[warchest] status: last health update at ${updatedAt} (${ageSec}s ago)`);
  } else if (updatedAt) {
    logger.info(`[warchest] status: last health update at ${updatedAt}`);
  }

  if (!health || typeof health !== 'object') {
    logger.warn('[warchest] status: snapshot has no health object');
    return;
  }

  const processHealth = health.process || {};
  const wsHealth = health.ws || {};
  const walletsHealth = health.wallets || {};
  const rpcHealth = health.rpc || health.rpcStats || {};

  const uptimeSec = processHealth.uptimeSec;
  const rssBytes = processHealth.rssBytes;
  const lagMs = processHealth.eventLoopLagMs;
  const rssMb = typeof rssBytes === 'number' ? Math.round(rssBytes / 1024 / 1024) : null;

  if (uptimeSec != null) {
    const rssPart = rssMb != null ? ` rss=${rssMb}MB` : '';
    const lagPart = lagMs != null ? ` lag=${lagMs}ms` : '';
    logger.info(`[warchest] status: process uptime=${uptimeSec}s${rssPart}${lagPart}`);
  }

  if (wsHealth.slot != null) {
    const wsAge = wsHealth.lastSlotAgeMs != null ? ` age=${wsHealth.lastSlotAgeMs}ms` : '';
    logger.info(`[warchest] status: chain slot=${wsHealth.slot}${wsAge}`);
  }

  if (walletsHealth.count != null) {
    logger.info(`[warchest] status: wallets attached=${walletsHealth.count}`);
  }

  if (rpcHealth.solMs != null || rpcHealth.tokensMs != null || rpcHealth.dataMs != null) {
    const solPart = rpcHealth.solMs != null ? ` sol=${rpcHealth.solMs}ms` : '';
    const tokensPart = rpcHealth.tokensMs != null ? ` tokens=${rpcHealth.tokensMs}ms` : '';
    const dataPart = rpcHealth.dataMs != null ? ` data=${rpcHealth.dataMs}ms` : '';
    logger.info(`[warchest] status: rpc timings:${solPart}${tokensPart}${dataPart}`);
  }
}

function buildWalletArgs(walletSpecs) {
  const args = [];
  if (!Array.isArray(walletSpecs)) return args;

  for (const spec of walletSpecs) {
    if (typeof spec !== 'string' || !spec.trim()) continue;
    args.push('--wallet', spec.trim());
  }

  return args;
}

/**
 * Resolve wallet specs for the warchest daemon.
 *
 * Priority:
 *   1. Explicit walletSpecs passed in.
 *   2. Wallets marked autoAttachWarchest=true.
 *   3. Default funding wallet (if configured).
 *
 * @param {string[]} walletSpecs
 * @returns {Promise<string[]>}
 */
async function resolveWalletSpecsFromConfig(walletSpecs) {
  if (Array.isArray(walletSpecs) && walletSpecs.length > 0) {
    return walletSpecs;
  }

  let specs = [];

  // 1) Wallets explicitly marked as auto-attach to warchest.
  try {
    const autoWallets = await listAutoAttachedWarchestWallets();
    if (Array.isArray(autoWallets) && autoWallets.length > 0) {
      specs = autoWallets.map((w) => {
        const color = w.color || 'blue';
        return `${w.alias}:${w.pubkey}:${color}`;
      });
    }
  } catch (err) {
    if (logger.debug) {
      logger.debug('[warchest] resolveWalletSpecsFromConfig: listAutoAttachedWarchestWallets failed', err);
    }
  }

  // 2) Fallback to default funding wallet if nothing auto-attached.
  if (!specs.length) {
    try {
      const defaultWallet = await getDefaultFundingWallet();
      if (defaultWallet && defaultWallet.alias && defaultWallet.pubkey) {
        const color = defaultWallet.color || 'blue';
        specs.push(`${defaultWallet.alias}:${defaultWallet.pubkey}:${color}`);
      }
    } catch (err) {
      if (logger.debug) {
        logger.debug('[warchest] resolveWalletSpecsFromConfig: getDefaultFundingWallet failed', err);
      }
    }
  }

  if (!specs.length) {
    logger.error(
      '[warchest] no wallets resolved for daemon. Configure a default funding wallet or ' +
        'set autoAttachWarchest=true on one or more wallets before starting.',
    );
  }

  return specs;
}

/**
 * Start the warchest daemon (or HUD) process.
 * When `hud` is true, the worker runs in the foreground with inherited stdio.
 * When `hud` is false, the worker is detached and its PID is recorded.
 *
 * If no walletSpecs are provided, they will be resolved from configuration using:
 *   - wallets marked autoAttachWarchest=true, or
 *   - the default funding wallet (if configured).
 *
 * @param {Object} opts
 * @param {string[]} [opts.walletSpecs] - Array of wallet specs alias:pubkey:color
 * @param {boolean} [opts.hud=false] - Whether to start with HUD enabled
 * @returns {Promise<void>}
 */
async function start(opts) {
  const { walletSpecs = [], hud = false } = opts || {};
  console.debug('[warchest] start() received opts:', { walletSpecs, hud });

  ensureDataDir();

  const resolvedWalletSpecs = await resolveWalletSpecsFromConfig(walletSpecs);

  if (!resolvedWalletSpecs || resolvedWalletSpecs.length === 0) {
    logger.warn('[warchest] start aborted: no wallets available to attach.');
    return;
  }

  const existingPid = readPid();
  if (!hud && existingPid && isProcessAlive(existingPid)) {
    logger.warn(`[warchest] start requested but daemon already running (pid=${existingPid})`);
    return;
  }

  const workerArgs = [
    WORKER_SCRIPT,
    ...buildWalletArgs(resolvedWalletSpecs),
  ];

  if (hud) {
    workerArgs.push('--hud');
  }

  logger.info(
    `[warchest] start requested (mode=${hud ? 'hud' : 'daemon'}, wallets=${resolvedWalletSpecs.length})`
  );

  const child = spawn(process.execPath, workerArgs, {
    detached: !hud,
    stdio: hud ? 'inherit' : 'ignore',
    env: process.env,
  });

  if (hud) {
    // Foreground HUD: let the process run attached to the current TTY.
    // We do not manage a PID file in this mode.
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      logger.info(`[warchest] HUD process exited (${reason})`);
    });
    return;
  }

  // Daemon mode: detach and record PID
  child.unref();
  writePid(child.pid);
  logger.info(`[warchest] daemon started pid=${child.pid}`);
}

/**
 * Stop the background warchest daemon process using the PID file.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  const pid = readPid();
  if (!pid) {
    logger.warn('[warchest] stop requested but no PID file found (daemon not running?)');
    return;
  }

  logger.info(`[warchest] stop requested for pid=${pid}`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[warchest] error sending SIGTERM to pid=${pid}: ${msg}`);
  }

  clearPid();
  clearStatusSnapshot();
}

/**
 * Restart the warchest daemon with the provided options.
 *
 * @param {Object} opts
 * @param {string[]} opts.walletSpecs
 * @param {boolean} [opts.hud=false]
 * @returns {Promise<void>}
 */
async function restart(opts) {
  logger.info('[warchest] restart requested');
  await stop();
  await start(opts);
}

/**
 * Run a one-off HUD session in the foreground without PID management.
 *
 * Wallet resolution rules:
 *   1. Use any explicit walletSpecs provided.
 *   2. Otherwise, resolve from configuration (autoAttachWarchest/default funding).
 *   3. If still no wallets, fall back to an interactive picker so the user
 *      can choose a wallet for this HUD session.
 *
 * @param {Object} opts
 * @param {string[]} [opts.walletSpecs]
 * @returns {Promise<void>}
 */
async function hud(opts) {
  const { walletSpecs = [] } = opts || {};
  console.debug('[warchest] hud() received opts:', { walletSpecs });

  // First, try to resolve wallets using the same config logic as the daemon.
  let resolvedWalletSpecs = await resolveWalletSpecsFromConfig(walletSpecs);

  // If nothing was resolved, fall back to an interactive picker.
  if (!resolvedWalletSpecs || resolvedWalletSpecs.length === 0) {
    logger.warn(
      '[warchest] No default or auto-attach wallets configured for HUD. ' +
        'Launching interactive wallet selector...'
    );

    const selector =
      wallets.selection && typeof wallets.selection.selectWalletInteractively === 'function'
        ? wallets.selection.selectWalletInteractively
        : null;

    if (!selector) {
      logger.error('[warchest] HUD aborted: wallet selector unavailable.');
      return;
    }

    const selection = await selector({
      allowOther: true,
      promptLabel: 'Select a wallet to use for the warchest HUD:',
    });

    if (!selection || !selection.walletAddress) {
      logger.error('[warchest] HUD aborted: no wallet selected.');
      return;
    }

    const color = 'blue';
    resolvedWalletSpecs = [
      `${selection.walletLabel || 'wallet'}:${selection.walletAddress}:${color}`,
    ];
  }

  const workerArgs = [
    WORKER_SCRIPT,
    ...buildWalletArgs(resolvedWalletSpecs),
    '--hud',
  ];

  logger.info(`[warchest] hud requested (wallets=${resolvedWalletSpecs.length})`);

  const result = spawnSync(process.execPath, workerArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    const msg = result.error && result.error.message ? result.error.message : result.error;
    logger.error(`[warchest] HUD error: ${msg}`);
  }
}

/**
 * Ensure the warchest daemon is running.
 * If a live PID is found, this is a no-op.
 * If no PID is found (or the process is dead), it starts the daemon.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.walletSpecs] - Wallet specs alias:pubkey:color
 * @param {boolean} [opts.hud=false] - Whether to start with HUD enabled (usually false in daemon mode)
 * @returns {Promise<void>}
 */
async function ensureDaemonRunning(opts) {
  const { walletSpecs = [], hud = false } = opts || {};

  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.debug('[warchest] ensureDaemonRunning: daemon already running', { pid: existingPid });
    return;
  }

  logger.info('[warchest] ensureDaemonRunning: daemon not running; starting now');
  await start({ walletSpecs, hud });
}

module.exports = {
  start,
  stop,
  restart,
  hud,
  status,
  ensureDaemonRunning,
};
