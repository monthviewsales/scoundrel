'use strict';

const { formatRunId, createArtifactWriter } = require('../persist/jsonArtifacts');

/**
 * Create a consistent run context for a CLI command.
 *
 * - runId is per-run
 * - artifacts uses the shared writer factory
 * - isDev used only for debug-level verbosity decisions
 *
 * @param {Object} params
 * @param {string} params.command
 * @param {string[]} [params.segments=[]]
 * @param {Object} [params.logger]
 * @param {string} [params.runId]
 * @returns {{ runId: string, isDev: boolean, artifacts: { baseDir: string, runId: string, write: Function, loadLatest: Function } }}
 */
function createCommandRun({ command, segments = [], logger, runId } = {}) {
  if (!command) throw new Error('[aiRun] `command` is required');

  const normalizedSegments = Array.isArray(segments)
    ? segments.filter(Boolean)
    : [segments].filter(Boolean);

  const resolvedRunId = runId || formatRunId();
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  const isDev = env === 'development';

  const artifacts = createArtifactWriter({
    command,
    segments: normalizedSegments,
    runId: resolvedRunId,
    logger,
  });

  return Object.freeze({ runId: resolvedRunId, isDev, artifacts });
}

module.exports = { createCommandRun };