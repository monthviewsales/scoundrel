require("dotenv").config({ quiet: true });
require("winston-daily-rotate-file");

const winston = require("winston");
const logLevel =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const TX_MONITOR_LOG_FILE_ENABLED =
  process.env.SAW_RAW === "1" || process.env.TX_MONITOR_DEBUG === "1";

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

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => {
    const scope = info.scope ? `[${info.scope}] ` : "";
    return `${info.timestamp} ${info.level}: ${scope}${info.message}`;
  })
);

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
      // Keep console output operator-friendly: drop noisy internal worker/metrics streams.
      format: winston.format.combine(dropScopes(["worker", "metrics"]), baseFormat),
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

module.exports = logger;
