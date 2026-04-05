'use strict';

/**
 * email.js — Microsoft Graph API helpers for email (delegated auth).
 *
 * Three-tier EMAIL_MODE:
 *   off  — disabled entirely (default)
 *   read — poll inbox, manage mailbox (move, folders, flags, delete), no sending
 *   full — everything in read + compose, reply, forward — ALL send ops whitelist-gated
 *
 * Auth: Mail.ReadWrite (read/full) + Mail.Send (full only), delegated on /me/ endpoints.
 */

const { graphRequest } = require('./graph');
const { markdownToHtml } = require('./teams');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMAIL_MODE = (process.env.EMAIL_MODE || 'off').toLowerCase();

/**
 * Parse EMAIL_WHITELIST from .env.
 * Entries can be:
 *   - Full address: user@example.com
 *   - Domain wildcard: *@example.com  or just  example.com
 *   - Star (*): matches bot's own domain only (derived from BOT_EMAIL)
 *
 * @type {string[]}
 */
const RAW_WHITELIST = (process.env.EMAIL_WHITELIST || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

const BOT_EMAIL = (process.env.BOT_EMAIL || '').trim().toLowerCase();
const BOT_DOMAIN = BOT_EMAIL.includes('@') ? BOT_EMAIL.split('@')[1] : '';

// Resolve '*' to bot's own domain
const EMAIL_WHITELIST = RAW_WHITELIST.map(entry => {
  if (entry === '*' && BOT_DOMAIN) return `*@${BOT_DOMAIN}`;
  return entry;
});

// ---------------------------------------------------------------------------
// Mode guards
// ---------------------------------------------------------------------------

function requireMode(minimum) {
  const levels = { off: 0, read: 1, full: 2 };
  const current = levels[EMAIL_MODE] ?? 0;
  const required = levels[minimum] ?? 0;
  if (current < required) {
    throw new Error(`Email operation requires EMAIL_MODE="${minimum}" (current: "${EMAIL_MODE}")`);
  }
}

// ---------------------------------------------------------------------------
// Whitelist enforcement
// ---------------------------------------------------------------------------

/**
 * Check if a single email address passes the whitelist.
 * @param {string} address
 * @returns {boolean}
 */
function isWhitelisted(address) {
  if (!address) return false;
  const addr = address.toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';

  for (const entry of EMAIL_WHITELIST) {
    // Exact address match
    if (entry === addr) return true;
    // Domain wildcard: *@domain.com or just domain.com
    if (entry.startsWith('*@') && domain === entry.slice(2)) return true;
    if (!entry.includes('@') && domain === entry) return true;
  }
  return false;
}

/**
 * Validate all recipients against the whitelist. Throws if any are blocked.
 * @param {string[]} addresses — array of email addresses
 */
function validateRecipients(addresses) {
  if (EMAIL_WHITELIST.length === 0) {
    throw new Error('EMAIL_WHITELIST is empty — all send operations are blocked. Configure EMAIL_WHITELIST in .env.');
  }
  const blocked = addresses.filter(a => !isWhitelisted(a));
  if (blocked.length > 0) {
    throw new Error(`Email send blocked — recipients not on whitelist: ${blocked.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// HTML → plain text (email bodies)
// ---------------------------------------------------------------------------

/**
 * Strip HTML from an email body and decode entities.
 * More aggressive than Teams' extractPlainText — emails have deeper HTML.
 */
function extractEmailPlainText(body) {
  if (!body || !body.content) return '';
  let text = body.content;

  if (body.contentType === 'html' || /<[a-z]/i.test(text)) {
    // Remove style/script blocks entirely
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    // Structural breaks
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/tr>/gi, '\n');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<hr[^>]*>/gi, '\n---\n');
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&#x27;/g, "'");
    text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
    // Collapse excessive whitespace but preserve paragraph breaks
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Markdown → email HTML
// ---------------------------------------------------------------------------

/**
 * Convert markdown to standard HTML suitable for email clients.
 * Reuses Teams markdownToHtml then replaces Teams-specific tags.
 */
function markdownToEmailHtml(text) {
  let html = markdownToHtml(text);
  // Replace Teams-native <codeblock> with standard <pre><code>
  html = html.replace(/<codeblock[^>]*><code>/g, '<pre style="background:#f4f4f4;padding:8px;border-radius:4px;overflow-x:auto;"><code>');
  html = html.replace(/<\/code><\/codeblock>/g, '</code></pre>');
  return html;
}

// ---------------------------------------------------------------------------
// Read operations (require: read)
// ---------------------------------------------------------------------------

/**
 * Fetch unread emails from the bot's inbox.
 * @param {number} top — max results (default 25)
 * @returns {Promise<Array>} — Graph message objects
 */
async function getUnreadEmails(top = 25) {
  requireMode('read');
  const filter = encodeURIComponent('isRead eq false');
  const select = 'id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,hasAttachments';
  const result = await graphRequest(
    'GET',
    `/me/messages?$filter=${filter}&$select=${select}&$top=${top}&$orderby=receivedDateTime asc`,
  );
  return result.value || [];
}

/**
 * Get a single email by ID (full body).
 * @param {string} messageId
 * @returns {Promise<object>}
 */
async function getEmailById(messageId) {
  requireMode('read');
  return graphRequest('GET', `/me/messages/${messageId}`);
}

/**
 * Mark an email as read.
 * @param {string} messageId
 */
async function markAsRead(messageId) {
  requireMode('read');
  await graphRequest('PATCH', `/me/messages/${messageId}`, { isRead: true });
}

/**
 * Move an email to a different folder.
 * @param {string} messageId
 * @param {string} destinationFolderId — e.g. 'deleteditems', 'archive', or a folder ID
 */
async function moveEmail(messageId, destinationFolderId) {
  requireMode('read');
  await graphRequest('POST', `/me/messages/${messageId}/move`, {
    destinationId: destinationFolderId,
  });
}

/**
 * Delete an email (moves to Deleted Items).
 * @param {string} messageId
 */
async function deleteEmail(messageId) {
  requireMode('read');
  await graphRequest('DELETE', `/me/messages/${messageId}`);
}

/**
 * List mail folders.
 * @returns {Promise<Array>}
 */
async function listFolders() {
  requireMode('read');
  const result = await graphRequest('GET', '/me/mailFolders?$top=50');
  return result.value || [];
}

// ---------------------------------------------------------------------------
// Send operations (require: full + whitelist)
// ---------------------------------------------------------------------------

/**
 * Reply to an email. Whitelist-gated.
 * @param {string} messageId — the Graph message ID to reply to
 * @param {string} htmlContent — HTML body for the reply
 */
async function replyToEmail(messageId, htmlContent) {
  requireMode('full');

  // Fetch the original message so we can validate where the reply will actually go.
  // Exchange routes replies to the Reply-To header when present, falling back to From.
  // Validating From alone lets an attacker set a trusted From + hostile Reply-To and
  // bypass the whitelist — so we always resolve the effective destination first.
  const original = await graphRequest('GET', `/me/messages/${messageId}?$select=from,replyTo,toRecipients,ccRecipients`);

  const replyToAddresses = (original.replyTo || [])
    .map(r => r.emailAddress?.address)
    .filter(Boolean);
  const fromAddress = original.from?.emailAddress?.address;

  const destinations = replyToAddresses.length > 0
    ? replyToAddresses
    : (fromAddress ? [fromAddress] : []);

  if (destinations.length === 0) {
    throw new Error(`Email reply blocked — original message ${messageId} has no From or Reply-To address to validate against whitelist.`);
  }
  validateRecipients(destinations);

  await graphRequest('POST', `/me/messages/${messageId}/reply`, {
    message: {
      body: {
        contentType: 'html',
        content: htmlContent,
      },
    },
  });
}

/**
 * Send a new email. Whitelist-gated — every recipient checked.
 * @param {string|string[]} to — recipient address(es)
 * @param {string} subject
 * @param {string} htmlContent — HTML body
 */
async function sendEmail(to, subject, htmlContent, cc = [], bcc = []) {
  requireMode('full');
  const toList  = Array.isArray(to) ? to : [to];
  const ccList  = Array.isArray(cc) ? cc : [cc].filter(Boolean);
  const bccList = Array.isArray(bcc) ? bcc : [bcc].filter(Boolean);
  validateRecipients([...toList, ...ccList, ...bccList]);

  const message = {
    subject,
    body: {
      contentType: 'html',
      content: htmlContent,
    },
    toRecipients: toList.map(addr => ({ emailAddress: { address: addr } })),
  };
  if (ccList.length > 0) {
    message.ccRecipients = ccList.map(addr => ({ emailAddress: { address: addr } }));
  }
  if (bccList.length > 0) {
    message.bccRecipients = bccList.map(addr => ({ emailAddress: { address: addr } }));
  }

  await graphRequest('POST', '/me/sendMail', { message, saveToSentItems: true });
}

/**
 * Forward an email. Whitelist-gated.
 * @param {string} messageId
 * @param {string|string[]} to — forward recipient(s)
 * @param {string} [comment] — optional comment prepended to the forwarded body
 */
async function forwardEmail(messageId, to, comment = '') {
  requireMode('full');
  const recipients = Array.isArray(to) ? to : [to];
  validateRecipients(recipients);

  await graphRequest('POST', `/me/messages/${messageId}/forward`, {
    comment,
    toRecipients: recipients.map(addr => ({
      emailAddress: { address: addr },
    })),
  });
}

// ---------------------------------------------------------------------------
// Bridge tool wrappers (accept markdown, convert to HTML)
// ---------------------------------------------------------------------------

const { registerTool } = require('./tools');

async function toolSendEmail({ to, subject, body, cc = [], bcc = [] }) {
  await sendEmail(to, subject, markdownToEmailHtml(body), cc, bcc);
  return { sent: true, to, cc, bcc, subject };
}

async function toolReplyToEmail({ messageId, body }) {
  await replyToEmail(messageId, markdownToEmailHtml(body));
  return { replied: true, messageId };
}

async function toolForwardEmail({ messageId, to, comment }) {
  await forwardEmail(messageId, to, comment || '');
  return { forwarded: true, messageId, to };
}

// Read tools (require EMAIL_MODE=read or full)
if (EMAIL_MODE === 'read' || EMAIL_MODE === 'full') {
  registerTool('get_emails', {
    top:      { type: 'number' },
    unreadOnly: { type: 'boolean' },
  }, async ({ top = 25, unreadOnly = true } = {}) => {
    const select = 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead';
    const filter = unreadOnly ? `&$filter=${encodeURIComponent('isRead eq false')}` : '';
    const result = await graphRequest('GET',
      `/me/messages?$select=${select}&$top=${top}&$orderby=receivedDateTime desc${filter}`
    );
    return result.value || [];
  });

  registerTool('get_email', {
    messageId: { type: 'string', required: true },
  }, async ({ messageId }) => {
    return getEmailById(messageId);
  });

  registerTool('search_emails', {
    query: { type: 'string', required: true },
    top:   { type: 'number' },
  }, async ({ query, top = 25 }) => {
    const select = 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments';
    const result = await graphRequest('GET',
      `/me/messages?$search="${encodeURIComponent(query)}"&$select=${select}&$top=${top}&$orderby=receivedDateTime desc`
    );
    return result.value || [];
  });
}

// Send tools (require EMAIL_MODE=full)
if (EMAIL_MODE === 'full') {
  registerTool('send_email', {
    to:      { type: 'array', required: true },
    subject: { type: 'string', required: true },
    body:    { type: 'string', required: true },
    cc:      { type: 'array' },
    bcc:     { type: 'array' },
  }, toolSendEmail);

  registerTool('reply_to_email', {
    messageId: { type: 'string', required: true },
    body:      { type: 'string', required: true },
  }, toolReplyToEmail);

  registerTool('forward_email', {
    messageId: { type: 'string', required: true },
    to:        { type: 'array', required: true },
    comment:   { type: 'string' },
  }, toolForwardEmail);
}

// Log what was registered based on mode
if (EMAIL_MODE === 'off') {
  console.log(`[${new Date().toISOString()}] [email] EMAIL_MODE=off — no email tools registered`);
} else if (EMAIL_MODE === 'read') {
  console.log(`[${new Date().toISOString()}] [email] EMAIL_MODE=read — email read tools registered (send tools require full)`);
} else if (EMAIL_MODE === 'full') {
  console.log(`[${new Date().toISOString()}] [email] EMAIL_MODE=full — all email tools registered (read + send)`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  EMAIL_MODE,
  isWhitelisted,
  validateRecipients,
  extractEmailPlainText,
  markdownToEmailHtml,
  // Read ops
  getUnreadEmails,
  getEmailById,
  markAsRead,
  moveEmail,
  deleteEmail,
  listFolders,
  // Send ops
  replyToEmail,
  sendEmail,
  forwardEmail,
};
