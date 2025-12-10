'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger');
const wallets = require('../wallets');
const { listAutoAttachedWarchestWallets, getDefaultFundingWallet } = require('../wallets/registry');
const { DEFAULT_EVENT_PATH, DEFAULT_STATUS_PATH } = require('../warchest/events');

const LEGACY_DATA_DIR = path.join(__dirname, '..', '..', 'data', 'warchest');
const LEGACY_PID_PATH = path.join(LEGACY_DATA_DIR, 'warchest.pid');
const WORKER_SCRIPT = path.join(__dirname, '..', 'warchest', 'workers', 'warchestHudWorker.js');

function clearLegacyPid() {
  try {
    if (fs.existsSync(LEGACY_PID_PATH)) {
      fs.unlinkSync(LEGACY_PID_PATH);
      return true;
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('[warchest] warning: failed to remove legacy PID:', err?.message || err);
    }
  }
  return false;
}

function readStatusSnapshot(statusPath = DEFAULT_STATUS_PATH) {
  try {
    const raw = fs.readFileSync(statusPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function logStatusSnapshot(snapshot, targetPath) {
  const { updatedAt, health } = snapshot;
  if (!health || typeof health !== 'object') {
    logger.warn(`[warchest] status: snapshot at ${targetPath} is missing health object`);
    return;
  }

  if (updatedAt) {
    const ts = Date.parse(updatedAt);
    const ageMs = Number.isNaN(ts) ? null : Date.now() - ts;
    if (ageMs != null) {
      logger.info(`[warchest] status: last update at ${updatedAt} (${Math.round(ageMs / 1000)}s ago)`);
    } else {
      logger.info(`[warchest] status: last update at ${updatedAt}`);
    }
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
 * Resolve wallet specs for the warchest HUD/hub flows.
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
      '[warchest] no wallets resolved for HUD/hub. Configure a default funding wallet or ' +
        'set autoAttachWarchest=true on one or more wallets before starting.',
    );
  }

  return specs;
}

function buildHudArgs({ walletSpecs, interactive, followHub, hubEventsPath, hubStatusPath }) {
  const args = [
    WORKER_SCRIPT,
    ...buildWalletArgs(walletSpecs),
  ];

  if (interactive) {
    args.push('--hud');
  }

  if (followHub !== false) {
    args.push('--follow-hub');
    args.push('--hub-events', hubEventsPath || DEFAULT_EVENT_PATH);
    args.push('--hub-status', hubStatusPath || DEFAULT_STATUS_PATH);
  }

  return args;
}

function spawnHudWorker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      logger.info(`[warchest] HUD worker exited (${reason})`);
      resolve({ code, signal });
    });
  });
}

/**
 * Start the warchest HUD worker in foreground mode, optionally following hub events.
 * Legacy PID files are cleared before launching; the worker lifecycle is managed by the harness/hub.
 *
 * @param {Object} opts
 * @param {string[]} [opts.walletSpecs] - Array of wallet specs alias:pubkey:color
 * @param {boolean} [opts.hud=false] - Whether to start with HUD rendering enabled
 * @param {boolean} [opts.followHub=true] - Whether to follow hub status/event files
 * @param {string} [opts.hubEventsPath] - Optional override for hub event file path
 * @param {string} [opts.hubStatusPath] - Optional override for hub status file path
 * @returns {Promise<void>}
 */
async function start(opts) {
  const { walletSpecs = [], hud = false, followHub = true, hubEventsPath, hubStatusPath } = opts || {};
  clearLegacyPid();

  const resolvedWalletSpecs = await resolveWalletSpecsFromConfig(walletSpecs);

  if (!resolvedWalletSpecs || resolvedWalletSpecs.length === 0) {
    logger.warn('[warchest] start aborted: no wallets available to attach.');
    return;
  }

  const args = buildHudArgs({
    walletSpecs: resolvedWalletSpecs,
    interactive: hud,
    followHub,
    hubEventsPath,
    hubStatusPath,
  });

  logger.info(
    `[warchest] launching HUD worker (mode=${hud ? 'hud' : 'headless'}, followHub=${followHub !== false})`,
  );

  await spawnHudWorker(args);
}

/**
 * Clear legacy daemon artifacts. The harness/hub no longer manages a background PID.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  const removed = clearLegacyPid();
  if (removed) {
    logger.info('[warchest] removed legacy warchest.pid (harness/hub no longer uses it).');
  } else {
    logger.info('[warchest] no background daemon to stop; harness/hub runs HUD workers in the foreground.');
  }
}

/**
 * Restart the HUD worker by clearing legacy artifacts and launching a fresh foreground worker.
 *
 * @param {Object} opts
 * @param {string[]} [opts.walletSpecs]
 * @param {boolean} [opts.hud]
 * @param {boolean} [opts.followHub]
 * @param {string} [opts.hubEventsPath]
 * @param {string} [opts.hubStatusPath]
 * @returns {Promise<void>}
 */
async function restart(opts) {
  logger.info('[warchest] restart requested');
  await stop();
  await start(opts);
}

/**
 * Run a one-off HUD session with rendering enabled.
 * Wallet resolution mirrors daemon start but always enables HUD output.
 *
 * @param {Object} opts
 * @param {string[]} [opts.walletSpecs]
 * @param {boolean} [opts.followHub=true]
 * @param {string} [opts.hubEventsPath]
 * @param {string} [opts.hubStatusPath]
 * @returns {Promise<void>}
 */
async function hud(opts) {
  const { walletSpecs = [], followHub = true, hubEventsPath, hubStatusPath } = opts || {};
  let resolvedWalletSpecs = await resolveWalletSpecsFromConfig(walletSpecs);

  if (!resolvedWalletSpecs || resolvedWalletSpecs.length === 0) {
    logger.warn(
      '[warchest] No default or auto-attach wallets configured for HUD. Launching interactive wallet selector...'
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

  const args = buildHudArgs({
    walletSpecs: resolvedWalletSpecs,
    interactive: true,
    followHub,
    hubEventsPath,
    hubStatusPath,
  });

  logger.info(`[warchest] hud requested (wallets=${resolvedWalletSpecs.length}, followHub=${followHub !== false})`);
  await spawnHudWorker(args);
}

/**
 * Report the latest HUD/hub status snapshot.
 *
 * @param {Object} [opts]
 * @param {string} [opts.statusPath] - Optional override for the hub status path.
 * @returns {Promise<void>}
 */
async function status(opts) {
  clearLegacyPid();
  const statusPath = (opts && opts.statusPath) || DEFAULT_STATUS_PATH;
  const snapshot = readStatusSnapshot(statusPath);

  if (!snapshot) {
    logger.warn(`[warchest] status: no status snapshot found at ${statusPath}`);
    return;
  }

  logStatusSnapshot(snapshot, statusPath);
}

module.exports = {
  start,
  stop,
  restart,
  hud,
  status,
};
