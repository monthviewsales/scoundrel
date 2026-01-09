const { loadDotenv } = require('./env/safeDotenv');
loadDotenv();
require("winston-daily-rotate-file");

const winston = require("winston");
const util = require("util");
const fs = require("fs");
const path = require("path");
const { redactSecretsInText, redactSensitiveData } = require("./logging/redaction");
const logLevel =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const TX_MONITOR_LOG_FILE_ENABLED =
  process.env.SAW_RAW === "1" || process.env.TX_MONITOR_DEBUG === "1";

function resolveLogRootDir() {
  if (process.env.LOG_ROOT_DIR) {
    return path.resolve(process.cwd(), process.env.LOG_ROOT_DIR);
  }
  return path.join(process.cwd(), "data", "logs");
}

const LOG_ROOT_DIR = resolveLogRootDir();
try {
  fs.mkdirSync(LOG_ROOT_DIR, { recursive: true });
} catch (_) {
  // Ignore log dir creation failures; transports may still handle it.
}

let stdioRedactionInstalled = false;
let hudConsoleCaptureInstalled = false;
let hudConsoleStream = null;
let hudConsoleBackpressure = false;
let hudConsoleQueue = [];
let hudConsoleDropped = 0;
let hudConsoleCloseHookInstalled = false;
let hudConsoleMetricsReporter = null;
const HUD_CONSOLE_QUEUE_LIMIT = 1000;

function isHudMode() {
  // Enable via env for explicit control, but also auto-detect common HUD flags.
  if (process.env.SC_HUD_MODE === "1") return true;
  if (process.env.WARCHEST_HUD === "1") return true;
  return Array.isArray(process.argv) && process.argv.includes("--hud");
}

function isInkMode() {
  // Ink mode is used by interactive TUIs (e.g. swap progress). In this mode,
  // stdout/stderr must stay quiet to avoid corrupting Ink rendering.
  if (process.env.SC_INK_MODE === "1") return true;
  return Array.isArray(process.argv) && process.argv.includes("--ink");
}

function installHudConsoleCapture() {
  if (!isHudMode()) return;
  if (process.env.SC_HUD_CAPTURE_CONSOLE === "0") return;
  if (hudConsoleCaptureInstalled) return;
  hudConsoleCaptureInstalled = true;

  const relPath = process.env.SC_HUD_CONSOLE_LOG;
  const filePath = relPath
    ? (path.isAbsolute(relPath) ? relPath : path.resolve(LOG_ROOT_DIR, relPath))
    : path.join(LOG_ROOT_DIR, "HUD_console.log");

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_) {
    // ignore
  }

  function flushHudConsoleQueue() {
    if (!hudConsoleStream) return;
    while (hudConsoleQueue.length > 0 && !hudConsoleBackpressure) {
      const next = hudConsoleQueue.shift();
      try {
        hudConsoleBackpressure = hudConsoleStream.write(next) === false;
      } catch (_) {
        // ignore
      }
    }
    if (hudConsoleDropped > 0 && !hudConsoleBackpressure && hudConsoleStream) {
      const droppedLine = `${new Date().toISOString()} warn: dropped ${hudConsoleDropped} HUD console lines due to backpressure\n`;
      if (typeof hudConsoleMetricsReporter === "function") {
        hudConsoleMetricsReporter({
          event: "hud.console.drop",
          dropped: hudConsoleDropped,
        });
      }
      hudConsoleDropped = 0;
      try {
        hudConsoleBackpressure = hudConsoleStream.write(droppedLine) === false;
      } catch (_) {
        // ignore
      }
    }
  }

  function closeHudConsoleStream() {
    if (!hudConsoleStream) return;
    try {
      hudConsoleStream.end();
    } catch (_) {
      // ignore
    }
    hudConsoleStream = null;
    hudConsoleQueue = [];
    hudConsoleDropped = 0;
  }

  hudConsoleStream = fs.createWriteStream(filePath, { flags: "a" });
  hudConsoleStream.on("error", (err) => {
    if (typeof hudConsoleMetricsReporter === "function") {
      hudConsoleMetricsReporter({
        event: "hud.console.error",
        message: err && err.message ? err.message : String(err),
      });
    }
    closeHudConsoleStream();
    hudConsoleBackpressure = false;
  });
  hudConsoleStream.on("drain", () => {
    hudConsoleBackpressure = false;
    flushHudConsoleQueue();
  });

  if (!hudConsoleCloseHookInstalled) {
    hudConsoleCloseHookInstalled = true;
    process.once("beforeExit", closeHudConsoleStream);
    process.once("exit", closeHudConsoleStream);
    process.once("SIGINT", closeHudConsoleStream);
    process.once("SIGTERM", closeHudConsoleStream);
  }

  const scrubConsoleArg = (arg) => {
    if (typeof arg === "string") return redactSecretsInText(arg);
    if (arg instanceof Error) {
      const msg = redactSecretsInText(arg.message || "");
      const stack = redactSecretsInText(arg.stack || "");
      const err = new Error(msg);
      err.stack = stack || err.stack;
      return err;
    }
    if (arg && typeof arg === "object") {
      const scrubbed = redactSensitiveData(arg);
      return redactSecretsInText(util.inspect(scrubbed, { depth: 6, breakLength: 120 }));
    }
    return arg;
  };

  const appendLine = (level, args) => {
    try {
      const ts = new Date().toISOString();
      const parts = (args || []).map((a) => {
        const scrubbed = scrubConsoleArg(a);
        if (typeof scrubbed === "string") return scrubbed;
        if (scrubbed instanceof Error) return scrubbed.stack || scrubbed.message || String(scrubbed);
        if (scrubbed && typeof scrubbed === "object") return String(scrubbed);
        return String(scrubbed);
      });
      const line = `${ts} ${level}: ${parts.join(" ")}\n`;
      if (!hudConsoleStream) return;
      if (hudConsoleBackpressure) {
        if (hudConsoleQueue.length < HUD_CONSOLE_QUEUE_LIMIT) {
          hudConsoleQueue.push(line);
        } else {
          hudConsoleDropped += 1;
        }
        return;
      }
      hudConsoleBackpressure = hudConsoleStream.write(line) === false;
      if (hudConsoleBackpressure) {
        flushHudConsoleQueue();
      }
    } catch (_) {
      // ignore
    }
  };

  const wrap = (name, level) => {
    const original = console[name];
    if (typeof original !== "function") return;
    if (original.__scoundrel_hud_captured__) return;

    const wrapped = (...args) => {
      appendLine(level, args);
      // Intentionally do not write to stdout/stderr for these levels in HUD mode.
    };
    wrapped.__scoundrel_hud_captured__ = true;
    wrapped.__scoundrel_original__ = original;
    console[name] = wrapped;
  };

  // Keep console.error visible on screen.
  wrap("log", "log");
  wrap("info", "info");
  wrap("debug", "debug");
  wrap("warn", "warn");
}

function stripScopePrefix(message, scope) {
  if (!scope || typeof message !== "string") return message;
  const prefix = `[${scope}]`;
  if (!message.startsWith(prefix)) return message;
  let next = message.slice(prefix.length);
  if (next.startsWith(" ")) next = next.slice(1);
  return next;
}

function shouldDropThirdPartyNoise(text) {
  if (process.env.SC_SHOW_SOLANATRACKER_STDOUT === "1") return false;
  const lvl = String(process.env.LOG_LEVEL || "").toLowerCase();
  const allowVerbose = lvl === "debug" || lvl === "silly";
  if (allowVerbose) return false;
  return typeof text === "string" && text.includes("[SolanaTracker]");
}

function installStdIoRedactor() {
  if (stdioRedactionInstalled) return;
  stdioRedactionInstalled = true;

  const wrapWrite = (stream) => {
    if (!stream || typeof stream.write !== "function") return;
    if (stream.__scoundrel_redacted_write__) return;

    const original = stream.write.bind(stream);
    // eslint-disable-next-line no-underscore-dangle
    stream.__scoundrel_redacted_write__ = original;

    // eslint-disable-next-line no-param-reassign
    stream.write = function redactedWrite(chunk, encoding, cb) {
      try {
        if (typeof chunk === "string") {
          if (shouldDropThirdPartyNoise(chunk)) return true;
          return original(redactSecretsInText(chunk), encoding, cb);
        }
        if (Buffer.isBuffer(chunk)) {
          const asText = chunk.toString(typeof encoding === "string" ? encoding : "utf8");
          if (shouldDropThirdPartyNoise(asText)) return true;
          return original(redactSecretsInText(asText), encoding, cb);
        }
      } catch (_) {
        // Fall through to original write on any scrub failure.
      }
      return original(chunk, encoding, cb);
    };
  };

  wrapWrite(process.stdout);
  wrapWrite(process.stderr);

  // Also wrap console.* so util-inspected objects passed as args are scrubbed.
  const wrapConsole = (name) => {
    const original = console[name];
    if (typeof original !== "function") return;
    if (original.__scoundrel_redacted__) return;

    const wrapped = (...args) => {
      const safe = args.map((arg) => {
        try {
          if (typeof arg === "string") return redactSecretsInText(arg);
          if (arg instanceof Error) {
            const msg = redactSecretsInText(arg.message || "");
            const stack = redactSecretsInText(arg.stack || "");
            const err = new Error(msg);
            err.stack = stack || err.stack;
            return err;
          }
          // Scrub stringified representation for objects (best-effort).
          if (arg && typeof arg === "object") {
            const scrubbed = redactSensitiveData(arg);
            return redactSecretsInText(util.inspect(scrubbed, { depth: 4, breakLength: 120 }));
          }
          return arg;
        } catch (_) {
          return arg;
        }
      });
      original(...safe);
    };

    wrapped.__scoundrel_redacted__ = true;
    console[name] = wrapped;
  };

  ["log", "info", "warn", "error", "debug"].forEach(wrapConsole);
}

function onlyScope(scope) {
  return winston.format((info) => {
    if (!info || info.scope !== scope) return false;
    return info;
  })();
}

function dropScopes(scopes) {
  const blocked = new Set(Array.isArray(scopes) ? scopes : []);
  return winston.format((info) => {
    if (!info) return false;
    if (info.scope && blocked.has(info.scope)) return false;
    return info;
  })();
}

const redactFormat = winston.format((info) => {
  if (!info) return false;
  if (typeof info.message === "string") {
    info.message = redactSecretsInText(info.message);
  }
  return info;
})();

const stripScopeFormat = winston.format((info) => {
  if (!info || typeof info.message !== "string") return info;
  if (!info.scope) return info;
  info.message = stripScopePrefix(info.message, info.scope);
  return info;
})();

const baseFormat = winston.format.combine(
  redactFormat,
  stripScopeFormat,
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => {
    const scope = info.scope ? `[${info.scope}] ` : "";
    return `${info.timestamp} ${info.level}: ${scope}${info.message}`;
  })
);

function buildScopedMetaFormat(scopeName) {
  return winston.format.combine(
    onlyScope(scopeName),
    redactFormat,
    stripScopeFormat,
    // Move non-standard fields into info.metadata and avoid dumping Winston Symbol() internals.
    winston.format.metadata({ fillExcept: ["level", "message", "timestamp", "scope"] }),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf((info) => {
      const scope = info.scope ? `[${info.scope}] ` : "";
      const meta = info.metadata && typeof info.metadata === "object" ? info.metadata : {};
      const metaKeys = Object.keys(meta);
      const metaSuffix = metaKeys.length
        ? ` ${redactSecretsInText(util.inspect(redactSensitiveData(meta), { depth: 6, breakLength: 120 }))}`
        : "";
      return `${info.timestamp} ${info.level}: ${scope}${info.message}${metaSuffix}`;
    })
  );
}

/**
 * Application-wide Winston logger with console and daily rotating file transports.
 *
 * @type {import("winston").Logger}
 */
const logger = winston.createLogger({
  level: logLevel,
  format: baseFormat,
  transports: [
    new winston.transports.Console({
      // Keep console output operator-friendly.
      // In HUD/Ink mode we must keep stdout quiet to avoid corrupting Ink rendering.
      silent:
        (isInkMode() && process.env.SC_INK_ALLOW_CONSOLE !== "1") ||
        (isHudMode() && process.env.SC_HUD_ALLOW_CONSOLE !== "1"),
      format: winston.format.combine(
        dropScopes(
          isHudMode() || isInkMode()
            ? [
                "worker",
                "metrics",
                "KitRPC",
                "SolanaTrackerDataClient",
                "swap",
                "swapWorker",
                "swapEngine",
                "sellOps",
              ]
            : ["worker", "metrics"]
        ),
        baseFormat
      ),
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "Scoundrel_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "20m", // Max file size before rotation
      maxFiles: "14d", // Keep logs for 14 days
    }),
    // Dedicated worker lifecycle stream (forkWorkerWithPayload/createWorkerHarness).
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "Worker_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: winston.format.combine(
        onlyScope("worker"),
        baseFormat
      ),
    }),
    // Dedicated metrics stream (tx monitor / worker metrics hooks).
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "Metrics_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: winston.format.combine(
        onlyScope("metrics"),
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.json()
      ),
    }),

    // Dedicated KitRPC stream (very noisy in debug; keep out of HUD console).
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "KitRPC_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: buildScopedMetaFormat("KitRPC"),
    }),

    // Dedicated SolanaTracker Data API stream.
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "SolanaTrackerData_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: buildScopedMetaFormat("SolanaTrackerDataClient"),
    }),

    // Dedicated swap stream (swap CLI/worker/engine traces).
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "Swap_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "50m",
      maxFiles: "7d",
      level: "debug",
      format: buildScopedMetaFormat("swap"),
    }),

    // Dedicated sellOps stream (sellOps CLI/worker/engine traces).
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_ROOT_DIR, "SellOps_%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "50m",
      maxFiles: "7d",
      level: "debug",
      format: buildScopedMetaFormat("sellOps"),
    }),

    ...(TX_MONITOR_LOG_FILE_ENABLED
      ? [
          new winston.transports.DailyRotateFile({
            filename: path.join(LOG_ROOT_DIR, "TxMonitor_%DATE%.log"),
            datePattern: "YYYY-MM-DD",
            maxSize: "20m",
            maxFiles: "14d",
            level: "debug",
            format: winston.format.combine(
              onlyScope("txMonitor"),
              baseFormat
            ),
          }),
        ]
      : []),
  ],
});

// Redact secrets from any third-party stdout/stderr logs (e.g. SolanaTracker SDK).
// Disable with SC_REDACT_STDIO=0 for debugging if needed.
if (process.env.SC_REDACT_STDIO !== "0") {
  installStdIoRedactor();
}

// When running the Ink HUD, redirect console.log/info/debug/warn to a file to avoid corrupting the screen.
// Leave console.error on-screen for operational visibility.
installHudConsoleCapture();

// Convenience child logger for txMonitor so we can route noisy traces to a dedicated file.
logger.txMonitor = function txMonitor() {
  return logger.child({ scope: "txMonitor" });
};

// Internal worker lifecycle (harness) logs.
logger.worker = function worker() {
  return logger.child({ scope: "worker" });
};

// Structured metrics/events (kept out of console by default).
logger.metrics = function metrics() {
  return logger.child({ scope: "metrics" });
};

hudConsoleMetricsReporter = (event) => {
  const metricsLogger = logger.metrics();
  if (metricsLogger && typeof metricsLogger.debug === "function") {
    metricsLogger.debug(JSON.stringify(event));
  }
};

// SolanaKit RPC transport (very chatty at debug).
logger.kitrpc = function kitrpc() {
  return logger.child({ scope: "KitRPC" });
};

// SolanaTracker Data API client traces.
logger.solanaTrackerData = function solanaTrackerData() {
  return logger.child({ scope: "SolanaTrackerDataClient" });
};

// Swap workflow traces (kept out of console in Ink/HUD mode; routed to Swap_%DATE%.log).
logger.swap = function swap() {
  return logger.child({ scope: "swap" });
};

// SellOps workflow traces (kept out of console in Ink/HUD mode; routed to SellOps_%DATE%.log).
logger.sellOps = function sellOps() {
  return logger.child({ scope: "sellOps" });
};

module.exports = logger;
