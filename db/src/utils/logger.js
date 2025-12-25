'use strict';

const { createLogger, format, transports } = require('winston');

function isHudMode() {
  // Keep this intentionally simple and environment-driven. Different entrypoints set different flags.
  return (
    process.env.HUD_MODE === 'true' ||
    process.env.WARCHEST_MODE === 'hud' ||
    process.env.WARCHEST_HUD === 'true' ||
    process.env.SCOUNDREL_HUD === 'true'
  );
}

const defaultScope = 'BootyBox';

const logger = createLogger({
  level: process.env.BOOTYBOX_LOG_LEVEL || 'info',
  defaultMeta: { scope: defaultScope },
  format: format.combine(
    format.timestamp(),
    // Ensure meta is always an object so we can safely inspect it.
    format.metadata({ fillExcept: ['level', 'message', 'timestamp'] }),
    format.printf((info) => {
      const scope = info.scope || info?.metadata?.scope || defaultScope;
      const meta = info.metadata && typeof info.metadata === 'object' ? info.metadata : {};
      // Avoid repeating scope in meta output.
      if (meta.scope) delete meta.scope;

      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${info.timestamp}] [${scope}] ${info.level}: ${info.message}${metaStr}`;
    })
  ),
  transports: [
    // Console is fine for normal CLI/daemon runs.
    // In HUD mode, avoid noisy debug/info that can stutter Ink UIs.
    new transports.Console({
      level: isHudMode() ? 'warn' : undefined,
      stderrLevels: ['error', 'warn'],
    }),
  ],
});

// Convenience helper mirroring the main app logger style.
logger.bootybox = function bootybox() {
  return logger.child({ scope: defaultScope });
};

module.exports = logger;
