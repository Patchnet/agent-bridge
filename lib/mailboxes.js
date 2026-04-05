'use strict';

/**
 * mailboxes.js — Shared mailbox management.
 *
 * Bot-managed mailbox list persisted in mailbox-list.json.
 * The bot adds/removes shared mailboxes at runtime via bridge tools.
 * Exchange permissions are the access control — the bridge just tracks
 * which mailboxes to poll.
 */

const fs   = require('fs');
const path = require('path');
const { graphRequest } = require('./graph');
const { registerTool } = require('./tools');
const { validateRecipients } = require('./email');

const MAILBOX_FILE = path.resolve(process.cwd(), 'mailbox-list.json');

// ── Persistence ─────────────────────────────────────────────────────────

/**
 * Load shared mailbox list from disk.
 * @returns {object} — { "address": { addedAt, addedBy, lastPolled } }
 */
function loadMailboxes() {
  try {
    if (fs.existsSync(MAILBOX_FILE)) {
      return JSON.parse(fs.readFileSync(MAILBOX_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] [mailboxes] Failed to load ${MAILBOX_FILE}: ${err.message}`);
  }
  return {};
}

/**
 * Save shared mailbox list to disk.
 * @param {object} mailboxes
 */
function saveMailboxes(mailboxes) {
  try {
    fs.writeFileSync(MAILBOX_FILE, JSON.stringify(mailboxes, null, 2), 'utf8');
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [mailboxes] Failed to save ${MAILBOX_FILE}: ${err.message}`);
  }
}

// ── Probe ───────────────────────────────────────────────────────────────

/**
 * Test if the bot has access to a shared mailbox.
 * @param {string} address — email address of the shared mailbox
 * @returns {Promise<{ accessible: boolean, error?: string }>}
 */
async function probeMailbox(address) {
  try {
    await graphRequest('GET', `/users/${encodeURIComponent(address)}/messages?$top=1&$select=id`);
    return { accessible: true };
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      return { accessible: false, error: 'Access denied — Exchange permissions not granted for this mailbox' };
    }
    if (status === 404) {
      return { accessible: false, error: 'Mailbox not found — check the email address' };
    }
    return { accessible: false, error: err.message };
  }
}

// ── Tool implementations ────────────────────────────────────────────────

/**
 * Add a shared mailbox to the bot's poll list.
 * Probes first to validate access.
 * @param {{ address: string, addedBy?: string }} params
 */
async function addMailbox({ address, addedBy = 'agent' }) {
  const addr = address.trim().toLowerCase();
  const mailboxes = loadMailboxes();

  if (mailboxes[addr]) {
    return { added: false, message: `${addr} is already in the mailbox list` };
  }

  const probe = await probeMailbox(addr);
  if (!probe.accessible) {
    return { added: false, message: `Cannot access ${addr}: ${probe.error}` };
  }

  mailboxes[addr] = {
    addedAt: new Date().toISOString(),
    addedBy,
    lastPolled: null,
  };
  saveMailboxes(mailboxes);

  console.log(`[${new Date().toISOString()}] [mailboxes] Added shared mailbox: ${addr} (by ${addedBy})`);
  return { added: true, message: `Added ${addr} to the mailbox list. Polling will begin on the next cycle.` };
}

/**
 * Remove a shared mailbox from the bot's poll list.
 * @param {{ address: string, reason?: string }} params
 */
async function removeMailbox({ address, reason = 'manual removal' }) {
  const addr = address.trim().toLowerCase();
  const mailboxes = loadMailboxes();

  if (!mailboxes[addr]) {
    return { removed: false, message: `${addr} is not in the mailbox list` };
  }

  delete mailboxes[addr];
  saveMailboxes(mailboxes);

  console.log(`[${new Date().toISOString()}] [mailboxes] Removed shared mailbox: ${addr} (${reason})`);
  return { removed: true, message: `Removed ${addr} from the mailbox list. Polling stopped.` };
}

/**
 * List all shared mailboxes the bot is monitoring.
 */
async function listMailboxes() {
  const mailboxes = loadMailboxes();
  const entries = Object.entries(mailboxes).map(([address, info]) => ({
    address,
    addedAt: info.addedAt,
    addedBy: info.addedBy,
    lastPolled: info.lastPolled,
  }));
  return { count: entries.length, mailboxes: entries };
}

// ── Shared mailbox email operations ─────────────────────────────────────

/**
 * Fetch unread emails from a shared mailbox.
 * @param {string} address — shared mailbox email address
 * @param {number} top
 * @returns {Promise<Array>}
 */
async function getSharedMailboxEmails(address, top = 25) {
  const filter = encodeURIComponent('isRead eq false');
  const select = 'id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,hasAttachments';
  const result = await graphRequest(
    'GET',
    `/users/${encodeURIComponent(address)}/messages?$filter=${filter}&$select=${select}&$top=${top}&$orderby=receivedDateTime asc`,
  );
  return result.value || [];
}

/**
 * Mark a shared mailbox email as read.
 * @param {string} address — shared mailbox email address
 * @param {string} messageId
 */
async function markSharedAsRead(address, messageId) {
  await graphRequest('PATCH', `/users/${encodeURIComponent(address)}/messages/${messageId}`, { isRead: true });
}

/**
 * Reply to a shared mailbox email (sends from the shared mailbox address).
 * @param {string} address — shared mailbox email address
 * @param {string} messageId
 * @param {string} htmlContent
 */
async function replyToSharedEmail(address, messageId, htmlContent) {
  const emailMode = (process.env.EMAIL_MODE || 'off').toLowerCase();
  if (emailMode !== 'full') {
    throw new Error(`Shared mailbox reply requires EMAIL_MODE=full (current: ${emailMode})`);
  }

  // Resolve where the reply will actually be delivered and whitelist-gate it.
  // Prefer Reply-To (what Exchange honors) over From — see replyToEmail() for rationale.
  const original = await graphRequest(
    'GET',
    `/users/${encodeURIComponent(address)}/messages/${messageId}?$select=from,replyTo`,
  );
  const replyToAddresses = (original.replyTo || [])
    .map(r => r.emailAddress?.address)
    .filter(Boolean);
  const fromAddress = original.from?.emailAddress?.address;
  const destinations = replyToAddresses.length > 0
    ? replyToAddresses
    : (fromAddress ? [fromAddress] : []);
  if (destinations.length === 0) {
    throw new Error(`Shared mailbox reply blocked — original message ${messageId} has no From or Reply-To address to validate against whitelist.`);
  }
  validateRecipients(destinations);

  await graphRequest('POST', `/users/${encodeURIComponent(address)}/messages/${messageId}/reply`, {
    message: {
      body: {
        contentType: 'html',
        content: htmlContent,
      },
    },
  });
}

/**
 * Update lastPolled timestamp for a shared mailbox.
 * @param {string} address
 */
function updateLastPolled(address) {
  const mailboxes = loadMailboxes();
  if (mailboxes[address]) {
    mailboxes[address].lastPolled = new Date().toISOString();
    saveMailboxes(mailboxes);
  }
}

// ── Register tools ──────────────────────────────────────────────────────

registerTool('add_mailbox', {
  address: { type: 'string', required: true },
  addedBy: { type: 'string' },
}, addMailbox);

registerTool('remove_mailbox', {
  address: { type: 'string', required: true },
  reason:  { type: 'string' },
}, removeMailbox);

registerTool('list_mailboxes', {}, listMailboxes);

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  loadMailboxes,
  saveMailboxes,
  probeMailbox,
  addMailbox,
  removeMailbox,
  listMailboxes,
  getSharedMailboxEmails,
  markSharedAsRead,
  replyToSharedEmail,
  updateLastPolled,
};
