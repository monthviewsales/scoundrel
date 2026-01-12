'use strict';

/**
 * @typedef {Object} SellOpsOrchestrator
 * @property {Function} start
 * @property {Function} stopAll
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
  hudMaxLogs,
  dataEndpoint,
  pollIntervalMs,
  workerPath,
}) {
  const sellOpsState = {
    byWallet: {},
  };

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

  async function start() {
    for (const w of wallets) {
      if (!w || !w.alias) continue;
      if (sellOpsWorkers[w.alias]) continue;

      upsertSellOpsHeartbeat(w.alias, {
        ts: Date.now(),
        walletAlias: w.alias,
        status: 'starting',
        openPositions: null,
        nextTickMs: pollIntervalMs,
      });

      try {
        const handle = forkWorkerWithPayload(workerPath, {
          timeoutMs: 0,
          payload: {
            walletAlias: w.alias,
            wallet: { alias: w.alias, pubkey: w.pubkey || null, color: w.color || null },
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
              const alias = hb?.walletAlias || w.alias;
              upsertSellOpsHeartbeat(alias, hb);

              const now = Date.now();
              const last = sellOpsLastHeartbeatAlert.get(alias) || 0;
              if (now - last > pollIntervalMs) {
                sellOpsLastHeartbeatAlert.set(alias, now);
                const status = hb?.status || 'ok';
                const open = hb?.openPositions ?? 'n/a';
                const strategyLabel = hb?.strategyLabel || hb?.strategyName || hb?.strategy || 'none';
                pushServiceAlert(
                  serviceAlerts,
                  'info',
                  `SellOps heartbeat (${alias} ${strategyLabel}) status=${status} open=${open}`
                );
              }

              emitHudChange();
              return;
            }

            if (msg.type === 'sellOps:evaluation') {
              const p = msg.payload || null;
              const alias = p?.walletAlias || w.alias;
              const mint = p?.mint || null;
              if (mint) {
                upsertSellOpsEvaluation(alias, mint, p);
              }

              if (mint && state?.[alias] && Array.isArray(state[alias].tokens)) {
                const tokenRow = state[alias].tokens.find((t) => t && t.mint === mint) || null;
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
                state?.[alias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
                (mint ? mint.slice(0, 4) : 'mint');

              const intel = { recommendation, worstSeverity: qualifyWorst, failedCount: qualifyFailed };

              if (mint && shouldDisplaySellOpsEvent(alias, mint, intel)) {
                const stratPart = strategyName ? ` ${strategyName}` : '';
                const qPart = qualifyFailed > 0
                  ? ` gates=${qualifyFailed} sev=${qualifyWorst}${gateFail ? ` gate=${gateFail}` : ''}`
                  : ' qualify=pass';
                const line = `SellOps ${symbol} ${recommendation}${stratPart} (${regime})${qPart}`;

                pushRecentEvent(state[alias], line, hudStore);

                pushServiceAlert(
                  serviceAlerts,
                  'info',
                  `SellOps eval (${alias}) ${symbol} recommend=${recommendation}${stratPart} (${regime})${qPart} decision=${decision}`
                );
              }

              emitHudChange();
            }

            if (msg.type === 'sellOps:alert') {
              const p = msg.payload || null;
              const alias = p?.walletAlias || w.alias;
              const mint = p?.mint || null;
              const symbol =
                state?.[alias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
                (mint ? mint.slice(0, 4) : 'mint');
              const message = p?.message || `SellOps alert for ${symbol}`;
              if (state?.[alias]) {
                pushRecentEvent(state[alias], message, hudStore);
              }
              pushServiceAlert(serviceAlerts, 'warn', `SellOps alert (${alias}) ${message}`);
              emitHudChange();
              return;
            }

            if (msg.type === 'sellOps:autopsy') {
              const p = msg.payload || null;
              const alias = p?.walletAlias || w.alias;
              const mint = p?.mint || null;
              const grade = p?.grade || 'n/a';
              const summaryRaw = p?.summary || '';
              const summary = summaryRaw && summaryRaw.length > 140
                ? `${summaryRaw.slice(0, 137)}...`
                : summaryRaw;
              const symbol =
                state?.[alias]?.tokens?.find((t) => t?.mint === mint)?.symbol ||
                (mint ? mint.slice(0, 4) : 'mint');

              if (state?.[alias]) {
                const text = summary
                  ? `SellOps Autopsy ${symbol} ${grade}: ${summary}`
                  : `SellOps Autopsy ${symbol} ${grade}`;
                pushRecentEvent(state[alias], text, hudStore);
              }

              pushSellOpsAutopsy(alias, {
                ts: p?.ts || Date.now(),
                walletAlias: alias,
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
              pushServiceAlert(serviceAlerts, 'info', `SellOps autopsy (${alias}) ${symbol} grade=${grade}${alertSummary}`);
              emitHudChange();
            }
          },
        });

        sellOpsWorkers[w.alias] = {
          stop: () => {
            try { handle?.stop?.(); } catch {}
          },
        };

        pushServiceAlert(serviceAlerts, 'info', `SellOps worker started (${w.alias})`);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        pushServiceAlert(serviceAlerts, 'error', `SellOps worker failed (${w.alias}): ${msg}`);
        logger.warn(`[HUD] Failed to start SellOps worker for ${w.alias}: ${msg}`);
        upsertSellOpsHeartbeat(w.alias, {
          ts: Date.now(),
          walletAlias: w.alias,
          status: 'error',
          openPositions: null,
          nextTickMs: pollIntervalMs,
          err: msg,
        });
      }
    }

    if (hudStore) hudStore.emitChange();
  }

  function stopAll() {
    for (const h of Object.values(sellOpsWorkers)) {
      try { h.stop(); } catch {}
    }
  }

  function getState() {
    return sellOpsState;
  }

  return {
    start,
    stopAll,
    getState,
  };
}

module.exports = {
  createSellOpsOrchestrator,
};
