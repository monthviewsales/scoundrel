// lib/solanaTrackerRPCClient.js
// Pure Anza Kit RPC client (HTTP + WS) with minimal logging (level from NODE_ENV)

require('./env/safeDotenv').loadDotenv();
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const WebSocket = require('ws');
const logger = require('./logger').child({ scope: 'KitRPC' });

const KIT_LOG_SLOW_MS = Number(process.env.KIT_LOG_SLOW_MS || 500);

let kitModule;

function loadKit() {
  if (!kitModule) {
    kitModule = require('@solana/kit');
  }
  return kitModule;
}

function redactUrl(url) {
  try {
    const u = new URL(url);

    // Strip credentials (userinfo)
    u.username = '';
    u.password = '';

    // Strip everything except protocol + host:port
    u.pathname = '';
    u.search = '';
    u.hash = '';

    // Prefer origin to avoid trailing slash quirks
    return u.origin;
  } catch (_) {
    // Best-effort fallback: remove userinfo and query string
    return String(url)
      .replace(/\/\/[^/@]*@/g, '//')
      .replace(/\?.*$/, '')
      .replace(/#.*$/, '');
  }
}

const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

function parseNoProxyList() {
  const raw = NO_PROXY_ENV_KEYS.map((k) => process.env[k]).find(Boolean);
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function hostMatchesNoProxy(hostname, noProxyList) {
  if (!hostname) return false;
  return noProxyList.some((entry) => {
    if (entry === '*') return true;
    if (entry.startsWith('.')) return hostname === entry.slice(1) || hostname.endsWith(entry);
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

function getProxyForUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }

  const noProxyList = parseNoProxyList();
  if (hostMatchesNoProxy(parsed.hostname, noProxyList)) return null;

  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  if (secure) {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      null
    );
  }
  return process.env.HTTP_PROXY || process.env.http_proxy || null;
}

function ensureProxyAwareFetch(url) {
  if (globalThis.__scoundrelProxyDispatcher) return;

  const proxyUrl = getProxyForUrl(url);
  if (!proxyUrl) return;

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  globalThis.__scoundrelProxyDispatcher = true;
  logger.info('http using proxy', { proxy: redactUrl(proxyUrl) });
}

function ensureProxyAwareWebSocket(url, socketRegistry) {
  if (globalThis.__scoundrelProxyWebSocket) {
    if (socketRegistry) globalThis.__scoundrelSocketRegistry = socketRegistry;
    return globalThis.WebSocket || WebSocket;
  }

  // Track sockets so callers can force-close them during reconnects.
  globalThis.__scoundrelSocketRegistry = socketRegistry || new Set();

  const BaseWebSocket = globalThis.WebSocket || WebSocket;

  class ProxyAwareWebSocket extends BaseWebSocket {
    constructor(address, protocols, options) {
      let socketProtocols = protocols;
      let socketOptions = options;

      if (socketOptions === undefined && socketProtocols && typeof socketProtocols === 'object' && !Array.isArray(socketProtocols)) {
        socketOptions = socketProtocols;
        socketProtocols = undefined;
      }

      const baseOptions = socketOptions || {};
      const headers = { ...(baseOptions.headers || {}) };
      const apiKey = process.env.SOLANATRACKER_API_KEY;
      if (apiKey && !headers['x-api-key']) headers['x-api-key'] = apiKey;

      const origin = process.env.SOLANATRACKER_RPC_WS_ORIGIN || process.env.SOLANATRACKER_URL;
      const withHeaders = { ...baseOptions };
      if (Object.keys(headers).length) withHeaders.headers = headers;
      if (origin && !withHeaders.origin) withHeaders.origin = origin;

      const proxyUrl = getProxyForUrl(address);
      const mergedOptions =
        proxyUrl && !withHeaders.agent && !withHeaders.createConnection
          ? { ...withHeaders, agent: new HttpsProxyAgent(proxyUrl) }
          : withHeaders;

      if (proxyUrl && mergedOptions !== baseOptions) {
        logger.info('ws using proxy', { proxy: redactUrl(proxyUrl) });
      }

      super(address, socketProtocols, Object.keys(mergedOptions).length ? mergedOptions : undefined);

      const registry = globalThis.__scoundrelSocketRegistry;
      if (registry && typeof registry.add === 'function') {
        registry.add(this);
        const remove = () => {
          try {
            registry.delete(this);
          } catch (_) {
            /* ignore registry cleanup errors */
          }
        };

        if (typeof this.on === 'function') {
          this.on('close', remove);
          this.on('error', remove);
        } else if (typeof this.addEventListener === 'function') {
          this.addEventListener('close', remove, { once: true });
          this.addEventListener('error', remove, { once: true });
        }
      }

      // `unexpected-response` is specific to the `ws` client in Node. In some
      // environments `BaseWebSocket` may be a WHATWG-style WebSocket that does
      // not implement `.on`, which would cause `this.on is not a function`.
      // Guard the handler so we only attach it when supported.
      if (typeof this.on === 'function') {
        this.on('unexpected-response', (request, response) => {
          logger.error('ws unexpected response', {
            statusCode: response?.statusCode,
          });
        });
      }
    }
  }

  globalThis.WebSocket = ProxyAwareWebSocket;
  globalThis.__scoundrelProxyWebSocket = true;
  return globalThis.WebSocket;
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
              logger.debug('rpc.send start', { method });
              const res = await origSend(...sendArgs);
              const ms = Date.now() - started;
              if (ms > KIT_LOG_SLOW_MS) logger.warn('rpc.send slow', { method, ms });
              else logger.debug('rpc.send done', { method, ms });
              return res;
            } catch (error) {
              const ms = Date.now() - started;
              logger.error('rpc.send error', { method, ms, message: error?.message });
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
              logger.debug('subscribe', { type: subType, subId });
              const iter = await origSubscribe(opts);
              if (controller) registry.add(controller);
              let count = 0;

              const wrapped = {
                async *[Symbol.asyncIterator]() {
                  for await (const ev of iter) {
                    count += 1;
                    if (count === 1) logger.debug('event first', { subId });
                    yield ev;
                  }
                },
                async return(value) {
                  try {
                    if (typeof iter.return === 'function') await iter.return(value);
                  } finally {
                    if (controller) registry.delete(controller);
                    logger.debug('subscription closed', { subId, count });
                  }
                  return { value, done: true };
                },
                async throw(err) {
                  try {
                    if (typeof iter.throw === 'function') return await iter.throw(err);
                  } finally {
                    if (controller) registry.delete(controller);
                    logger.error('subscription error', { subId, message: err?.message });
                  }
                  throw err;
                },
              };
              return wrapped;
            } catch (e) {
              logger.error('subscribe failed', { type: subType, message: e?.message });
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
  if (!wsUrl) logger.warn('no WS url provided; subscriptions disabled');

  const redactedHttp = redactUrl(httpUrl);
  const redactedWs = wsUrl ? redactUrl(wsUrl) : null;
  logger.info('init', { httpUrl: redactedHttp, wsUrl: redactedWs });

  ensureProxyAwareFetch(httpUrl);
  const socketRegistry = new Set();
  if (wsUrl) ensureProxyAwareWebSocket(wsUrl, socketRegistry);

  const { createSolanaRpc, createSolanaRpcSubscriptions } = loadKit();
  const rawRpc = createSolanaRpc(httpUrl);
  const rpc = wrapRpcSendLogging(rawRpc);

  const controllers = new Set();
  const rawSubs = wsUrl ? createSolanaRpcSubscriptions(wsUrl) : null;
  const rpcSubs = rawSubs ? wrapSubsLogging(rawSubs, controllers) : null;

  async function close() {
    logger.info('close.begin', { activeSubs: controllers.size });
    for (const c of controllers) {
      try { c.abort(); } catch (_) {}
    }
    controllers.clear();
    try {
      for (const ws of Array.from(socketRegistry)) {
        try {
          if (typeof ws.terminate === 'function') ws.terminate();
          else if (typeof ws.close === 'function') ws.close();
        } finally {
          socketRegistry.delete(ws);
        }
      }
    } catch (_) {
      /* ignore socket close errors */
    }
    logger.info('close.end');
  }

  return { rpc, rpcSubs, close, socketRegistry };
}

module.exports = { createSolanaTrackerRPCClient };
