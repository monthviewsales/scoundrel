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

  const resolvedRunId = runId || formatRunId();
  const env = process.env.NODE_ENV || 'development';
  const isDev = String(env).toLowerCase() === 'development';

  const artifacts = createArtifactWriter({
    command,
    segments,
    runId: resolvedRunId,
    logger,
  });

  return { runId: resolvedRunId, isDev, artifacts };
}

module.exports = { createCommandRun };