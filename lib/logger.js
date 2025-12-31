const { loadDotenv } = require('./env/safeDotenv');
loadDotenv();
require("winston-daily-rotate-file");

const winston = require("winston");
const util = require("util");
const fs = require("fs");
const path = require("path");
const logLevel =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const TX_MONITOR_LOG_FILE_ENABLED =
  process.env.SAW_RAW === "1" || process.env.TX_MONITOR_DEBUG === "1";

let stdioRedactionInstalled = false;

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

  const relPath = process.env.SC_HUD_CONSOLE_LOG || "./data/logs/HUD_console.log";
  const filePath = path.resolve(process.cwd(), relPath);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_) {
    // ignore
  }

  const appendLine = (level, args) => {
    try {
      const ts = new Date().toISOString();
      const parts = (args || []).map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || a.message || String(a);
        if (a && typeof a === "object") {
          return util.inspect(a, { depth: 6, breakLength: 120 });
        }
        return String(a);
      });
      fs.appendFileSync(filePath, `${ts} ${level}: ${parts.join(" ")}\n`);
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

function buildKnownSecrets() {
  const envKeys = [
    "SOLANATRACKER_API_KEY",
    "SWAP_API_KEY",
    "OPENAI_API_KEY",
    "HELIUS_API_KEY",
    "NEXTBLOCK_API_KEY",
  ];

  const values = [];
  for (const k of envKeys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim().length >= 8) {
      values.push(v.trim());
    }
  }
  return values;
}

function redactSecretsInText(text) {
  if (typeof text !== "string" || !text) return text;

  let out = text;

  // Redact common query-string credentials.
  out = out.replace(
    /([?&](?:api_key|apikey|apiKey|key|token)=)([^&\s]+)/gi,
    "$1[REDACTED]"
  );

  // Redact Bearer tokens.
  out = out.replace(/(\bBearer\s+)([A-Za-z0-9._\-~=+/]+)\b/g, "$1[REDACTED]");

  // Redact well-known env secrets when they appear verbatim.
  for (const secret of buildKnownSecrets()) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }

  return out;
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
            return redactSecretsInText(util.inspect(arg, { depth: 4, breakLength: 120 }));
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
        ? ` ${redactSecretsInText(util.inspect(meta, { depth: 6, breakLength: 120 }))}`
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
      filename: "./data/logs/Scoundrel_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m", // Max file size before rotation
      maxFiles: "14d", // Keep logs for 14 days
    }),
    // Dedicated worker lifecycle stream (forkWorkerWithPayload/createWorkerHarness).
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/Worker_%DATE%.log",
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
      filename: "./data/logs/Metrics_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: winston.format.combine(
        onlyScope("metrics"),
        baseFormat
      ),
    }),

    // Dedicated KitRPC stream (very noisy in debug; keep out of HUD console).
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/KitRPC_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: buildScopedMetaFormat("KitRPC"),
    }),

    // Dedicated SolanaTracker Data API stream.
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/SolanaTrackerData_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "5d",
      level: "debug",
      format: buildScopedMetaFormat("SolanaTrackerDataClient"),
    }),

    // Dedicated swap stream (swap CLI/worker/engine traces).
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/Swap_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "50m",
      maxFiles: "7d",
      level: "debug",
      format: buildScopedMetaFormat("swap"),
    }),

    // Dedicated sellOps stream (sellOps CLI/worker/engine traces).
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/SellOps_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "50m",
      maxFiles: "7d",
      level: "debug",
      format: buildScopedMetaFormat("sellOps"),
    }),

    ...(TX_MONITOR_LOG_FILE_ENABLED
      ? [
          new winston.transports.DailyRotateFile({
            filename: "./data/logs/TxMonitor_%DATE%.log",
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
