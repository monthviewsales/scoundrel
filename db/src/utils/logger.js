'use strict';

const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: process.env.BOOTYBOX_LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${timestamp}] [BootyBox] ${level}: ${message}${metaStr}`;
    })
  ),
  transports: [
    new transports.Console(),
  ],
});

module.exports = logger;
