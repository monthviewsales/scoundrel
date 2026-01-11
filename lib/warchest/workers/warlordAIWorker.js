'use strict';

const crypto = require('crypto');
const baseLogger = require('../../logger');
const { createWorkerHarness, safeSerializePayload } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');
const { createWarlordAI } = require('../../ai/warlordAI');
const defaultClient = require('../../ai/gptClient');
const grokClient = require('../../ai/grokClient');
const { requestId } = require('../../id/issuer');

const logger = createWorkerLogger({
  workerName: 'warlordAIWorker',
  scope: 'warlordAIWorker',
  baseLogger,
  includeCallsite: true,
});
const metricsLogger = typeof baseLogger.metrics === 'function'
  ? baseLogger.metrics()
  : baseLogger;

const SESSION_HISTORY_LIMIT = 10;
let BootyBox = null;
let bootyBoxReady = false;
let resolvedSessionId = null;
let ragWarned = false;

/**
 * @typedef {Object} WarlordAIWorkerPayload
 * @property {string} task
 * @property {Object} payload
 * @property {string} [model]
 * @property {number} [temperature]
 * @property {Object} [metadata]
 * @property {boolean} [rag]
 * @property {string} [sessionId]
 * @property {string} [serviceInstanceId]
 */

function buildWarlordAIMetricsPayload(event) {
  const details = event?.result || event?.payload || {};
  return {
    worker: event?.worker || 'warlordAIWorker',
    event: event?.event || null,
    requestId: event?.requestId || null,
    durationMs: event?.durationMs ?? null,
    ...(details.task ? { task: details.task } : {}),
    ...(details.sessionId ? { sessionId: details.sessionId } : {}),
  };
}

function createWarlordAIMetricsReporter() {
  if (!metricsLogger || typeof metricsLogger.debug !== 'function') return null;
  return (event) => {
    const payload = buildWarlordAIMetricsPayload(event);
    metricsLogger.debug(JSON.stringify(safeSerializePayload(payload)));
  };
}

async function ensureBootyBoxReady() {
  if (bootyBoxReady) return BootyBox;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    BootyBox = require('../../../db');
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[warlordAIWorker] BootyBox unavailable: ${msg}`);
    BootyBox = null;
    return null;
  }

  if (!BootyBox || typeof BootyBox.init !== 'function') {
    logger.warn('[warlordAIWorker] BootyBox client missing init; session memory disabled.');
    BootyBox = null;
    return null;
  }

  try {
    await BootyBox.init();
    bootyBoxReady = true;
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.warn(`[warlordAIWorker] BootyBox init failed; session memory disabled: ${msg}`);
    BootyBox = null;
  }

  return BootyBox;
}

function resolveSessionId(payload) {
  const explicit = payload?.sessionId || payload?.serviceInstanceId || null;
  if (explicit) {
    resolvedSessionId = String(explicit);
    return resolvedSessionId;
  }
  if (!resolvedSessionId) {
    resolvedSessionId = crypto.randomUUID();
    logger.info(`[warlordAIWorker] serviceInstanceId missing; generated sessionId ${resolvedSessionId}`);
  }
  return resolvedSessionId;
}

async function loadSessionHistory(sessionId) {
  const bootyBox = await ensureBootyBoxReady();
  if (!bootyBox || typeof bootyBox.listAsksByCorrelationId !== 'function') return [];
  try {
    const rows = bootyBox.listAsksByCorrelationId({
      correlationId: sessionId,
      limit: SESSION_HISTORY_LIMIT,
    });
    return Array.isArray(rows)
      ? rows.map((row) => ({
          question: row.question,
          answer: row.answer,
          bullets: row.bullets,
          actions: row.actions,
          createdAt: row.createdAt,
        }))
      : [];
  } catch (err) {
    logger.warn('[warlordAIWorker] Failed to load session history:', err?.message || err);
    return [];
  }
}

async function recordAskSession({ sessionId, question, response, model, temperature }) {
  const bootyBox = await ensureBootyBoxReady();
  if (!bootyBox || typeof bootyBox.recordAsk !== 'function') return null;

  try {
    const askIdRaw = await requestId({ prefix: 'ask' });
    const askId = String(askIdRaw).slice(-26);
    bootyBox.recordAsk({
      askId,
      correlationId: sessionId,
      question,
      profile: null,
      rows: null,
      model: model || null,
      temperature: typeof temperature === 'number' ? temperature : null,
      responseRaw: response,
      answer: response?.answer || '',
      bullets: response?.bullets || [],
      actions: response?.actions || [],
    });
    return askId;
  } catch (err) {
    logger.warn('[warlordAIWorker] Failed to persist ask:', err?.message || err);
    return null;
  }
}

/**
 * Validate and normalize WarlordAI worker payloads.
 *
 * @param {WarlordAIWorkerPayload} payload
 * @returns {WarlordAIWorkerPayload}
 */
function validateWarlordAIPayload(payload) {
  const out = {};
  if (payload?.task) out.task = String(payload.task).trim();
  if (payload?.payload && typeof payload.payload === 'object') out.payload = payload.payload;
  if (payload?.model) out.model = String(payload.model).trim();
  if (payload?.temperature != null) out.temperature = Number(payload.temperature);
  if (payload?.metadata && typeof payload.metadata === 'object') out.metadata = payload.metadata;
  if (payload?.rag != null) out.rag = Boolean(payload.rag);
  if (payload?.sessionId) out.sessionId = String(payload.sessionId).trim();
  if (payload?.serviceInstanceId) out.serviceInstanceId = String(payload.serviceInstanceId).trim();
  return out;
}

const { runTask } = createWarlordAI({
  clients: {
    openai: defaultClient,
    grok: grokClient,
  },
  defaultProvider: 'openai',
});

async function runWarlordAIWorker(payload) {
  const normalized = validateWarlordAIPayload(payload);
  if (!normalized.task) throw new Error('[warlordAIWorker] task is required');

  const sessionId = resolveSessionId(normalized);
  let userPayload = normalized.payload || {};
  let history = [];

  if (normalized.task === 'ask') {
    if (!ragWarned && normalized.rag !== false && !process.env.WARLORDAI_VECTOR_STORE) {
      ragWarned = true;
      logger.warn('[warlordAIWorker] WARLORDAI_VECTOR_STORE not set; file_search RAG disabled.');
    }
    history = await loadSessionHistory(sessionId);
    userPayload = {
      ...userPayload,
      history,
    };
  }

  const result = await runTask({
    task: normalized.task,
    payload: userPayload,
    model: normalized.model,
    temperature: normalized.temperature,
    metadata: normalized.metadata,
    rag: normalized.rag,
  });

  if (normalized.task === 'ask') {
    await recordAskSession({
      sessionId,
      question: userPayload.question,
      response: result,
      model: normalized.model,
      temperature: normalized.temperature,
    });
  }

  return {
    task: normalized.task,
    sessionId,
    historyCount: history.length,
    result,
  };
}

createWorkerHarness(runWarlordAIWorker, {
  workerName: 'warlordAIWorker',
  logger,
  metricsReporter: createWarlordAIMetricsReporter(),
  exitOnComplete: false,
  onClose: async () => {
    if (BootyBox && typeof BootyBox.close === 'function') {
      try {
        await BootyBox.close();
      } catch (err) {
        logger.warn('[warlordAIWorker] BootyBox close failed:', err?.message || err);
      }
    }
  },
});

module.exports = {
  validateWarlordAIPayload,
  runWarlordAIWorker,
};
