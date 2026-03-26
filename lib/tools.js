'use strict';

/**
 * tools.js — Bridge tool parser, registry, and executor.
 *
 * Agent replies can contain `bridge-tool` fenced code blocks with JSON payloads.
 * The bridge parses these, validates params, executes the tool, and returns
 * structured results to the agent for multi-turn reasoning.
 *
 * Pattern: same as files.js (regex extraction from agent reply text).
 */

const TOOL_BLOCK_RE = /```bridge-tool\s*\n([\s\S]*?)```/g;

/** @type {Map<string, { schema: object, handler: function }>} */
const _registry = new Map();

/**
 * Register a bridge tool.
 *
 * @param {string} name — tool identifier (e.g. 'find_free_time')
 * @param {object} schema — param validation: { paramName: { type, required?, enum? } }
 * @param {(params: object) => Promise<any>} handler — async function that executes the tool
 */
function registerTool(name, schema, handler) {
  _registry.set(name, { schema, handler });
}

/**
 * Parse bridge-tool fenced blocks from agent reply text.
 * Returns cleaned text (blocks removed) and an array of tool calls.
 *
 * @param {string} text
 * @returns {{ text: string, toolCalls: Array<{ tool: string, params: object }> }}
 */
function parseToolBlocks(text) {
  const toolCalls = [];

  const cleaned = text.replace(TOOL_BLOCK_RE, (match, json) => {
    let parsed;
    try {
      parsed = JSON.parse(json.trim());
    } catch (_) {
      console.warn(`[${new Date().toISOString()}] [tools] Malformed bridge-tool block, leaving in text`);
      return match;
    }

    if (!parsed.tool) {
      console.warn(`[${new Date().toISOString()}] [tools] bridge-tool block missing "tool" field`);
      return match;
    }

    toolCalls.push({
      tool: parsed.tool,
      params: parsed.params || {},
    });
    return '';
  });

  return { text: cleaned.trim(), toolCalls };
}

/**
 * Validate tool params against the registered schema.
 *
 * @param {string} toolName
 * @param {object} params
 * @returns {{ valid: boolean, error?: string }}
 */
function validateParams(toolName, params) {
  const entry = _registry.get(toolName);
  if (!entry) return { valid: false, error: `Unknown tool: ${toolName}` };

  for (const [key, rule] of Object.entries(entry.schema)) {
    if (rule.required && (params[key] === undefined || params[key] === null)) {
      return { valid: false, error: `Missing required param: ${key}` };
    }
    if (params[key] !== undefined && rule.type) {
      const actual = Array.isArray(params[key]) ? 'array' : typeof params[key];
      if (actual !== rule.type) {
        return { valid: false, error: `Param "${key}" must be ${rule.type}, got ${actual}` };
      }
    }
    if (params[key] !== undefined && rule.enum && !rule.enum.includes(params[key])) {
      return { valid: false, error: `Param "${key}" must be one of: ${rule.enum.join(', ')}` };
    }
  }
  return { valid: true };
}

/**
 * Execute a single tool call. Validates params, runs the handler, returns
 * a structured result for sending back to the agent.
 *
 * @param {{ tool: string, params: object }} toolCall
 * @returns {Promise<{ tool: string, success: boolean, result?: any, error?: string }>}
 */
async function executeTool(toolCall) {
  const { tool, params } = toolCall;
  const ts = new Date().toISOString();

  if (!_registry.has(tool)) {
    console.warn(`[${ts}] [tools] Unknown tool: ${tool}`);
    return { tool, success: false, error: `Unknown tool: ${tool}. Available tools: ${[..._registry.keys()].join(', ')}` };
  }

  const validation = validateParams(tool, params);
  if (!validation.valid) {
    console.warn(`[${ts}] [tools] Validation failed for ${tool}: ${validation.error}`);
    return { tool, success: false, error: validation.error };
  }

  try {
    console.log(`[${ts}] [tools] Executing: ${tool}(${JSON.stringify(params)})`);
    const result = await _registry.get(tool).handler(params);
    console.log(`[${ts}] [tools] ${tool} completed successfully`);
    return { tool, success: true, result };
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error(`[${ts}] [tools] ${tool} failed: ${detail}`);
    return { tool, success: false, error: detail };
  }
}

/**
 * Format tool results for sending back to the OpenClaw session.
 *
 * @param {Array<{ tool: string, success: boolean, result?: any, error?: string }>} results
 * @returns {string}
 */
function formatToolResults(results) {
  return results.map(r => {
    const payload = r.success
      ? { success: true, result: r.result }
      : { success: false, error: r.error };
    return `[Bridge Tool Result: ${r.tool}]\n${JSON.stringify(payload, null, 2)}`;
  }).join('\n\n');
}

/**
 * Check if the tool registry has any tools registered.
 * @returns {boolean}
 */
function hasTools() {
  return _registry.size > 0;
}

/**
 * Get list of registered tool names.
 * @returns {string[]}
 */
function getToolNames() {
  return [..._registry.keys()];
}

module.exports = {
  registerTool,
  parseToolBlocks,
  executeTool,
  formatToolResults,
  hasTools,
  getToolNames,
};
