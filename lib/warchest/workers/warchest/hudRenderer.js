'use strict';

let inkModulePromise = null;

/**
 * Dynamically import Ink's ESM module so this CommonJS worker can render the HUD without
 * triggering ERR_REQUIRE_ASYNC_MODULE errors in Node >=18.
 *
 * @returns {Promise<object>} resolved Ink module (with render/exported helpers)
 */
async function loadInkModule() {
  if (!inkModulePromise) {
    inkModulePromise = import('ink').catch((err) => {
      inkModulePromise = null;
      throw err;
    });
  }

  return inkModulePromise;
}

/**
 * Ink renders to stdout. Any other writes to stdout (winston/console/BootyBox logs)
 * will visibly "stutter" the HUD and can interfere with keyboard input.
 *
 * In HUD mode, we try to keep stdout exclusively for Ink by routing likely log
 * lines to stderr.
 *
 * This is intentionally conservative: we only redirect chunks that look like
 * plaintext log lines (timestamps / bracketed logger prefixes).
 * @returns {Function} cleanup handler to restore stdout
 */
function installHudStdoutGuard() {
  const origWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);

  const looksLikeLogLine = (s) => {
    if (!s) return false;

    if (s.includes('\u001b[')) return false;

    const trimmed = s.trimStart();

    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+/.test(trimmed)) return true;

    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) return true;

    if (trimmed.startsWith('[HUD]') || trimmed.startsWith('[warchest]') || trimmed.startsWith('[KitRPC]')) return true;

    return false;
  };

  // eslint-disable-next-line no-param-reassign
  process.stdout.write = (chunk, encoding, cb) => {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk?.toString?.(encoding || 'utf8');
      if (typeof s === 'string' && looksLikeLogLine(s)) {
        errWrite(s, encoding);
        if (typeof cb === 'function') cb();
        return true;
      }
    } catch {
      // fall through to original
    }

    return origWrite(chunk, encoding, cb);
  };

  return () => {
    // eslint-disable-next-line no-param-reassign
    process.stdout.write = origWrite;
  };
}

module.exports = {
  installHudStdoutGuard,
  loadInkModule,
};
