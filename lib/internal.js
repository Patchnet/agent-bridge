'use strict';

/**
 * internal.js — Bootstrap turn and orphan turn adoption for proactive tasks.
 *
 * The bridge runs a one-time bootstrap turn on startup to orient the agent,
 * then adopts orphan turns — completed agent turns the bridge didn't initiate
 * (e.g., cron jobs, system events) that contain bridge-tool blocks requiring
 * execution. This enables proactive outbound tasks (scheduled emails, briefings)
 * without requiring a dedicated internal session.
 */

const { sendToOpenclaw, onReply, registerOrphanTurnHandler } = require('./openclaw');
const { continueBridgeTurn } = require('./runner');
const { runBridgeTurn } = require('./runner');
const { parseToolBlocks } = require('./tools');

// ── Config ──────────────────────────────────────────────────────────────────
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';
const BOOTSTRAP_SESSION_KEY = `agent:${AGENT_ID}:bridge-internal`;
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

  log(`Running bootstrap turn on ${BOOTSTRAP_SESSION_KEY}`);
  try {
    const result = await runBridgeTurn(BOOTSTRAP_SESSION_KEY, BOOTSTRAP_MESSAGE, {
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

// ── Orphan turn adoption ───────────────────────────────────────────────────

/**
 * Handle a completed orphan turn — an agent turn the bridge didn't initiate.
 * Checks for bridge-tool blocks and adopts the turn if found.
 *
 * @param {string} text — accumulated assistant output
 * @param {string|null} runId — OpenClaw run ID for deduplication
 * @param {string} sessionKey — session the turn ran in
 */
async function handleOrphanTurn(text, runId, sessionKey) {
  // Idempotency: skip already-processed runs
  const dedupeKey = runId || `${sessionKey}:${Date.now()}`;
  if (runId && _processedRuns.has(runId)) {
    log(`Skipping already-processed orphan runId: ${runId}`);
    return;
  }
  _processedRuns.add(dedupeKey);
  _processedRunTimestamps.set(dedupeKey, Date.now());

  // Periodic cleanup
  cleanupProcessedRuns();

  log(`Orphan turn observed — session: ${sessionKey}, runId: ${runId || '(none)'}, text length: ${text.length}`);

  // Check for bridge-tool blocks
  const { toolCalls } = parseToolBlocks(text);

  if (toolCalls.length === 0) {
    log(`No bridge-tool blocks in orphan turn — ignoring`);
    return;
  }

  log(`Adopting orphan turn — ${toolCalls.length} bridge-tool call(s) found, executing on ${sessionKey}`);

  try {
    const result = await continueBridgeTurn(sessionKey, text, {
      maxIterations: MAX_TOOL_ITERATIONS,
    });
    log(`Orphan turn complete — ${result.iterations} iteration(s), ${result.maxIterationsHit ? 'max iterations hit' : 'clean finish'}`);
    if (result.text) {
      log(`Orphan turn final text (${result.text.length} chars): ${result.text.substring(0, 200)}${result.text.length > 200 ? '...' : ''}`);
    }
  } catch (err) {
    log(`Orphan turn adoption failed: ${err.message}`);
  }
}

/**
 * Register the orphan turn handler. Call once after bootstrap.
 * Catches all completed agent turns that have no pending resolver and no
 * session watcher — enables bridge tool execution for cron/system-event turns.
 */
function startOrphanTurnHandler() {
  log('Registering orphan turn handler for proactive task adoption');
  registerOrphanTurnHandler(handleOrphanTurn);
  log('Orphan turn handler active — bridge will adopt unsolicited turns with bridge-tool blocks');
}

module.exports = { runBootstrap, startOrphanTurnHandler };
