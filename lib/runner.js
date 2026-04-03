'use strict';

/**
 * runner.js — Shared bridge turn runner.
 *
 * Extracts the common tool loop from dispatchMessage, dispatchEmail, and
 * dispatchChannelMessage into a single reusable function. The runner handles:
 *   - sending a message to OpenClaw and waiting for the reply
 *   - parsing file blocks and tool blocks from the reply
 *   - executing bridge tools in parallel
 *   - looping until no tool calls remain or max iterations hit
 *
 * The runner does NOT handle:
 *   - delivering files (caller decides DM upload vs channel upload vs skip)
 *   - delivering messages to Teams/email/channel (caller decides)
 *   - managing presence (caller wraps with acquirePresence/releasePresence)
 *   - creating or editing ack messages (caller manages edit-in-place)
 *   - logging chat-specific information (caller logs with chat context)
 */

const { sendToOpenclaw, onReply } = require('./openclaw');
const { parseFileBlocks }         = require('./files');
const { parseToolBlocks, executeTool, formatToolResults } = require('./tools');

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Send a message to OpenClaw and wait for the reply.
 * Wraps the callback-based onReply/sendToOpenclaw into a promise.
 *
 * @param {string} message — text to send
 * @param {string} sessionKey — OpenClaw session key
 * @returns {Promise<string>} — agent reply text
 */
function sendAndWaitForReply(message, sessionKey) {
  return new Promise((resolve, reject) => {
    onReply(sessionKey, (reply, err) => {
      if (err) reject(err);
      else resolve(reply);
    });
    sendToOpenclaw(message, sessionKey);
  });
}

/**
 * Run a complete bridge turn: send a message, process tool calls in a loop,
 * and return the final result to the caller.
 *
 * @param {string} sessionKey — OpenClaw session key
 * @param {string} message — initial message to send
 * @param {object} [options]
 * @param {number} [options.maxIterations] — max tool loop iterations (default 10)
 * @param {(turn: { text: string, files: Array, toolCalls: Array, iteration: number }) => Promise<void>} [options.onIntermediateTurn]
 *   — called after each iteration that has tool calls, before executing them.
 *     Receives the parsed text, files, and tool calls for that turn. The caller
 *     can use this to post intermediate text or deliver files mid-loop.
 * @returns {Promise<{ text: string, files: Array, toolCalls: Array, iterations: number }>}
 * @throws {Error} if OpenClaw returns an error (caller handles user notification)
 */
async function runBridgeTurn(sessionKey, message, options = {}) {
  const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
  const onIntermediateTurn = options.onIntermediateTurn || null;

  let currentMessage = message;
  let iteration = 0;
  let lastText = '';
  let lastFiles = [];
  let lastToolCalls = [];

  while (iteration < maxIterations) {
    iteration++;

    // Send to OpenClaw and wait for reply — throws on error
    const rawResponse = await sendAndWaitForReply(currentMessage, sessionKey);

    // Parse file blocks and tool blocks from the reply
    const { text: afterFiles, files } = parseFileBlocks(rawResponse);
    const { text: cleanText, toolCalls } = parseToolBlocks(afterFiles);

    lastText = cleanText;
    lastFiles = files;
    lastToolCalls = toolCalls;

    // No tool calls → final reply, return to caller
    if (toolCalls.length === 0) {
      return { text: cleanText, files, toolCalls: [], iterations: iteration };
    }

    // Notify caller of intermediate turn (for ack editing, file delivery, etc.)
    if (onIntermediateTurn) {
      await onIntermediateTurn({ text: cleanText, files, toolCalls, iteration });
    }

    // Execute tool calls in parallel
    const results = await Promise.all(toolCalls.map(tc => executeTool(tc)));

    // Format results as next message in the same session
    currentMessage = formatToolResults(results);
  }

  // Hit max iterations — return what we have
  return {
    text: lastText,
    files: lastFiles,
    toolCalls: lastToolCalls,
    iterations: iteration,
    maxIterationsHit: true,
  };
}

/**
 * Continue a bridge turn from already-received assistant text. Used for orphan
 * turn adoption — the bridge observed a completed turn it didn't initiate,
 * found bridge-tool blocks, and needs to execute them and loop.
 *
 * Enters the same tool loop as runBridgeTurn but skips the initial send,
 * starting from pre-received text instead.
 *
 * @param {string} sessionKey — OpenClaw session key (from the observed turn)
 * @param {string} initialText — completed assistant text containing bridge-tool blocks
 * @param {object} [options]
 * @param {number} [options.maxIterations] — max tool loop iterations (default 10)
 * @returns {Promise<{ text: string, files: Array, iterations: number, maxIterationsHit?: boolean }>}
 */
async function continueBridgeTurn(sessionKey, initialText, options = {}) {
  const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;

  // Parse the initial text for file blocks and tool blocks
  const { text: afterFiles, files: initialFiles } = parseFileBlocks(initialText);
  const { text: cleanText, toolCalls } = parseToolBlocks(afterFiles);

  if (toolCalls.length === 0) {
    return { text: cleanText, files: initialFiles, iterations: 0 };
  }

  let iteration = 0;
  let currentToolCalls = toolCalls;
  let lastText = cleanText;
  let lastFiles = initialFiles;

  while (currentToolCalls.length > 0 && iteration < maxIterations) {
    iteration++;

    // Execute tool calls in parallel
    const results = await Promise.all(currentToolCalls.map(tc => executeTool(tc)));

    // Send results back and wait for next reply
    const resultMessage = formatToolResults(results);
    const rawResponse = await sendAndWaitForReply(resultMessage, sessionKey);

    // Parse next reply
    const { text: nextAfterFiles, files } = parseFileBlocks(rawResponse);
    const { text: nextCleanText, toolCalls: nextCalls } = parseToolBlocks(nextAfterFiles);

    lastText = nextCleanText;
    lastFiles = files;

    if (nextCalls.length === 0) {
      return { text: nextCleanText, files, iterations: iteration };
    }

    currentToolCalls = nextCalls;
  }

  return {
    text: lastText,
    files: lastFiles,
    iterations: iteration,
    maxIterationsHit: true,
  };
}

module.exports = { runBridgeTurn, continueBridgeTurn };
