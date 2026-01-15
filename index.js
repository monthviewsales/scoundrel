#!/usr/bin/env node
// index.js — Scoundrel CLI
require("./lib/env/safeDotenv").loadDotenv();
const logger = require("./lib/logger");
const React = require("react");
const { program } = require("commander");
const { existsSync, readFileSync } = require("fs");
const { join, relative } = require("path");
const BootyBox = require("./db");
const warchestModule = require("./lib/cli/walletCli");
const warchestService = require("./lib/cli/warchest");
const { forkWorkerWithPayload } = require("./lib/warchest/workers/harness");
const {
  getHubCoordinator,
  closeHubCoordinator,
} = require("./lib/warchest/hub");
const warchestRun =
  typeof warchestModule === "function"
    ? warchestModule
    : warchestModule && typeof warchestModule.run === "function"
    ? warchestModule.run
    : null;

function loadProcessor(name) {
  try {
    return require(`./lib/cli/${name}`);
  } catch (e) {
    logger.error(
      `[scoundrel] Missing ./lib/${name}. Create it and export a function (module.exports = async (args) => { ... }) or a named export.`
    );
    process.exit(1);
  }
}

function resolveVersion() {
  try {
    const lockPath = join(__dirname, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock && lock.version) return lock.version;
  } catch (_) {}
  try {
    // Fallback to package.json if lock parsing fails.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const pkg = require("./package.json");
    if (pkg && pkg.version) return pkg.version;
  } catch (_) {}
  return "0.0.0";
}


program
  .name("scoundrel")
  .description(
    "Research & validation tooling for memecoin trading using SolanaTracker + OpenAI"
  )
  .version(resolveVersion());

program.addHelpText(
  "after",
  `\nEnvironment:\n  OPENAI_API_KEY              Required for OpenAI Responses\n  OPENAI_RESPONSES_MODEL      (default: gpt-5-mini)\n  FEATURE_MINT_COUNT          (default: 8) Number of recent mints to summarize for technique features\n  SOLANATRACKER_API_KEY       Required for SolanaTracker Data API\n  NODE_ENV                    development|production (controls logging verbosity)\n`
);
program.addHelpText(
  "after",
  `\nDatabase env:\n  BOOTYBOX_SQLITE_PATH        Optional override for db/bootybox.db\n`
);

program
  .command("vectorstore-prune")
  .description("Prune vector store files by filename prefix and age")
  .option(
    "--vector-store-id <id>",
    "Vector store id (defaults to WARLORDAI_VECTOR_STORE)"
  )
  .option(
    "--prefix <prefix>",
    "Filename prefix(es) to match (comma-separated)",
    "targetscan"
  )
  .option(
    "--older-than-hours <n>",
    "Delete files older than N hours (default 24)"
  )
  .option(
    "--older-than-seconds <n>",
    "Delete files older than N seconds (overrides hours)"
  )
  .option("--dry-run", "List matches without deleting")
  .option("--delete-file", "Also delete underlying file objects")
  .option("--max-deletes <n>", "Stop after deleting N files")
  .option("--timeout-ms <n>", "Worker timeout in ms (0 disables)", "900000")
  .action(async (opts) => {
    const vectorStoreId = opts?.vectorStoreId
      ? String(opts.vectorStoreId).trim()
      : null;
    const prefix = opts?.prefix ? String(opts.prefix).trim() : null;
    const olderThanSeconds = Number(opts?.olderThanSeconds);
    const olderThanHours = Number(opts?.olderThanHours);
    const maxDeletes = Number(opts?.maxDeletes);
    const timeoutMsInput = Number(opts?.timeoutMs);
    const timeoutMs =
      Number.isFinite(timeoutMsInput) && timeoutMsInput >= 0
        ? timeoutMsInput
        : 900000;
    const resolvedStoreId = vectorStoreId || process.env.WARLORDAI_VECTOR_STORE;

    if (!resolvedStoreId) {
      logger.error(
        "[scoundrel] vectorstore-prune requires WARLORDAI_VECTOR_STORE or --vector-store-id"
      );
      process.exitCode = 1;
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      logger.error(
        "[scoundrel] OPENAI_API_KEY is required for vectorstore-prune"
      );
      process.exitCode = 1;
      return;
    }

    const payload = {
      action: "prune",
      ...(vectorStoreId ? { vectorStoreId } : {}),
      ...(prefix ? { prefix } : {}),
      ...(Number.isFinite(olderThanSeconds) && olderThanSeconds > 0
        ? { olderThanSeconds }
        : Number.isFinite(olderThanHours) && olderThanHours > 0
        ? { olderThanHours }
        : {}),
      ...(opts?.dryRun ? { dryRun: true } : {}),
      ...(opts?.deleteFile ? { deleteFile: true } : {}),
      ...(Number.isFinite(maxDeletes) && maxDeletes > 0 ? { maxDeletes } : {}),
    };

    try {
      const workerPath = join(
        __dirname,
        "lib",
        "warchest",
        "workers",
        "vectorStoreWorker.js"
      );
      const { result } = await forkWorkerWithPayload(workerPath, {
        timeoutMs,
        payload,
      });

      if (!result || result.skipped) {
        logger.info("[scoundrel] vector store prune skipped");
        return;
      }

      logger.info(
        `[scoundrel] vector store prune complete: scanned=${
          result.scanned || 0
        } ` +
          `matched=${result.matched || 0} deleted=${result.deleted || 0} ` +
          `dryRun=${result.dryRun ? "true" : "false"} errors=${
            result.errors || 0
          }`
      );
    } catch (err) {
      logger.error(
        `[scoundrel] vectorstore-prune failed: ${err?.message || err}`
      );
      process.exitCode = 1;
    }
  });

program
  .command("targetlist")
  .description(
    "Fetch target list candidates from SolanaTracker (volume + trending) and write raw artifacts"
  )
  .option(
    "--daemon",
    "Run in background on interval (uses WARCHEST_TARGET_LIST_INTERVAL_MS)"
  )
  .option("--interval <ms|OFF>", "Override interval in ms (or OFF to disable)")
  .addHelpText(
    "after",
    `\nExamples:\n  $ scoundrel targetlist\n  $ scoundrel targetlist --interval 600000\n  $ scoundrel targetlist --daemon\n\nNotes:\n  • Uses SOLANATRACKER_API_KEY from .env.\n  • Writes raw JSON artifacts under ./data/targetlist/ when SAVE_RAW is enabled.\n  • WARCHEST_TARGET_LIST_INTERVAL_MS controls the timer interval when running with --daemon.\n`
  )
  .action(async (opts) => {
    const intervalMs =
      opts && opts.interval ? String(opts.interval).trim() : undefined;
    const runOnce = !(opts && opts.daemon);
    const payload = {
      runOnce,
      ...(intervalMs ? { intervalMs } : {}),
    };

    const hub = getHubCoordinator();
    try {
      const result = await hub.runTargetList(payload, {
        detached: !runOnce,
        timeoutMs: runOnce ? 60000 : undefined,
      });

      if (!runOnce) {
        logger.info(
          `[scoundrel] target list worker detached (pid=${result.pid})`
        );
        logger.info(`[scoundrel] payload file: ${result.payloadFile}`);
        return;
      }

      if (result && result.artifacts) {
        const { volumePath, trendingPath } = result.artifacts;
        if (volumePath) {
          logger.info(`[scoundrel] target list volume artifact: ${volumePath}`);
        } else {
          logger.info(
            "[scoundrel] target list volume response captured (artifact save disabled)."
          );
        }
        if (trendingPath) {
          logger.info(
            `[scoundrel] target list trending artifact: ${trendingPath}`
          );
        } else {
          logger.info(
            "[scoundrel] target list trending response captured (artifact save disabled)."
          );
        }
      }
      if (result && result.counts) {
        const { volume, trending } = result.counts;
        if (volume != null || trending != null) {
          logger.info(
            `[scoundrel] target list counts: volume=${
              volume ?? "n/a"
            } trending=${trending ?? "n/a"}`
          );
        }
      }
    } catch (err) {
      const message = err?.message || String(err);
      logger.error(`[scoundrel] target list failed: ${message}`);
      process.exitCode = 1;
    } finally {
      closeHubCoordinator();
    }
  });

program
  .command("tx")
  .argument("<signature>", "Solana transaction signature to inspect")
  .description(
    "Inspect a Solana transaction via SolanaTracker (status, fees, SOL balance changes)"
  )
  .option(
    "--sig <signature>",
    "Additional transaction signature to inspect (may be repeated)",
    (value, previous) => {
      if (!previous) return [value];
      return previous.concat(value);
    }
  )
  .option(
    "--swap",
    "Also interpret this transaction as a swap for a specific wallet/mint"
  )
  .option(
    "-s, --session",
    "Interactive review session for this transaction (TUI)"
  )
  .option(
    "-w, --wallet <aliasOrAddress>",
    "Wallet alias or address that initiated the swap (focus wallet)"
  )
  .option("-m, --mint <mint>", "SPL mint address for the swapped token")
  .addHelpText(
    "after",
    `\nExamples:\n  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ
  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ --sig ANOTHER_SIG --sig THIRD_SIG
  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ -s
  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ --swap --wallet DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

Notes:
  • Uses SolanaTracker RPC via your configured API key.
  • Shows status, network fee, and per-account SOL balance changes.
  • With --swap, also computes token + SOL deltas for the given wallet/mint.
  • With -s/--session, runs an interactive review session after inspection.
`
  )
  .action(async (signature, cmd) => {
    const txProcessor = loadProcessor("tx");

    const runner =
      typeof txProcessor === "function"
        ? txProcessor
        : txProcessor && txProcessor.run;

    if (!runner) {
      logger.error(
        "[scoundrel] ./lib/tx must export a default function or { run }"
      );
      process.exit(1);
    }

    try {
      await runner({ signature, cmd });
      process.exit(0);
    } catch (err) {
      const msg =
        err && (err.stack || err.message) ? err.stack || err.message : err;
      logger.error("[scoundrel] ❌ tx command failed:", msg);
      process.exit(1);
    }
  });

// --- swap command ---
program
  .command("swap")
  .argument("[mint]", "Token mint address to swap")
  .description(
    "Execute a token swap via the SolanaTracker swap API or manage swap configuration"
  )
  .option(
    "-w, --wallet <aliasOrAddress>",
    "Wallet alias or address from the wallet registry (ignored when using -c/--config)"
  )
  .option(
    "-b, --buy <amount>",
    "Spend <amount> SOL (number or '<percent>%') to buy the token"
  )
  .option(
    "-s, --sell <amount>",
    "Sell <amount> of the token (number, 'auto', or '<percent>%')"
  )
  .option(
    "--dry-run",
    "Build and simulate the swap without broadcasting the transaction"
  )
  .option(
    "--detach",
    "Return immediately after tx submission; confirmation/persistence runs in background"
  )
  .option(
    "-c, --config",
    "Manage swap configuration instead of executing a swap"
  )
  .addHelpText(
    "after",
    `\nExamples:\n  # Execute swaps\n  $ scoundrel swap 36xsfxxxxxxxxx2rta5pump -w warlord -b 0.1\n  $ scoundrel swap 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s 50%\n  $ scoundrel swap 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s auto --detach\n\n  # Manage swap configuration\n  $ scoundrel swap --config\n`
  )
  .action(async (mint, cmdOrOpts) => {
    // Commander v14 may pass either (args..., options) or (args..., Command).
    // If the last parameter has an .opts() function, treat it as the Command instance;
    // otherwise assume it's already the plain options object.
    const hasOptsMethod = cmdOrOpts && typeof cmdOrOpts.opts === "function";
    const opts = hasOptsMethod ? cmdOrOpts.opts() : cmdOrOpts || {};

    // Config mode (-c/--config): launch the swap config TUI
    if (opts.config) {
      try {
        const { loadSwapConfigApp } = require("./lib/tui/swapConfigApp");
        const { render } = await import("ink");
        const { SwapConfigApp } = await loadSwapConfigApp();
        const { waitUntilExit } = render(
          React.createElement(SwapConfigApp, { onComplete: () => {} })
        );
        await waitUntilExit();
        return;
      } catch (err) {
        logger.error(
          "[scoundrel:swap-config] ❌ config UI failed:",
          err?.message || err
        );
        process.exitCode = 1;
        return;
      }
    }

    // Swap execution mode: enforce -b/--buy or -s/--sell semantics and delegate to ./lib/cli/swap
    if (!mint) {
      logger.error(
        "[scoundrel] swap requires a mint when not using -c/--config."
      );
      process.exit(1);
    }

    const hasBuy = !!opts.buy;
    const hasSell = !!opts.sell;

    if (!hasBuy && !hasSell) {
      logger.error(
        "[scoundrel] swap requires exactly one of -b/--buy or -s/--sell."
      );
      process.exit(1);
    }

    if (hasBuy && hasSell) {
      logger.error(
        "[scoundrel] swap cannot use both -b/--buy and -s/--sell in the same command."
      );
      process.exit(1);
    }

    // Sell semantics: auto = 100%, bare -s = 100%, "<percent>%" = percent of token balance
    if (hasSell) {
      const raw = String(opts.sell).trim();
      if (!raw || raw.toLowerCase() === "auto") {
        // Treat as 100% panic dump; CLI passes a normalized flag for trade implementation.
        opts.sell = "100%";
        opts._panic = true;
      } else if (raw.endsWith("%")) {
        // Percent-of-balance sell; leave as-is for downstream interpretation.
        opts.sell = raw;
      } else {
        // Numeric amount sell is allowed; leave as-is.
        opts.sell = raw;
      }
    }

    // Buy semantics: "<percent>%" = percent of SOL balance; numeric = SOL amount
    if (hasBuy) {
      const raw = String(opts.buy).trim();
      if (raw.endsWith("%")) {
        // Percent-of-SOL-balance buy; leave as-is for downstream interpretation.
        opts.buy = raw;
      } else {
        // Numeric amount buy is allowed; leave as-is.
        opts.buy = raw;
      }
    }

    try {
      const tradeCli = require("./lib/cli/swap");
      if (typeof tradeCli !== "function") {
        logger.error(
          "[scoundrel] ./lib/cli/swap must export a default function (module.exports = async (mint, opts) => { ... })"
        );
        process.exit(1);
      }
      await tradeCli(mint, opts);
      process.exit(0);
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.error(`[scoundrel] ❌ swap failed: ${msg}`);
      if (err && err.stack && logger.debug) {
        logger.debug(err.stack);
      }
      process.exit(1);
    }
  });

program
  .command("addcoin")
  .argument("<mint>", "Token mint address to add to the Scoundrel DB")
  .description(
    "Fetch token metadata via SolanaTracker SDK and persist it through tokenInfoService"
  )
  .option(
    "-f, --force",
    "Force refresh from API and skip cached DB metadata",
    false
  )
  .addHelpText(
    "after",
    `
Examples:
  $ scoundrel addcoin <MINT>
  $ scoundrel addcoin 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump

Notes:
  • Uses the SolanaTracker Data API SDK to fetch token metadata for the given mint.
  • Delegates persistence to lib/tokenInfoService.js (e.g., addOrUpdateCoin).
`
  )
  .action(async (mint, opts, cmd) => {
    const forceRefresh = !!opts.force;
    const addcoinProcessor = loadProcessor("addcoin");

    const runner =
      typeof addcoinProcessor === "function"
        ? addcoinProcessor
        : addcoinProcessor && addcoinProcessor.run;

    if (!runner) {
      logger.error(
        "[scoundrel] ./lib/addcoin must export a default function or { run }"
      );
      process.exit(1);
    }

    try {
      const opts = cmd && typeof cmd.opts === "function" ? cmd.opts() : {};
      const forceRefresh = !!opts.force;
      logger.debug("[scoundrel] addcoin CLI opts", opts);
      logger.debug("[scoundrel] addcoin CLI forceRefresh computed", {
        forceRefresh,
      });
      await runner({ mint, forceRefresh });
      logger.info(`[scoundrel] ✅ addcoin completed for mint ${mint}`);
      process.exit(0);
    } catch (err) {
      logger.error("[scoundrel] ❌ addcoin failed:", err?.message || err);
      process.exit(1);
    }
  });

program
  .command("wallet")
  .description("Manage your Scoundrel wallet registry")
  .argument("[subcommand]", "add|list|remove|set-color")
  .argument("[arg1]", "First argument for subcommand (e.g., alias)")
  .argument("[arg2]", "Second argument for subcommand (e.g., color)")
  .option(
    "-s, --solo",
    "Select a single wallet interactively (registry-only for now)"
  )
  .addHelpText(
    "after",
    `
Examples:
  $ scoundrel wallet add
  $ scoundrel wallet list
  $ scoundrel wallet remove sampleWallet
  $ scoundrel wallet set-color sampleWallet cyan
  $ scoundrel wallet -solo
`
  )
  .action(async (subcommand, arg1, arg2, cmd) => {
    const args = [];

    const opts = cmd.opts ? cmd.opts() : {};
    if (opts.solo) {
      // wallet CLI expects "-solo" or "--solo" in argv
      args.push("-solo");
    }

    if (subcommand) args.push(subcommand);
    if (arg1) args.push(arg1);
    if (arg2) args.push(arg2);

    try {
      if (!warchestRun) {
        throw new Error(
          "warchest command module does not export a runnable function"
        );
      }
      await warchestRun(args);
    } catch (err) {
      logger.error(
        "[scoundrel] ❌ wallet command failed:",
        err?.message || err
      );
      process.exitCode = 1;
    } finally {
      try {
        await BootyBox.close();
      } catch (e) {
        if (process.env.NODE_ENV === "development") {
          logger.warn(
            "[scoundrel] warning: failed to close DB pool:",
            e?.message || e
          );
        }
      }
      // Ensure the CLI returns control to the shell after warchest completes
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
  });

program
  .command("warchestd")
  .description(
    "Run the warchest HUD follower or clean up legacy daemon artifacts"
  )
  .argument("<action>", "start|stop|restart|hud|status")
  .option(
    "--wallet <spec>",
    "Wallet spec alias:pubkey:color (repeatable, use multiple --wallet flags)",
    (value, previous) => {
      if (!previous) return [value];
      return previous.concat(value);
    }
  )
  .option("--no-follow-hub", "Disable following hub status/event files")
  .option(
    "--hub-events <path>",
    "Override hub event file path (default: data/warchest/tx-events.json)"
  )
  .option(
    "--hud-state <path>",
    "Override HUD state snapshot path (default: data/warchest/hud-state.json)"
  )
  .option(
    "--hub-status <path>",
    "Override health status file path (default: data/warchest/status.json)"
  )
  .addHelpText(
    "after",
    `
Examples:
  # Start warchest service (foreground)
  $ scoundrel warchestd start --wallet sampleWallet:DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR:orange

  # One-off HUD session (reads hub events + hud-state.json)
  $ scoundrel warchestd hud --wallet sampleWallet:DDkF...:orange

  # Clear legacy PID files
  $ scoundrel warchestd stop

  # Show hub/HUD health snapshot
  $ scoundrel warchestd status
`
  )
  .action(async (action, opts) => {
    // In Commander v9+, the second argument here is the options object, not the Command instance.
    // We defined --wallet as a repeatable option, so opts.wallet will be:
    //   - undefined (if not provided)
    //   - a string (if provided once)
    //   - an array of strings (if provided multiple times)
    const rawWallet =
      opts && Object.prototype.hasOwnProperty.call(opts, "wallet")
        ? opts.wallet
        : undefined;

    let walletSpecs = [];
    if (Array.isArray(rawWallet)) {
      walletSpecs = rawWallet;
    } else if (typeof rawWallet === "string") {
      walletSpecs = [rawWallet];
    }

    // walletSpecs may be empty here. The warchest service will attempt to resolve
    // wallets from configuration (autoAttachWarchest/default funding) when none
    // are provided explicitly.

    try {
      if (!warchestService) {
        throw new Error("warchest service module is not available");
      }

      const followHub = opts.followHub !== false;
      const hubEventsPath = opts.hubEvents;
      const hudStatePath = opts.hudState;
      const hubStatusPath = opts.hubStatus;

      if (action === "start") {
        await warchestService.start({
          walletSpecs,
          hudStatePath,
        });
        // Immediately after starting the daemon, kick a one-off targetlist run (best-effort).
        try {
          // Kick a one-off targetlist run on daemon start to ensure fresh targets for BuyOps
          const hub = getHubCoordinator();
          await hub.runTargetList({ runOnce: true }, { timeoutMs: 60000 });
          logger.info(
            "[scoundrel] targetlist bootstrap completed on warchestd start"
          );
        } catch (err) {
          logger.warn(
            "[scoundrel] targetlist bootstrap failed on warchestd start:",
            err?.message || err
          );
        } finally {
          closeHubCoordinator();
        }
      } else if (action === "stop") {
        await warchestService.stop();
      } else if (action === "restart") {
        await warchestService.restart({
          walletSpecs,
          hudStatePath,
        });
      } else if (action === "hud") {
        // Dedicated HUD action: run the HUD in the foreground as a TUI viewer.
        warchestService.hud({
          walletSpecs,
          followHub,
          hubEventsPath,
          hudStatePath,
        });
      } else if (action === "status") {
        // Report daemon + health snapshot status without modifying state.
        await warchestService.status({ statusPath: hubStatusPath });
      } else {
        logger.error(`[scoundrel] Unknown warchestd action: ${action}`);
        process.exitCode = 1;
      }
    } catch (err) {
      logger.error(
        "[scoundrel] ❌ warchestd command failed:",
        err?.message || err
      );
      process.exitCode = 1;
    }
  });

program
  .command("migrate")
  .description("Run BootyBox SQLite migrations")
  .option("--db <path>", "Override BOOTYBOX_SQLITE_PATH for this run")
  .addHelpText(
    "after",
    `\nExamples:\n  $ scoundrel migrate\n  $ BOOTYBOX_SQLITE_PATH=/tmp/bootybox.db scoundrel migrate\n  $ scoundrel migrate --db /tmp/bootybox.db\n`
  )
  .action(async (opts) => {
    const dbPath =
      opts.db ||
      process.env.BOOTYBOX_SQLITE_PATH ||
      join(__dirname, "db", "bootybox.db");
    logger.info(`[scoundrel] running migrations on ${dbPath}`);

    const Database = require("better-sqlite3");
    const { runMigrations } = require("./db/migrations");
    const sqlite = new Database(dbPath);

    try {
      await runMigrations({ sqlite, logger });
      logger.info("[scoundrel] ✅ migrations complete");
    } catch (err) {
      logger.error("[scoundrel] ❌ migrations failed:", err?.message || err);
      process.exitCode = 1;
    } finally {
      try {
        sqlite.close();
      } catch (closeErr) {
        logger.warn(
          "[scoundrel] failed to close sqlite handle:",
          closeErr?.message || closeErr
        );
      }
    }
  });

program
  .command("test")
  .description("Run a quick self-check (env + minimal OpenAI config presence)")
  .addHelpText(
    "after",
    `\nChecks:\n  • Ensures OPENAI_API_KEY is present.\n  • Verifies presence of core files in ./lib and ./ai.\n  • Attempts a BootyBox SQLite init/ping and prints DB path.\n\nExample:\n  $ scoundrel test\n`
  )
  .action(async () => {
    console.log("[test] starting test action");
    const hasKey = !!process.env.OPENAI_API_KEY;
    logger.info("[scoundrel] environment check:");
    logger.info(`  OPENAI_API_KEY: ${hasKey ? "present" : "MISSING"}`);
    logger.info(`  Working directory: ${process.cwd()}`);
    logger.info(`  Node version: ${process.version}`);

    // Check presence of core modules in the new pipeline
    const pathsToCheck = [
      join(__dirname, "lib", "cli", "dossier.js"),
      join(__dirname, "ai", "client.js"),
      join(__dirname, "ai", "jobs", "walletDossier.js"),
      join(__dirname, "lib", "cli", "ask.js"),
    ];
    logger.info("\n[scoundrel] core files:");
    pathsToCheck.forEach((p) => {
      const ok = existsSync(p);
      logger.info(
        `  ${relative(process.cwd(), p)}: ${ok ? "present" : "missing"}`
      );
    });

    // DB diagnostics
    const { BOOTYBOX_SQLITE_PATH = join(__dirname, "db", "bootybox.db") } =
      process.env;

    logger.info("\n[db] configuration:");
    logger.info(`  Engine   : sqlite`);
    logger.info(`  Path     : ${BOOTYBOX_SQLITE_PATH}`);

    try {
      if (typeof BootyBox.init === "function") {
        await BootyBox.init();
      }
      if (typeof BootyBox.ping === "function") {
        await BootyBox.ping();
      }
      logger.info("[db] ✅ sqlite reachable");
    } catch (e) {
      const msg = e && e.message ? e.message : e;
      logger.info(`[db] ❌ connection failed: ${msg}`);
      if (e && e.stack) {
        logger.debug && logger.debug(e.stack);
      }
    }

    if (!hasKey) {
      logger.info("\nTip: add OPENAI_API_KEY to your .env file.");
      process.exit(1);
    } else {
      logger.info("\n[scoundrel] ✅ basic checks passed.");
      process.exit(0);
    }
  });

// Default/help handling is provided by commander
program.parseAsync(process.argv);
