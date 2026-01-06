'use strict';

const { createCommandRun } = require('./aiRun');

/**
 * @typedef {Object} AnalysisBuildResult
 * @property {any} payload
 * @property {string[]} [segments]
 * @property {string} [runId]
 * @property {string|null} [promptPath]
 * @property {string|null} [responsePath]
 * @property {Object} [context]
 */

/**
 * @typedef {Object} AnalysisFlowConfig
 * @property {string} command
 * @property {Object} [logger]
 * @property {(args: { options: Object, createArtifacts: Function }) => Promise<AnalysisBuildResult>} build
 * @property {(args: { payload: any, options: Object, buildResult: AnalysisBuildResult, runId: string }) => Promise<any>} analyze
 * @property {(args: { payload: any, analysis: any, options: Object, buildResult: AnalysisBuildResult, runId: string }) => Promise<void>} [persist]
 * @property {(options: Object, buildResult?: AnalysisBuildResult) => string[]} [buildSegments]
 */

/**
 * Factory for CLI analysis flows that share the same run lifecycle:
 * 1) build payload + raw artifacts
 * 2) write prompt artifact
 * 3) run AI analysis (optional)
 * 4) write response artifact
 * 5) persist via flow-specific hooks
 *
 * @param {AnalysisFlowConfig} config
 * @returns {Function}
 */
function createAnalysisFlow(config) {
  if (!config || !config.command) {
    throw new Error('[analysisFlow] command is required');
  }
  if (typeof config.build !== 'function') {
    throw new Error('[analysisFlow] build must be a function');
  }
  if (typeof config.analyze !== 'function') {
    throw new Error('[analysisFlow] analyze must be a function');
  }

  return async function runAnalysisFlow(options = {}) {
    let runContext = null;

    function createArtifacts(segments, runIdOverride) {
      if (runContext) return runContext;
      const resolvedSegments = Array.isArray(segments) ? segments : [segments].filter(Boolean);
      runContext = createCommandRun({
        command: config.command,
        segments: resolvedSegments,
        logger: config.logger,
        runId: runIdOverride,
      });
      return runContext;
    }

    const buildResult = await config.build({ options, createArtifacts });
    if (!buildResult || typeof buildResult !== 'object' || !('payload' in buildResult)) {
      throw new Error('[analysisFlow] build must return an object with payload');
    }

    if (!runContext) {
      const segments = buildResult.segments || (config.buildSegments ? config.buildSegments(options, buildResult) : []);
      runContext = createArtifacts(segments, buildResult.runId);
    }

    const payload = buildResult.payload;
    const promptPath = buildResult.promptPath !== undefined
      ? buildResult.promptPath
      : runContext.artifacts.write('prompt', 'prompt', payload);

    const shouldAnalyze = !(
      (options && options.runAnalysis === false)
      || buildResult.runAnalysis === false
      || buildResult.skipAnalysis === true
    );
    if (!shouldAnalyze) {
      return {
        payload,
        analysis: null,
        promptPath,
        responsePath: null,
        runId: runContext.runId,
        artifacts: runContext.artifacts,
        buildResult,
      };
    }

    const analysis = await config.analyze({
      payload,
      options,
      buildResult,
      runId: runContext.runId,
    });

    const responsePath = buildResult.responsePath !== undefined
      ? buildResult.responsePath
      : runContext.artifacts.write('response', 'response', analysis);

    if (typeof config.persist === 'function') {
      await config.persist({
        payload,
        analysis,
        options,
        buildResult,
        runId: runContext.runId,
      });
    }

    return {
      payload,
      analysis,
      promptPath,
      responsePath,
      runId: runContext.runId,
      artifacts: runContext.artifacts,
      buildResult,
    };
  };
}

module.exports = { createAnalysisFlow };
