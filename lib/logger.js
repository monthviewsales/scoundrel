require("dotenv").config({ quiet: true });
require("winston-daily-rotate-file");

const winston = require("winston");
const logLevel = process.env.LOG_LEVEL || "debug";

const TX_MONITOR_LOG_FILE_ENABLED =
  process.env.SAW_RAW === "1" || process.env.TX_MONITOR_DEBUG === "1";

function onlyScope(scope) {
  return winston.format((info) => {
    if (!info || info.scope !== scope) return false;
    return info;
  })();
}

/**
 * Application-wide Winston logger with console and daily rotating file transports.
 *
 * @type {import("winston").Logger}
 */
const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf((info) => {
      const scope = info.scope ? `[${info.scope}] ` : "";
      return `${info.timestamp} ${info.level}: ${scope}${info.message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/Scoundrel_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m", // Max file size before rotation
      maxFiles: "14d", // Keep logs for 14 days
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
              winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
              winston.format.printf((info) => {
                // Always include scope prefix to make the file readable.
                const scope = info.scope ? `[${info.scope}] ` : "";
                return `${info.timestamp} ${info.level}: ${scope}${info.message}`;
              })
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

module.exports = logger;
