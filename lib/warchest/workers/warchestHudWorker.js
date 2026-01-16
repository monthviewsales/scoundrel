#!/usr/bin/env node
"use strict";

require("../../env/safeDotenv").loadDotenv();

const path = require("path");
const React = require("react");

const { createHubEventFollower, DEFAULT_EVENT_PATH, DEFAULT_HUD_STATE_PATH } = require("../events");
const { createHudStore } = require("../../hud/hudStore");
const { createWarchestApp } = require("../../hud/warchestInkApp");
const { createWorkerLogger } = require("./workerLogger");
const baseLogger = require("../../logger");
const { createThrottledEmitter } = require("./warchestServiceHelpers");
const { createHudTxFeed } = require("./warchest/hudTxFeed");
const { STABLE_MINTS } = require("../../solana/stableMints");
const { installHudStdoutGuard, loadInkModule } = require("./warchest/hudRenderer");
const { prepareTuiScreen } = require("../../tui/terminal");

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HUD_MAX_TX = intFromEnv("WARCHEST_HUD_MAX_TX", 10);
const HUD_MAX_LOGS = intFromEnv("WARCHEST_HUD_MAX_LOGS", 5);
const WARCHEST_HUD_EMIT_THROTTLE_MS = intFromEnv(
  "WARCHEST_HUD_EMIT_THROTTLE_MS",
  100
);

function resolvePath(targetPath, fallback) {
  if (!targetPath) return fallback;
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(process.cwd(), targetPath);
}

function parseHudArgs(argv) {
  const args = argv.slice(2);
  let followHub = true;
  let hubEventsPath = null;
  let hudStatePath = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-follow-hub") {
      followHub = false;
    } else if (arg === "--follow-hub") {
      followHub = true;
    } else if (arg === "--hub-events") {
      hubEventsPath = args[i + 1] || null;
      i += 1;
    } else if (
      arg === "--hud-state" ||
      arg === "--hud-status" ||
      arg === "--hub-status"
    ) {
      hudStatePath = args[i + 1] || null;
      i += 1;
    } else if (arg === "--wallet") {
      i += 1;
    }
  }

  return { followHub, hubEventsPath, hudStatePath };
}

async function main() {
  process.env.SC_HUD_MODE = "1";
  process.env.WARCHEST_HUD = "1";
  process.env.SC_INK_MODE = "1";

  const { followHub, hubEventsPath, hudStatePath } = parseHudArgs(process.argv);

  const logger = createWorkerLogger({
    workerName: "warchestHud",
    scope: "HUD",
    baseLogger,
    includeCallsite: true,
  });
  const dataLogger =
    typeof baseLogger.solanaTrackerData === "function"
      ? baseLogger.solanaTrackerData()
      : baseLogger;

  const removeStdoutGuard = installHudStdoutGuard();

  let baseSnapshot = {
    state: {},
    hudMaxTx: HUD_MAX_TX,
    hudMaxLogs: HUD_MAX_LOGS,
  };

  let hudStore = null;

  const emitHudChange = createThrottledEmitter(() => {
    if (hudStore && typeof hudStore.emitChange === "function") {
      hudStore.emitChange();
    }
  }, WARCHEST_HUD_EMIT_THROTTLE_MS);

  const txFeed = createHudTxFeed({
    maxItems: HUD_MAX_TX,
    logger,
    dataLogger,
    emitChange: emitHudChange,
  });

  hudStore = createHudStore(() => {
    const snapshot =
      baseSnapshot && typeof baseSnapshot === "object" ? baseSnapshot : {};
    const hudMaxTx =
      Number.isFinite(Number(snapshot.hudMaxTx)) && snapshot.hudMaxTx > 0
        ? snapshot.hudMaxTx
        : HUD_MAX_TX;
    const hudMaxLogs =
      Number.isFinite(Number(snapshot.hudMaxLogs)) && snapshot.hudMaxLogs > 0
        ? snapshot.hudMaxLogs
        : HUD_MAX_LOGS;

    return {
      ...snapshot,
      state:
        snapshot.state && typeof snapshot.state === "object"
          ? { ...snapshot.state }
          : {},
      hudMaxTx,
      hudMaxLogs,
      transactions: txFeed.getFeed(),
    };
  });

  const statusPath = resolvePath(hudStatePath, DEFAULT_HUD_STATE_PATH);
  const eventPath = resolvePath(hubEventsPath, DEFAULT_EVENT_PATH);

  let follower = null;
  if (followHub !== false) {
    try {
      follower = createHubEventFollower({
        statusPath,
        eventPath,
        readInitial: true,
      });
      follower.onStatus((snapshot) => {
        baseSnapshot =
          snapshot && typeof snapshot === "object"
            ? snapshot
            : { state: {}, hudMaxTx: HUD_MAX_TX, hudMaxLogs: HUD_MAX_LOGS };
        emitHudChange();
      });
      follower.onEvents((events) => {
        txFeed.ingestEvents(events).catch((err) => {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Failed to ingest tx events: ${msg}`);
        });
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to start hub follower: ${msg}`);
    }
  }

  const ink = await loadInkModule();
  const { render } = ink;
  const restoreScreen = prepareTuiScreen();
  const WarchestApp = createWarchestApp(ink);
  const inkApp = render(
    React.createElement(WarchestApp, {
      hudStore,
      stableMints: STABLE_MINTS,
    })
  );

  async function shutdown(reason) {
    logger.info(`[HUD] Shutting down HUD worker (${reason || "shutdown"}).`);
    if (follower && typeof follower.close === "function") {
      follower.close();
      follower = null;
    }
    if (typeof removeStdoutGuard === "function") {
      try {
        removeStdoutGuard();
      } catch {}
    }
    if (inkApp && typeof inkApp.unmount === "function") {
      inkApp.unmount();
    }
    if (typeof restoreScreen === "function") {
      restoreScreen();
    }
    if (hudStore && typeof hudStore.removeAllListeners === "function") {
      hudStore.removeAllListeners();
    }
    process.exit(0);
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    const msg = err && err.message ? err.message : err;
    baseLogger.error(`[HUD] Fatal error: ${msg}`);
    process.exit(1);
  });
}
