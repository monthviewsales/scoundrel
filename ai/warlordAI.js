'use strict';

const defaultClient = require('./gptClient');
const grokClient = require('./grokClient');
const { getGlobalPersona } = require('./warlordAI/persona');
const { listTools, callTool } = require('./tools');
const devscanAnalysisTask = require('./warlordAI/tasks/devscanAnalysis');
const grokMintSearchReportTask = require('./warlordAI/tasks/grokMintSearchReport');
const grokProfileScoreTask = require('./warlordAI/tasks/grokProfileScore');
const tuneStrategyTask = require('./warlordAI/tasks/tuneStrategy');

const TASKS = {
  devscanAnalysis: devscanAnalysisTask,
  grokMintSearchReport: grokMintSearchReportTask,
  grokProfileScore: grokProfileScoreTask,
  tuneStrategy: tuneStrategyTask,
};

const MAX_TOOL_ROUNDS = 4;

function buildLocalToolSchemas() {
  return listTools().map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function buildInput(system, user) {
  const input = [];
  if (typeof system === 'string' && system.trim().length) {
    input.push({ role: 'system', content: system });
  }
  const userContent = (typeof user === 'string')
    ? user
    : JSON.stringify(user ?? {});
  input.push({ role: 'user', content: userContent });
  return input;
}

function extractFunctionCalls(output) {
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item && item.type === 'function_call' && item.name && item.call_id);
}

/**
 * Create a Warlord AI runner backed by one or more clients.
 * @param {{ callResponses: Function, parseResponsesJSON: Function, log?: { debug?: Function } }|{ clients: Object, defaultProvider?: string }} clientOrOptions
 * @returns {{ runTask: (params: { task: string, payload: Object, model?: string, temperature?: number, metadata?: Object }) => Promise<Object> }}
 */
function createWarlordAI(clientOrOptions) {
  const defaultProvider = (clientOrOptions && clientOrOptions.defaultProvider) || 'openai';
  const clients = (clientOrOptions && clientOrOptions.clients)
    ? clientOrOptions.clients
    : { [defaultProvider]: clientOrOptions || defaultClient };

  function resolveClient(provider) {
    const resolved = clients[provider || defaultProvider];
    if (!resolved) {
      throw new Error(`[warlordAI] unknown provider: ${provider || defaultProvider}`);
    }
    return resolved;
  }

  /**
   * Run a Warlord task using the shared Responses wrapper.
   * @param {Object} params
   * @param {string} params.task
   * @param {Object} params.payload
   * @param {string} [params.model]
   * @param {number} [params.temperature]
   * @param {Object} [params.metadata]
   * @returns {Promise<Object>}
   */
  async function runTask({ task, payload, model, temperature, metadata }) {
    const config = TASKS[task];
    if (!config) {
      throw new Error(`[warlordAI] unknown task: ${task}`);
    }

    const resolvedConfig = (typeof config.resolve === 'function')
      ? { ...config, ...config.resolve({ payload }) }
      : config;
    const userBuilder = resolvedConfig.buildUser || config.buildUser;
    const user = userBuilder ? userBuilder(payload) : payload;
    const resolvedTemperature = (typeof temperature === 'number')
      ? temperature
      : resolvedConfig.temperature;
    const provider = resolvedConfig.provider || config.provider || defaultProvider;
    const { callResponses, parseResponsesJSON, log } = resolveClient(provider);
    const enableLocalTools = provider === 'openai' && resolvedConfig.enableLocalTools !== false;
    const localTools = enableLocalTools ? buildLocalToolSchemas() : [];
    const combinedTools = [];
    const seen = new Set();
    const addTool = (tool) => {
      if (!tool || !tool.type) return;
      const key = tool.name ? `${tool.type}:${tool.name}` : tool.type;
      if (seen.has(key)) return;
      seen.add(key);
      combinedTools.push(tool);
    };
    (resolvedConfig.tools || []).forEach(addTool);
    localTools.forEach(addTool);
    const persona = getGlobalPersona();
    const system = resolvedConfig.system
      ? (persona ? `${persona}\n\n${resolvedConfig.system}` : resolvedConfig.system)
      : persona;
    const input = buildInput(system, user);
    const options = {
      schema: resolvedConfig.schema,
      name: resolvedConfig.name,
      system,
      input,
      user,
      model,
      metadata,
    };

    if (typeof resolvedTemperature === 'number') {
      options.temperature = resolvedTemperature;
    }

    if (combinedTools.length) {
      options.tools = combinedTools;
    }

    if (resolvedConfig.tool_choice) {
      options.tool_choice = resolvedConfig.tool_choice;
    }

    let res = await callResponses(options);
    let functionCalls = enableLocalTools ? extractFunctionCalls(res.output) : [];
    let rounds = 0;

    while (functionCalls.length && rounds < MAX_TOOL_ROUNDS) {
      input.push(...res.output);
      const toolOutputs = [];
      for (const call of functionCalls) {
        let args = {};
        if (call.arguments) {
          try {
            args = JSON.parse(call.arguments);
          } catch (_) {
            args = {};
          }
        }
        try {
          const result = await callTool(call.name, args);
          toolOutputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: (typeof result === 'string') ? result : JSON.stringify(result),
          });
        } catch (err) {
          toolOutputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({ error: err?.message || String(err) }),
          });
        }
      }
      input.push(...toolOutputs);
      res = await callResponses(options);
      functionCalls = extractFunctionCalls(res.output);
      rounds += 1;
    }

    const out = parseResponsesJSON(res);
    if (log && typeof log.debug === 'function') {
      log.debug(`[warlordAI:${task}] model output (truncated):`, JSON.stringify(out).slice(0, 256));
    }
    return out;
  }

  return { runTask };
}

const { runTask: runTaskInternal } = createWarlordAI({
  clients: {
    openai: defaultClient,
    grok: grokClient,
  },
  defaultProvider: 'openai',
});

/**
 * Run a Warlord task using the shared OpenAI client.
 * @param {Object} params
 * @param {string} params.task
 * @param {Object} params.payload
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>}
 */
function runTask(params) {
  return runTaskInternal(params);
}

module.exports = { createWarlordAI, runTask };
