'use strict';

const { toolDefinitions } = require('./registry');

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Object} parameters
 * @property {Function} handler
 */

/** @type {Map<string, ToolDefinition>} */
const toolMap = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

/**
 * List tool schemas for agentic tool registration.
 * @returns {{ name: string, description: string, parameters: Object }[]}
 */
function listTools() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Invoke a tool by name with the provided arguments.
 * @param {string} name
 * @param {Object} args
 * @returns {Promise<any>}
 */
async function callTool(name, args) {
  if (!name) throw new Error('[ai/tools] tool name is required');
  const tool = toolMap.get(name);
  if (!tool) {
    throw new Error(`[ai/tools] unknown tool: ${name}`);
  }
  if (!args || typeof args !== 'object') {
    throw new Error(`[ai/tools] args must be an object for tool: ${name}`);
  }
  return await tool.handler(args);
}

module.exports = {
  listTools,
  callTool,
  toolSchemas: listTools(),
};
