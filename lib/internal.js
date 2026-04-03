'use strict';

/**
 * internal.js — Bootstrap turn and proactive task handler for the internal session.
 *
 * The bridge runs a one-time bootstrap turn on startup to orient the agent,
 * then watches the internal session for proactive agent output (e.g., cron jobs)
 * that contains bridge-tool blocks requiring execution.
 */

const { sendToOpenclaw, onReply, registerSessionWatcher } = require('./openclaw');
const { runBridgeTurn } = require('./runner');
const { parseToolBlocks, executeTool, formatToolResults } = require('./tools');

// ── Config ──────────────────────────────────────────────────────────────────
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';
const INTERNAL_SESSION_KEY = `agent:${AGENT_ID}:bridge-internal`;
const MAX_TOOL_ITERATIONS = 10;
const PROCESSED_RUN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── State ───────────────────────────────────────────────────────────────────
let _bootstrapDone = false;

/** @type {Set<string>} — processed runIds for idempotency */
const _processedRuns = new Set();
/** @type {Map<string, number>} — runId → timestamp for TTL cleanup */
const _processedRunTimestamps = new Map();

function log(msg) {
  console.log(`[${new Date().toISOString()}] [internal] ${msg}`);
}

// ── TTL cleanup for processed runIds ────────────────────────────────────────
function cleanupProcessedRuns() {
  const cutoff = Date.now() - PROCESSED_RUN_TTL_MS;
  for (const [runId, ts] of _processedRunTimestamps) {
    if (ts < cutoff) {
      _processedRuns.delete(runId);
      _processedRunTimestamps.delete(runId);
    }
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

const BOOTSTRAP_MESSAGE = `[Channel: Internal | Type: Bootstrap]

The bridge is online. M365 tools are available in this session: email, calendar, tasks, files, people, shared mailboxes.

This is your bridge-aware internal session. Proactive tasks and cron jobs that need M365 access should run here.

## Startup instructions

Check your memory directory for any existing files.

**If memory is empty — this is Day One.** Execute these steps in order:

1. Check your email inbox using the get_emails bridge tool. Report what you see.
2. Check your calendar using the get_events bridge tool. Report what you see.
3. Send an introductory email to your manager using the send_email bridge tool. Introduce yourself, confirm your tools are online, and let them know you are ready for assignments.
4. Write your onboarding summary to memory. This marks onboarding as complete — future startups will see it and skip onboarding.

**If memory exists — you have been onboarded.** Read your recent memory entries, surface anything pending or unresolved, then stand by.

You MUST use bridge tools to complete these steps. Do not skip any step. Do not just say "Done" — execute each action now.

## How to use bridge tools

To call a bridge tool, emit a code fence block in your response:

\`\`\`bridge-tool
{"tool": "get_emails", "params": {"top": 5}}
\`\`\`

\`\`\`bridge-tool
{"tool": "get_events", "params": {"top": 5}}
\`\`\`

\`\`\`bridge-tool
{"tool": "send_email", "params": {"to": "recipient@example.com", "subject": "Subject line", "body": "Email body in markdown"}}
\`\`\`

The bridge executes these and returns results. You can call multiple tools in one response. Start with step 1 now.`;

/**
 * Run the one-time bootstrap turn. Best-effort — errors are logged and swallowed.
 * Must be called before poll loops start. Does not retry on failure.
 */
async function runBootstrap() {
  if (_bootstrapDone) return;
  _bootstrapDone = true;

  log(`Running bootstrap turn on ${INTERNAL_SESSION_KEY}`);
  try {
    const result = await runBridgeTurn(INTERNAL_SESSION_KEY, BOOTSTRAP_MESSAGE, {
      maxIterations: MAX_TOOL_ITERATIONS,
    });
    log(`Bootstrap complete — ${result.iterations} iteration(s), ${result.maxIterationsHit ? 'max iterations hit' : 'clean finish'}`);
    if (result.text) {
      log(`Bootstrap final text (${result.text.length} chars): ${result.text.substring(0, 200)}${result.text.length > 200 ? '...' : ''}`);
    }
  } catch (err) {
    log(`Bootstrap failed (best-effort, continuing): ${err.message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a message into the internal session and wait for one raw reply.
 * Uses onReply/sendToOpenclaw directly — no tool parsing or execution.
 * This creates a pending resolver, which prevents the watcher from firing
 * for this specific response (avoiding double-processing).
 *
 * @param {string} message
 * @returns {Promise<string>} — raw agent reply text
 */
function sendAndWait(message) {
  return new Promise((resolve, reject) => {
    onReply(INTERNAL_SESSION_KEY, (reply, err) => {
      if (err) reject(err);
      else resolve(reply);
    });
    sendToOpenclaw(message, INTERNAL_SESSION_KEY);
  });
}

// ── Proactive session watcher ───────────────────────────────────────────────

/**
 * Handle a completed turn observed on the internal session.
 * Checks for bridge-tool blocks, executes them, and loops results back.
 *
 * @param {string} text — accumulated assistant output
 * @param {string|null} runId — OpenClaw run ID for deduplication
 */
async function handleInternalTurn(text, runId) {
  // Idempotency: skip already-processed runs
  if (runId) {
    if (_processedRuns.has(runId)) {
      log(`Skipping already-processed runId: ${runId}`);
      return;
    }
    _processedRuns.add(runId);
    _processedRunTimestamps.set(runId, Date.now());
  }

  // Periodic cleanup
  cleanupProcessedRuns();

  log(`Observed internal turn — runId: ${runId || '(none)'}, text length: ${text.length}`);

  // Check for bridge-tool blocks
  const { text: cleanText, toolCalls } = parseToolBlocks(text);

  if (toolCalls.length === 0) {
    log(`No bridge-tool blocks found — no action needed`);
    return;
  }

  log(`Found ${toolCalls.length} bridge-tool call(s) — executing`);

  // Execute tool calls with iteration limit.
  // Each iteration: execute tools, send results back, get raw reply, check for more tools.
  // sendAndWait creates a pending resolver, so the watcher won't fire for the
  // agent's response to our tool results — preventing double-processing.
  let iteration = 0;
  let currentToolCalls = toolCalls;

  while (currentToolCalls.length > 0 && iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    log(`Tool loop iteration ${iteration}/${MAX_TOOL_ITERATIONS} — ${currentToolCalls.length} call(s)`);

    const results = await Promise.all(currentToolCalls.map(tc => executeTool(tc)));
    const resultMessage = formatToolResults(results);

    log(`Sending tool results back to ${INTERNAL_SESSION_KEY}`);

    try {
      const rawReply = await sendAndWait(resultMessage);
      const { toolCalls: nextCalls } = parseToolBlocks(rawReply);

      if (nextCalls.length === 0) {
        log(`Tool result loop complete after ${iteration} iteration(s)`);
        return;
      }

      currentToolCalls = nextCalls;
      log(`Agent responded with ${nextCalls.length} more tool call(s) — continuing loop`);
    } catch (err) {
      log(`Tool result send failed: ${err.message}`);
      return;
    }
  }

  if (iteration >= MAX_TOOL_ITERATIONS) {
    log(`Hit max tool iterations (${MAX_TOOL_ITERATIONS}) — stopping`);
  }
}

/**
 * Register the internal session watcher. Call once after bootstrap.
 * The watcher fires for turns the bridge didn't initiate (cron, workspace tasks, etc.).
 */
function startInternalWatcher() {
  log(`Registering session watcher on ${INTERNAL_SESSION_KEY}`);
  registerSessionWatcher(INTERNAL_SESSION_KEY, handleInternalTurn);
  log('Internal session watcher active — listening for proactive agent turns');
}

module.exports = { runBootstrap, startInternalWatcher };
