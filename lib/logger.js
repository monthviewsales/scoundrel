require("dotenv").config({ quiet: true });
require("winston-daily-rotate-file");

const winston = require("winston");
const logLevel = process.env.LOG_LEVEL || "debug";
/**
 * Application-wide Winston logger with console and daily rotating file transports.
 *
 * @type {import("winston").Logger}
 */
module.exports = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      (info) => `${info.timestamp} ${info.level}: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      filename: "./data/logs/Scoundrel_%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m", // Max file size before rotation
      maxFiles: "14d", // Keep logs for 14 days
    }),
  ],
});
