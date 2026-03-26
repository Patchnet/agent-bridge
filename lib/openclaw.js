'use strict';

/**
 * openclaw.js — Persistent WebSocket client for the OpenClaw AI gateway.
 * Updated: 2026-03-18 — persistent connection, no per-message auth overhead
 */

const WebSocket = require('ws');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

const QUERY_TIMEOUT_MS  = 600_000; // 10 min per query
const RECONNECT_DELAY_MS = 3_000;  // 3s before reconnect
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';

// ── Device identity ──────────────────────────────────────────────────────
const DEVICE_JSON_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.openclaw', 'identity', 'device.json',
);
let _device = null;
function getDevice() {
  if (!_device) _device = JSON.parse(fs.readFileSync(DEVICE_JSON_PATH, 'utf8'));
  return _device;
}

// ── Base64url helpers ────────────────────────────────────────────────────
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

// ── Persistent connection state ──────────────────────────────────────────
let _ws        = null;
let _ready     = false;
let _pendingResolvers = new Map(); // runId → { resolve, reject, timer, parts }

function log(msg) {
  console.log(`[${new Date().toISOString()}] [openclaw] ${msg}`);
}

function connectPersistent() {
  const token  = process.env.OPENCLAW_TOKEN || '';
  const device = getDevice();
  const clientId   = 'cli';
  const clientMode = 'cli';
  const role       = 'operator';
  const scopes     = ['operator.read', 'operator.write', 'operator.admin'];
  const platform   = process.platform;
  const deviceFamily = process.platform;

  const url = token ? `${getWsUrl()}?token=${encodeURIComponent(token)}` : getWsUrl();
  const ws  = new WebSocket(url, { handshakeTimeout: 10_000 });
  _ws = ws;
  _ready = false;

  ws.on('open', () => log('WS connection opened'));

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
      if (msg.ok && msg.payload?.type === 'hello-ok') {
        _ready = true;
        log('Authenticated and ready');
      } else if (!msg.ok) {
        log(`Request failed: ${JSON.stringify(msg.error || msg.payload || msg)}`);
      }
      return;
    }

    // ── Streaming text ───────────────────────────────────────────────────
    if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.stream === 'assistant') {
      const sessionKey = msg.payload?.sessionKey;
      const entry = sessionKey ? findBySessionKey(sessionKey) : null;
      if (entry) {
        const delta = msg.payload?.data?.delta || '';
        if (delta) entry.parts.push(delta);
      }
      return;
    }

    // ── Turn complete ────────────────────────────────────────────────────
    if (msg.type === 'event' && msg.event === 'agent' &&
        msg.payload?.stream === 'lifecycle' && msg.payload?.data?.phase === 'end') {
      const sessionKey = msg.payload?.sessionKey;
      const entry = sessionKey ? findBySessionKey(sessionKey) : null;
      if (entry) {
        clearTimeout(entry.timer);
        _pendingResolvers.delete(entry.key);
        entry.callback(entry.parts.join('').trim() || 'Done.', null);
      }
      return;
    }

    // ── Final chat fallback ──────────────────────────────────────────────
    if (msg.type === 'event' && msg.event === 'chat' && msg.payload?.state === 'final') {
      const sessionKey = msg.payload?.sessionKey;
      const entry = sessionKey ? findBySessionKey(sessionKey) : null;
      if (entry) {
        clearTimeout(entry.timer);
        _pendingResolvers.delete(entry.key);
        const content = msg.payload?.message?.content;
        const text = Array.isArray(content) ? content.map(c => c.text || '').join('') : entry.parts.join('');
        entry.callback(text.trim() || 'Done.', null);
      }
      return;
    }
  });

  ws.on('error', (err) => {
    log(`WS error: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    _ready = false;
    _ws    = null;
    log(`WS closed (${code}) — reconnecting in ${RECONNECT_DELAY_MS}ms`);
    // Fail any pending callbacks immediately
    for (const [key, entry] of _pendingResolvers) {
      clearTimeout(entry.timer);
      entry.callback(null, new Error('WebSocket disconnected'));
    }
    _pendingResolvers.clear();
    setTimeout(connectPersistent, RECONNECT_DELAY_MS);
  });
}

function findBySessionKey(sessionKey) {
  for (const [key, entry] of _pendingResolvers) {
    if (entry.sessionKey === sessionKey) return entry;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Build a session key for a given channel and ID.
 * @param {'teams'|'email'} channel
 * @param {string} id — chatId for Teams, conversationId for email
 * @returns {string}
 */
function buildSessionKey(channel, id) {
  return `agent:${AGENT_ID}:${channel}-${id}`.toLowerCase();
}

/**
 * Register a one-time callback for when a reply arrives for a session key.
 * Must be called BEFORE sendToOpenclaw so the entry exists when chunks arrive.
 *
 * @param {string} sessionKey — full session key from buildSessionKey()
 * @param {(reply: string|null, err: Error|null) => void} callback
 */
function onReply(sessionKey, callback) {
  const key = `${sessionKey}:${Date.now()}`;

  const timer = setTimeout(() => {
    _pendingResolvers.delete(key);
    callback(null, new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms`));
  }, QUERY_TIMEOUT_MS);

  _pendingResolvers.set(key, { key, sessionKey, callback, timer, parts: [] });
}

/**
 * Send a message to OpenClaw — returns immediately (fire-and-forget).
 * The reply arrives via the callback registered with onReply().
 *
 * @param {string} message
 * @param {string} sessionKey — full session key from buildSessionKey()
 */
function sendToOpenclaw(message, sessionKey) {

  const send = () => {
    _ws.send(JSON.stringify({
      type:   'req',
      id:     crypto.randomUUID(),
      method: 'chat.send',
      params: { sessionKey, message, deliver: false, idempotencyKey: crypto.randomUUID() },
    }));
  };

  if (_ready && _ws?.readyState === WebSocket.OPEN) {
    send();
  } else {
    // Wait up to 15s for connection to be ready
    const deadline = Date.now() + 15_000;
    const interval = setInterval(() => {
      if (_ready && _ws?.readyState === WebSocket.OPEN) {
        clearInterval(interval);
        send();
      } else if (Date.now() > deadline) {
        clearInterval(interval);
        // Fire error on the pending callback if one exists
        const entry = findBySessionKey(sessionKey);
        if (entry) {
          clearTimeout(entry.timer);
          _pendingResolvers.delete(entry.key);
          entry.callback(null, new Error('OpenClaw not ready after 15s'));
        }
      }
    }, 200);
  }
}

// Start persistent connection immediately on module load
connectPersistent();

module.exports = { sendToOpenclaw, onReply, buildSessionKey };
