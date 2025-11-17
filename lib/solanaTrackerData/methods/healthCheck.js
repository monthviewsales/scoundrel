'use strict';

const PROBE_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Bind helper performing a lightweight health check against the API.
 *
 * @param {{ client: any, call: Function, log?: { info?: Function, error?: Function } }} deps
 * @returns {() => Promise<{ ok: boolean, error?: string }>}
 */
function createHealthCheck({ client, call, log }) {
  if (!client || !call) throw new Error('createHealthCheck: missing dependencies');

  return async function healthCheck() {
    try {
      const exec = typeof client?.health?.ping === 'function'
        ? () => client.health.ping()
        : () => client.getTokenInfo(PROBE_MINT);
      const res = await call('healthCheck', exec, { attempts: 2 });
      log?.info?.('solanaTrackerData health ok');
      return { ok: true, res };
    } catch (error) {
      const message = error?.message || String(error);
      log?.error?.('solanaTrackerData health failed', { message });
      return { ok: false, error: message };
    }
  };
}

module.exports = { createHealthCheck };
