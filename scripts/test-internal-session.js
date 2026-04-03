'use strict';

/**
 * test-internal-session.js — Phase 0 event subscription prototype.
 *
 * Tests whether the bridge can passively observe agent output on a session
 * it didn't initiate via chat.send. Connects to the OpenClaw gateway using
 * the same Ed25519 auth flow as lib/openclaw.js.
 *
 * Usage: node scripts/test-internal-session.js
 */

const WebSocket = require('ws');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── Config ───────────────────────────────────────────────────────────────────
const SESSION_KEY = 'agent:main:bridge-internal';
const AGENT_ID    = process.env.OPENCLAW_AGENT_ID || 'main';

// ── Device identity ──────────────────────────────────────────────────────────
const DEVICE_JSON_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.openclaw', 'identity', 'device.json',
);

let _device = null;
function getDevice() {
  if (!_device) _device = JSON.parse(fs.readFileSync(DEVICE_JSON_PATH, 'utf8'));
  return _device;
}

// ── Base64url helpers (copied from lib/openclaw.js) ──────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function publicKeyRawB64url(pem) {
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return b64url(der.slice(der.length - 32));
}
function signPayload(privateKeyPem, payload) {
  return b64url(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)));
}
function buildV3Payload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  return ['v3', deviceId, clientId, clientMode, role, scopes.join(','), String(signedAtMs), token ?? '', nonce, platform, deviceFamily ?? ''].join('|');
}

function getWsUrl() {
  const raw = (process.env.OPENCLAW_URL || 'ws://127.0.0.1:18789').trim();
  return raw.startsWith('http') ? raw.replace(/^http/, 'ws') : raw;
}

// ── Logging ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(msg)  { console.log(`[${ts()}] ${msg}`); }
function logEvt(label, data) {
  console.log(`[${ts()}] [EVENT] ${label}`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

// ── State ────────────────────────────────────────────────────────────────────
let assistantParts = [];
let currentRunId   = null;
let attachMethod   = null;

// ── Subscribe attempt chain ──────────────────────────────────────────────────
// Tries multiple methods to attach to the session, logs what works/fails.

const SUBSCRIBE_METHODS = [
  { method: 'session.subscribe', params: sk => ({ sessionKey: sk }) },
  { method: 'session.watch',     params: sk => ({ sessionKey: sk }) },
  { method: 'sessions.observe',  params: sk => ({ sessionKey: sk }) },
];

async function trySubscribe(ws) {
  for (const entry of SUBSCRIBE_METHODS) {
    const id = crypto.randomUUID();
    log(`Trying ${entry.method} for "${SESSION_KEY}" (reqId: ${id})`);

    const result = await sendReq(ws, id, entry.method, entry.params(SESSION_KEY));

    if (result.ok) {
      log(`SUCCESS — ${entry.method} accepted`);
      attachMethod = entry.method;
      return true;
    }
    log(`REJECTED — ${entry.method}: ${JSON.stringify(result.error || result.payload || 'unknown')}`);
  }

  // Fallback: send a minimal chat.send to "attach" to the session
  log('All subscribe methods failed. Attempting minimal chat.send to attach...');
  const id = crypto.randomUUID();
  const result = await sendReq(ws, id, 'chat.send', {
    sessionKey: SESSION_KEY,
    message: '',
    deliver: false,
    idempotencyKey: crypto.randomUUID(),
  });

  if (result.ok) {
    log('SUCCESS — attached via empty chat.send');
    attachMethod = 'chat.send (empty)';
    return true;
  }
  log(`WARN — empty chat.send also failed: ${JSON.stringify(result.error || result.payload || 'unknown')}`);
  attachMethod = 'none (passive listen)';
  return false;
}

// ── Request/response helper ──────────────────────────────────────────────────
const _pending = new Map();

function sendReq(ws, id, method, params) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve({ ok: false, error: 'timeout (5s)' });
    }, 5_000);

    _pending.set(id, { resolve, timer });

    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

function handleRes(msg) {
  const entry = _pending.get(msg.id);
  if (entry) {
    clearTimeout(entry.timer);
    _pending.delete(msg.id);
    entry.resolve(msg);
  }
}

// ── Bridge-tool code fence detection ─────────────────────────────────────────
const BRIDGE_TOOL_RE = /```bridge-tool\n([\s\S]*?)```/g;

function checkForBridgeTools(text) {
  const matches = [...text.matchAll(BRIDGE_TOOL_RE)];
  if (matches.length > 0) {
    log(`BRIDGE-TOOL: Found ${matches.length} code fence block(s) in assistant output:`);
    for (const m of matches) {
      console.log('--- bridge-tool block ---');
      console.log(m[1].trim());
      console.log('--- end block ---');
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const token  = process.env.OPENCLAW_TOKEN || '';
  const device = getDevice();
  const wsUrl  = getWsUrl();

  const clientId     = 'cli';
  const clientMode   = 'cli';
  const role         = 'operator';
  const scopes       = ['operator.read', 'operator.write', 'operator.admin'];
  const platform     = process.platform;
  const deviceFamily = process.platform;

  log('=== Phase 0 — Event Subscription Prototype ===');
  log(`Target session key: ${SESSION_KEY}`);
  log(`Gateway: ${wsUrl}`);
  log(`Device: ${device.deviceId}`);
  log('');

  const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });

  ws.on('open', () => log('WebSocket connection opened'));

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));

    // ── Challenge → connect ──────────────────────────────────────────────
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const nonce    = msg.payload?.nonce || '';
      const signedAt = Date.now();
      const payload  = buildV3Payload({ deviceId: device.deviceId, clientId, clientMode, role, scopes, signedAtMs: signedAt, token, nonce, platform, deviceFamily });
      const signature = signPayload(device.privateKeyPem, payload);
      const publicKey = publicKeyRawB64url(device.publicKeyPem);

      ws.send(JSON.stringify({
        type: 'req', id: crypto.randomUUID(), method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: clientId, version: '2026.3.13', platform, deviceFamily, mode: clientMode },
          role, scopes, caps: [], commands: [], permissions: {},
          auth: { token }, locale: 'en-US', userAgent: 'openclaw-cli/2026.3.13',
          device: { id: device.deviceId, publicKey, signature, signedAt, nonce },
        },
      }));
      return;
    }

    // ── Responses ─────────────────────────────────────────────────────────
    if (msg.type === 'res') {
      // hello-ok means auth succeeded
      if (msg.ok && msg.payload?.type === 'hello-ok') {
        log('Authenticated (hello-ok)');
        log('');
        log('Attempting session subscription...');
        trySubscribe(ws).then((attached) => {
          log('');
          log(`Attach method: ${attachMethod}`);
          log('Listening for ALL events on this connection...');
          log('');
          log('──────────────────────────────────────────────────────');
          log('Now fire a test turn in another terminal:');
          log(`  openclaw agent --agent ${AGENT_ID} --session-id bridge-internal --message "test"`);
          log('──────────────────────────────────────────────────────');
          log('');
        });
        return;
      }

      // Route pending request responses
      handleRes(msg);
      return;
    }

    // ── Events — log everything for the target session ───────────────────

    if (msg.type !== 'event') {
      logEvt('UNKNOWN MESSAGE TYPE', msg);
      return;
    }

    const sessionKey = msg.payload?.sessionKey;
    const runId      = msg.payload?.runId || msg.payload?.data?.runId || null;

    // Track runId
    if (runId && runId !== currentRunId) {
      currentRunId = runId;
      log(`SESSION CORRELATION — sessionKey: ${sessionKey}, runId: ${runId}`);
    }

    // Filter: only log events for our target session (or log all if no sessionKey)
    if (sessionKey && sessionKey !== SESSION_KEY) {
      // Not our session — skip silently
      return;
    }

    // ── agent events ─────────────────────────────────────────────────────
    if (msg.event === 'agent') {
      const stream = msg.payload?.stream;
      const data   = msg.payload?.data;

      if (stream === 'assistant') {
        const delta = data?.delta || '';
        if (delta) {
          assistantParts.push(delta);
          process.stdout.write(delta); // stream to terminal in real time
        }
        return;
      }

      if (stream === 'lifecycle') {
        const phase = data?.phase;
        logEvt(`agent/lifecycle — phase: ${phase}`, data);

        if (phase === 'end') {
          // Turn complete — flush accumulated text
          const fullText = assistantParts.join('');
          if (fullText) {
            console.log(''); // newline after streamed deltas
            log(`TURN COMPLETE — ${fullText.length} chars accumulated`);
            checkForBridgeTools(fullText);
          } else {
            log('TURN COMPLETE — no assistant text accumulated');
          }
          // Reset for next turn
          assistantParts = [];
          currentRunId   = null;
        }
        return;
      }

      if (stream === 'tool') {
        logEvt('agent/tool', data);
        return;
      }

      // Other agent streams
      logEvt(`agent/${stream || 'unknown'}`, msg.payload);
      return;
    }

    // ── chat events ──────────────────────────────────────────────────────
    if (msg.event === 'chat') {
      logEvt(`chat — state: ${msg.payload?.state}`, msg.payload);
      return;
    }

    // ── Catch-all for any other events ───────────────────────────────────
    logEvt(`${msg.event || 'unknown'}`, msg.payload);
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    log(`WebSocket closed (${code}: ${reason || 'no reason'})`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('Shutting down (Ctrl+C)...');
    ws.close();
    process.exit(0);
  });
}

main();
