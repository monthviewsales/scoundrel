// lib/solanaTrackerRPCClient.js
// Pure Anza Kit RPC client (HTTP + WS) with minimal logging (level from NODE_ENV)

require('dotenv').config();

const { createSolanaRpc, createSolanaRpcSubscriptions } = require('@solana/kit');

// ---------- logging config ----------
function kitLogLevelFromNodeEnv() {
  const env = (process.env.NODE_ENV || '').toLowerCase();
  if (env === 'production') return 'info';
  if (env === 'test') return 'error';
  return 'debug'; // dev/undefined -> verbose
}
const KIT_LOG_LEVEL = kitLogLevelFromNodeEnv();
const KIT_LOG_SLOW_MS = Number(process.env.KIT_LOG_SLOW_MS || 500);

function kitLog(level, msg, meta) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const current = levels[KIT_LOG_LEVEL] ?? 2; // default info
  const want = levels[level] ?? 2;
  if (want > current) return;
  const ts = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : '';
  // eslint-disable-next-line no-console
  console[level](
    `[scoundrel][KitRPC][${level.toUpperCase()}] ${ts} ${msg}${payload}`
  );
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    return u.toString();
  } catch (_) {
    return url;
  }
}

// ---------- small wrappers that only add logs ----------
function wrapRpcSendLogging(rpc) {
  return new Proxy(rpc, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      return (...args) => {
        const req = orig.apply(target, args);
        if (req && typeof req.send === 'function') {
          const origSend = req.send.bind(req);
          req.send = async (...sendArgs) => {
            const method = String(prop);
            const started = Date.now();
            try {
              kitLog('info', 'rpc.send start', { method });
              const res = await origSend(...sendArgs);
              const ms = Date.now() - started;
              if (ms > KIT_LOG_SLOW_MS) kitLog('warn', 'rpc.send slow', { method, ms });
              else kitLog('info', 'rpc.send done', { method, ms });
              return res;
            } catch (error) {
              const ms = Date.now() - started;
              kitLog('error', 'rpc.send error', { method, ms, message: error?.message });
              throw error;
            }
          };
        }
        return req;
      };
    },
  });
}

function wrapSubsLogging(rpcSubs, registry) {
  return new Proxy(rpcSubs, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      return (...args) => {
        const result = orig.apply(target, args);
        if (result && typeof result.subscribe === 'function') {
          const origSubscribe = result.subscribe.bind(result);
          result.subscribe = async (opts = {}) => {
            let controller;
            if (!opts.abortSignal) {
              controller = new AbortController();
              // eslint-disable-next-line no-param-reassign
              opts.abortSignal = controller.signal;
            }
            const subType = String(prop);
            const subId = `${subType}#${Math.random().toString(36).slice(2, 8)}`;
            try {
              kitLog('info', 'subscribe', { type: subType, subId });
              const iter = await origSubscribe(opts);
              if (controller) registry.add(controller);
              let count = 0;

              const wrapped = {
                async *[Symbol.asyncIterator]() {
                  for await (const ev of iter) {
                    count += 1;
                    if (count === 1) kitLog('debug', 'event first', { subId });
                    yield ev;
                  }
                },
                async return(value) {
                  try {
                    if (typeof iter.return === 'function') await iter.return(value);
                  } finally {
                    if (controller) registry.delete(controller);
                    kitLog('info', 'subscription closed', { subId, count });
                  }
                  return { value, done: true };
                },
                async throw(err) {
                  try {
                    if (typeof iter.throw === 'function') return await iter.throw(err);
                  } finally {
                    if (controller) registry.delete(controller);
                    kitLog('error', 'subscription error', { subId, message: err?.message });
                  }
                  throw err;
                },
              };
              return wrapped;
            } catch (e) {
              kitLog('error', 'subscribe failed', { type: subType, message: e?.message });
              throw e;
            }
          };
        }
        return result;
      };
    },
  });
}

// ---------- factory ----------
const KIT_HTTP_URL = process.env.SOLANATRACKER_RPC_HTTP_URL;
const KIT_WS_URL = process.env.SOLANATRACKER_RPC_WS_URL;

/**
 * Factory: create a pure Kit client with logging.
 * Returns { rpc, rpcSubs, close }
 */
function createSolanaTrackerRPCClient({ httpUrl = KIT_HTTP_URL, wsUrl = KIT_WS_URL } = {}) {
  if (!httpUrl) throw new Error('[KitRpcClient] Missing SOLANATRACKER_RPC_HTTP_URL');
  if (!wsUrl) kitLog('warn', 'no WS url provided; subscriptions disabled', {});

  const redactedHttp = redactUrl(httpUrl);
  const redactedWs = wsUrl ? redactUrl(wsUrl) : null;
  kitLog('info', 'init', { httpUrl: redactedHttp, wsUrl: redactedWs });

  const rawRpc = createSolanaRpc(httpUrl);
  const rpc = wrapRpcSendLogging(rawRpc);

  const controllers = new Set();
  const rawSubs = wsUrl ? createSolanaRpcSubscriptions(wsUrl) : null;
  const rpcSubs = rawSubs ? wrapSubsLogging(rawSubs, controllers) : null;

  async function close() {
    kitLog('info', 'close.begin', { activeSubs: controllers.size });
    for (const c of controllers) {
      try { c.abort(); } catch (_) {}
    }
    controllers.clear();
    kitLog('info', 'close.end', {});
  }

  return { rpc, rpcSubs, close };
}

module.exports = { createSolanaTrackerRPCClient };
