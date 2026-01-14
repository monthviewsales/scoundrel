'use strict';

/**
 * @typedef {Object} SellOpsOrchestrator
 * @property {Function} start
 * @property {Function} stopAll
 * @property {Function} restartWallet
 * @property {Function} getState
 */

/**
 * Create a SellOps worker orchestrator for the HUD service.
 * @param {Object} options
 * @param {Array} options.wallets
 * @param {Object} options.state
 * @param {Array} options.serviceAlerts
 * @param {Object} options.hudStore
 * @param {Function} options.forkWorkerWithPayload
 * @param {Function} options.pushServiceAlert
 * @param {Function} options.pushRecentEvent
 * @param {Function} options.emitHudChange
 * @param {Object} options.logger
 * @param {Function} [options.registerWorker]
 * @param {number} options.hudMaxLogs
 * @param {string|null} options.dataEndpoint
 * @param {number} options.pollIntervalMs
 * @param {string} options.workerPath
 * @returns {SellOpsOrchestrator}
 */
function createSellOpsOrchestrator({
  wallets,
  state,
  serviceAlerts,
  hudStore,
  forkWorkerWithPayload,
  pushServiceAlert,
  pushRecentEvent,
  emitHudChange,
  logger,
  registerWorker,
  hudMaxLogs,
  dataEndpoint,
  pollIntervalMs,
  workerPath,
}) {
  const sellOpsState = {
    byWallet: {},
  };

  const walletByAlias = new Map();
  for (const w of wallets || []) {
    if (w && w.alias) walletByAlias.set(w.alias, w);
  }

  const sellOpsLastDisplayed = new Map();
  const sellOpsLastHeartbeatAlert = new Map();
  const sellOpsWorkers = {};

  function upsertSellOpsHeartbeat(alias, hb) {
    if (!alias) return;
    if (!sellOpsState.byWallet[alias]) {
      sellOpsState.byWallet[alias] = { heartbeat: null, evalByMint: {}, autopsies: [] };
    }
    sellOpsState.byWallet[alias].heartbeat = hb || null;
  }

  function upsertSellOpsEvaluation(alias, mint, payload) {
    if (!alias || !mint) return;
    if (!sellOpsState.byWallet[alias]) {
      sellOpsState.byWallet[alias] = { heartbeat: null, evalByMint: {}, autopsies: [] };
    }
    sellOpsState.byWallet[alias].evalByMint[mint] = payload;
  }

  function pushSellOpsAutopsy(alias, payload) {
    if (!alias || !payload) return;
    if (!sellOpsState.byWallet[alias]) {
      sellOpsState.byWallet[alias] = { heartbeat: null, evalByMint: {}, autopsies: [] };
    }
    const list = sellOpsState.byWallet[alias].autopsies || [];
    list.unshift(payload);
    const maxEntries = Math.max(1, hudMaxLogs || 25);
    if (list.length > maxEntries) list.length = maxEntries;
    sellOpsState.byWallet[alias].autopsies = list;
  }

  function shouldDisplaySellOpsEvent(alias, mint, intel) {
    const key = `${alias}:${mint}`;
    const now = Date.now();

    const recommendation = intel?.recommendation || 'hold';
    const worstSeverity = intel?.worstSeverity || 'none';
    const failedCount = Number.isFinite(Number(intel?.failedCount)) ? Number(intel.failedCount) : 0;

    const prev = sellOpsLastDisplayed.get(key) || null;

    if (!prev) {
      sellOpsLastDisplayed.set(key, { recommendation, worstSeverity, failedCount, ts: now });
      return true;
    }

    if (
      prev.recommendation !== recommendation ||
      prev.worstSeverity !== worstSeverity ||
      prev.failedCount !== failedCount
    ) {
      sellOpsLastDisplayed.set(key, { recommendation, worstSeverity, failedCount, ts: now });
      return true;
    }

    return false;
  }

  function startWorkerForWallet(w, options = {}) {
    if (!w || !w.alias) return false;
    const alias = w.alias;
    if (sellOpsWorkers[alias] && !options.force) return false;

    upsertSellOpsHeartbeat(alias, {
      ts: Date.now(),
      walletAlias: alias,
      status: options.isRestart ? 'restarting' : 'starting',
      openPositions: null,
      nextTickMs: pollIntervalMs,
    });

    try {
      const handle = forkWorkerWithPayload(workerPath, {
        timeoutMs: 0,
        payload: {
          walletAlias: alias,
          wallet: { alias, pubkey: w.pubkey || null, color: w.color || null },
          walletPubkey: w.pubkey || null,
          dataEndpoint,
          pollIntervalMs,
          ohlcvType: '1m',
          ohlcvLookbackMs: 60 * 60 * 1000,
          vwapPeriods: 60,
          includeCandles: false,
          eventIntervals: ['5m', '15m', '1h'],
        },
        onProgress: (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'sellOps:heartbeat') {
            const hb = msg.payload || null;
            const hbAlias = hb?.walletAlias || alias;
            upsertSellOpsHeartbeat(hbAlias, hb);

            const now = Date.now();
            const last = sellOpsLastHeartbeatAlert.get(hbAlias) || 0;
            if (now - last > pollIntervalMs) {
              sellOpsLastHeartbeatAlert.set(hbAlias, now);
              const status = hb?.status || 'ok';
              const open = hb?.openPositions ?? 'n/a';
              const strategyLabel = hb?.strategyLabel || hb?.strategyName || hb?.strategy || 'none';
              pushServiceAlert(
                serviceAlerts,
                'info',
                `SellOps heartbeat (${hbAlias} ${strategyLabel}) status=${status} open=${open}`
              );
            }

            emitHudChange();
            return;
          }

          if (msg.type === 'sellOps:evaluation') {
            const p = msg.payload || null;
            const evalAlias = p?.walletAlias || alias;
            const mint = p?.mint || null;
            if (mint) {
              upsertSellOpsEvaluation(evalAlias, mint, p);
            }

            if (mint && state?.[evalAlias] && Array.isArray(state[evalAlias].tokens)) {
              const tokenRow = state[evalAlias].tokens.find((t) => t && t.mint === mint) || null;
              if (tokenRow) {
                const prevSellOps = tokenRow.sellOps && typeof tokenRow.sellOps === 'object'
                  ? tokenRow.sellOps
                  : null;
                const ts = Number.isFinite(Number(p?.ts))
                  ? Number(p.ts)
                  : (prevSellOps && Number.isFinite(Number(prevSellOps.ts)) ? Number(prevSellOps.ts) : Date.now());
                const recommendation = p?.recommendation || 'hold';
                const strategyName = p?.strategy?.name || null;
                const qualifyWorst = p?.qualify?.worstSeverity || 'none';
                const qualifyFailed = Number.isFinite(Number(p?.qualify?.failedCount)) ? Number(p.qualify.failedCount) : 0;
                const regime = p?.regime?.status || null;

                const gateFail =
                  p?.gateFail ||
                  p?.qualify?.gateFail ||
                  (Array.isArray(p?.qualify?.failed) && p.qualify.failed[0] && (p.qualify.failed[0].gate || p.qualify.failed[0].gateId)) ||
                  null;

                const baseSellOps = {
                  ts,
                  recommendation,
                  strategyName,
                  qualifyWorst,
                  qualifyFailed,
                  regime,
                  gateFail,
                };

                const payload =
                  p && typeof p === 'object'
                    ? { ...p }
                    : null;

                tokenRow.sellOps = {
                  ...(prevSellOps || {}),
                  ...baseSellOps,
                  ...(payload || {}),
                };

                const stratPart = strategyName ? ` ${strategyName}` : '';
                const qPart = qualifyFailed > 0
                  ? ` gates=${qualifyFailed} sev=${qualifyWorst}${gateFail ? ` gate=${gateFail}` : ''}`
                  : ' qualify=pass';
                tokenRow.sellOpsLine = `SellOps ${recommendation}${stratPart}${qPart}`;
              }
            }

            const gateFail =
              p?.gateFail ||
              p?.qualify?.gateFail ||
              (Array.isArray(p?.qualify?.failed) && p.qualify.failed[0] && (p.qualify.failed[0].gate || p.qualify.failed[0].gateId)) ||
              null;

            const decision = p?.decision || 'n/a';
            const recommendation = p?.recommendation || 'hold';
            const strategyName = p?.strategy?.name || null;
            const qualifyWorst = p?.qualify?.worstSeverity || 'none';
            const qualifyFailed = Number.isFinite(Number(p?.qualify?.failedCount)) ? Number(p.qualify.failedCount) : 0;

            const regime = p?.regime?.status || 'n/a';
            const symbol =
              p?.symbol ||
              state?.[evalAlias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
              (mint ? mint.slice(0, 4) : 'mint');

            const intel = { recommendation, worstSeverity: qualifyWorst, failedCount: qualifyFailed };

            if (mint && shouldDisplaySellOpsEvent(evalAlias, mint, intel)) {
              const stratPart = strategyName ? ` ${strategyName}` : '';
              const qPart = qualifyFailed > 0
                ? ` gates=${qualifyFailed} sev=${qualifyWorst}${gateFail ? ` gate=${gateFail}` : ''}`
                : ' qualify=pass';
              const line = `SellOps ${symbol} ${recommendation}${stratPart} (${regime})${qPart}`;

              pushRecentEvent(state[evalAlias], line, hudStore);

              pushServiceAlert(
                serviceAlerts,
                'info',
                `SellOps eval (${evalAlias}) ${symbol} recommend=${recommendation}${stratPart} (${regime})${qPart} decision=${decision}`
              );
            }

            emitHudChange();
          }

          if (msg.type === 'sellOps:alert') {
            const p = msg.payload || null;
            const alertAlias = p?.walletAlias || alias;
            const mint = p?.mint || null;
            const symbol =
              state?.[alertAlias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
              (mint ? mint.slice(0, 4) : 'mint');
            const message = p?.message || `SellOps alert for ${symbol}`;
            if (state?.[alertAlias]) {
              pushRecentEvent(state[alertAlias], message, hudStore);
            }
            pushServiceAlert(serviceAlerts, 'warn', `SellOps alert (${alertAlias}) ${message}`);
            emitHudChange();
            return;
          }

          if (msg.type === 'sellOps:autopsy') {
            const p = msg.payload || null;
            const autopsyAlias = p?.walletAlias || alias;
            const mint = p?.mint || null;
            const grade = p?.grade || 'n/a';
            const summaryRaw = p?.summary || '';
            const summary = summaryRaw && summaryRaw.length > 140
              ? `${summaryRaw.slice(0, 137)}...`
              : summaryRaw;
            const symbol =
              state?.[autopsyAlias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
              (mint ? mint.slice(0, 4) : 'mint');

            if (state?.[autopsyAlias]) {
              const text = summary
                ? `SellOps Autopsy ${symbol} ${grade}: ${summary}`
                : `SellOps Autopsy ${symbol} ${grade}`;
              pushRecentEvent(state[autopsyAlias], text, hudStore);
            }

            pushSellOpsAutopsy(autopsyAlias, {
              ts: p?.ts || Date.now(),
              walletAlias: autopsyAlias,
              tradeUuid: p?.tradeUuid || null,
              mint,
              grade: p?.grade || null,
              summary: p?.summary || null,
              tags: Array.isArray(p?.tags) ? p.tags : [],
              ai: p?.ai || null,
              artifactPath: p?.artifactPath || null,
            });

            const alertSummary = summary
              ? ` summary="${summary}"`
              : '';
            pushServiceAlert(serviceAlerts, 'info', `SellOps autopsy (${autopsyAlias}) ${symbol} grade=${grade}${alertSummary}`);
            emitHudChange();
          }
        },
      });

      sellOpsWorkers[alias] = {
        wallet: w,
        startedAt: Date.now(),
        handle,
        stop: () => {
          try { handle?.stop?.(); } catch {}
        },
      };

      if (typeof registerWorker === 'function') {
        try {
          registerWorker(`sellOps:${alias}`, handle);
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          logger.warn(`[HUD] Failed to register SellOps worker (${alias}): ${msg}`);
        }
      }

      const reason = options.reason ? ` (${options.reason})` : '';
      const verb = options.isRestart ? 'restarted' : 'started';
      pushServiceAlert(serviceAlerts, 'info', `SellOps worker ${verb} (${alias})${reason}`);
      return true;
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      pushServiceAlert(serviceAlerts, 'error', `SellOps worker failed (${alias}): ${msg}`);
      logger.warn(`[HUD] Failed to start SellOps worker for ${alias}: ${msg}`);
      upsertSellOpsHeartbeat(alias, {
        ts: Date.now(),
        walletAlias: alias,
        status: 'error',
        openPositions: null,
        nextTickMs: pollIntervalMs,
        err: msg,
      });
      return false;
    }
  }

  async function start() {
    for (const w of wallets) {
      if (!w || !w.alias) continue;
      startWorkerForWallet(w);
    }

    if (hudStore) hudStore.emitChange();
  }

  function restartWallet(alias, reason) {
    const wallet = walletByAlias.get(alias);
    if (!wallet) return false;
    const existing = sellOpsWorkers[alias];
    if (existing && typeof existing.stop === 'function') {
      try { existing.stop(); } catch {}
    }
    sellOpsWorkers[alias] = null;
    sellOpsLastHeartbeatAlert.delete(alias);
    return startWorkerForWallet(wallet, { isRestart: true, reason, force: true });
  }

  function stopAll() {
    for (const h of Object.values(sellOpsWorkers)) {
      if (!h || typeof h.stop !== 'function') continue;
      try { h.stop(); } catch {}
    }
  }

  function getState() {
    return sellOpsState;
  }

  return {
    start,
    stopAll,
    restartWallet,
    getState,
  };
}

module.exports = {
  createSellOpsOrchestrator,
};
