'use strict';

/**
 * index.js — Patchnet Agent Bridge
 *
 * Polls Microsoft Graph for new DM messages sent to the bot account,
 * forwards each message to the Openclaw AI gateway, and posts the reply
 * back to the same Teams chat.
 *
 * Usage:
 *   cp .env.example .env     # fill in CLIENT_SECRET and REFRESH_TOKEN
 *   npm install
 *   npm start
 */

require('dotenv').config();

const { getChats, getMessagesSince, sendMessage, editMessage, extractPlainText, extractAttachments, downloadAttachment, sendFile, sendReferenceLink, setPresence, getJoinedTeams, getChannels, getChannelMessages, getChannelMessagesWithReplies, sendChannelMessage, replyToChannelMessage, sendChannelFile } = require('./lib/teams');
const { forceRefresh } = require('./lib/auth');
const { graphRequest } = require('./lib/graph');
const { sendToOpenclaw, onReply, buildSessionKey } = require('./lib/openclaw');
const { EMAIL_MODE, getUnreadEmails, markAsRead, replyToEmail, extractEmailPlainText, markdownToEmailHtml } = require('./lib/email');
const { parseFileBlocks } = require('./lib/files');
const { parseToolBlocks, executeTool, formatToolResults, getToolNames } = require('./lib/tools');

// Import tool modules — registration happens on require()
require('./lib/calendar');
require('./lib/tasks');
require('./lib/people');
require('./lib/drive');
const { loadMailboxes, getSharedMailboxEmails, markSharedAsRead, replyToSharedEmail, updateLastPolled, removeMailbox } = require('./lib/mailboxes');
const { printLogo, printTagline, printDivider, printFooter } = require('./lib/logo');
const { loadModes, saveModes, getMode, setMode, detectTeamChanges, parseManagerCommand, isManagerCommand, formatTeamList, findTeamByName } = require('./lib/channels');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOG_LEVEL                = (process.env.LOG_LEVEL || 'full').toLowerCase();
const POLL_INTERVAL_MS         = parseInt(process.env.POLL_INTERVAL_MS, 10) || 5_000;
const EMAIL_POLL_INTERVAL_MS   = parseInt(process.env.EMAIL_POLL_INTERVAL_MS, 10) || 15_000;
const CHANNEL_POLL_INTERVAL_MS = parseInt(process.env.CHANNEL_POLL_INTERVAL_MS, 10) || 10_000;
const BOT_USER_ID              = (process.env.BOT_USER_ID || '').trim();
const CHANNEL_MANAGER          = (process.env.CHANNEL_MANAGER || '').trim().toLowerCase();
const ALLOWED_USERS            = (process.env.ALLOWED_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);

if (!process.env.CLIENT_SECRET || !process.env.REFRESH_TOKEN) {
  console.error('[bridge] ERROR: CLIENT_SECRET and REFRESH_TOKEN must be set in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Per-chat cursor: stores the ISO timestamp of the last processed message.
 * @type {Map<string, string>}  chatId → ISO timestamp
 */
const lastSeen = new Map();

/**
 * Per-chat FIFO queue. Each entry: { queue: Message[], processing: bool }
 * Sequential within a chat, parallel across chats.
 * @type {Map<string, { queue: object[], processing: boolean }>}
 */
const chatQueues = new Map();

/** Presence reference counter — stays Busy while any chat is in-flight. */
let presenceRefCount = 0;

// Channel state
const channelModes    = loadModes();
const channelLastSeen = new Map();  // `${teamId}:${channelId}` -> ISO timestamp (top-level cursor)
const channelQueues   = new Map();  // `${channelId}:${threadId}` -> FIFO queue
let knownTeams        = [];         // cached getJoinedTeams() result
let knownTeamsExpiry  = 0;          // epoch ms — TTL for team/channel metadata cache
const TEAM_CACHE_TTL  = 5 * 60_000; // 5 minutes
const channelCache    = new Map();  // teamId -> { channels, expiry }
let channelPollRunning = false;

// Active thread tracking — threads where the bot has replied, monitored for follow-ups
// Key: `${teamId}:${channelId}:${messageId}` → { lastReplyTime: ISO, lastActivity: epoch ms }
const activeThreads     = new Map();
const THREAD_IDLE_MS    = 48 * 60 * 60_000; // 48 hours — drop threads with no activity

async function getCachedTeams() {
  if (knownTeams.length > 0 && Date.now() < knownTeamsExpiry) return knownTeams;
  knownTeams = await getJoinedTeams();
  knownTeamsExpiry = Date.now() + TEAM_CACHE_TTL;
  return knownTeams;
}

async function getCachedChannels(teamId) {
  const cached = channelCache.get(teamId);
  if (cached && Date.now() < cached.expiry) return cached.channels;
  const channels = await getChannels(teamId);
  channelCache.set(teamId, { channels, expiry: Date.now() + TEAM_CACHE_TTL });
  return channels;
}

// ---------------------------------------------------------------------------
// Presence helpers (ref-counted)
// ---------------------------------------------------------------------------

async function acquirePresence() {
  presenceRefCount++;
  if (presenceRefCount === 1) await setPresence('Busy', 'Busy', 5);
}

async function releasePresence() {
  presenceRefCount = Math.max(0, presenceRefCount - 1);
  if (presenceRefCount === 0) await setPresence('Available', 'Available', 60);
}

// ---------------------------------------------------------------------------
// Error messages for user notification
// ---------------------------------------------------------------------------

function buildErrorMessage(err) {
  const msg = err?.message || '';
  if (msg.includes('timeout'))           return 'Sorry, the AI service took too long to respond. Please try again.';
  if (msg.includes('WebSocket'))         return 'Sorry, the connection to the AI service was lost. Please try again.';
  if (msg.includes('not ready'))         return 'Sorry, the AI service is not available right now. Please try again in a moment.';
  return 'Sorry, something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(tag, msg) {
  if (LOG_LEVEL === 'errors') return;
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function logStartup(tag, msg) {
  // Always logs regardless of level (startup banner, config display)
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function logErr(tag, msg, err) {
  const detail = err?.response?.data
    ? JSON.stringify(err.response.data)
    : (err?.message || String(err));
  console.error(`[${new Date().toISOString()}] [${tag}] ${msg}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Chat seeding (startup)
// ---------------------------------------------------------------------------

/**
 * Initialise the cursor for a chat we haven't seen before.
 * Fetches the most-recent message (if any) and sets the cursor to its
 * timestamp, so we only forward messages that arrive AFTER startup.
 */
async function seedChat(chatId) {
  try {
    const recent = await getMessagesSince(chatId, null);   // top-1, no filter
    if (recent.length > 0) {
      lastSeen.set(chatId, recent[0].createdDateTime);
    } else {
      // Empty chat — use current time as cursor
      lastSeen.set(chatId, new Date().toISOString());
    }
    log('bridge', `Seeded chat ${chatId} at ${lastSeen.get(chatId)}`);
  } catch (err) {
    // Fallback: use current time so we don't leave the cursor unset
    lastSeen.set(chatId, new Date().toISOString());
    logErr('bridge', `Could not seed chat ${chatId}, using now`, err);
  }
}

// ---------------------------------------------------------------------------
// Message processing — async queue model
// ---------------------------------------------------------------------------

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const ACK_THRESHOLD_MS = 6_000;
const MAX_TOOL_ITERATIONS = 10;

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

const ACK_MESSAGES = [
  '\u23F3 Working on it...',
  '\uD83E\uDD14 Thinking...',
  '\uD83D\uDCAA On it...',
  '\u261D\uFE0F Give me a sec...',
  '\u2699\uFE0F Processing...',
  '\uD83D\uDCB0 Placing tokens in the bag...',
  "\uD83D\uDE80 It's in the pipe, five by five",
  '\u2692\uFE0F SCV good to go, sir',
  '\uD83C\uDFAF Oscar Mike',
  '\uD83D\uDC4D Yep, on that',
  "\uD83C\uDF5A I'm on it like white on rice",
  '\u2694\uFE0F Yes, my lord',
  '\u2693 Aye!',
  '\u26A1 When this baby hits 88mph...',
  '\uD83C\uDFAC Just when I thought I was out... they pulled me back in',
  '\uD83C\uDF39 Don Corleone is... handling it',
  '\uD83D\uDE31 Game over man... just kidding, working on it',
  '\uD83D\uDE81 Get to the choppa!',
  "\uD83D\uDCAA I ain't got time to bleed",
  '\uD83C\uDF70 Taking the cannoli..',
  '\uD83E\uDD0C Gabagool over here!...',
  '\uD83E\uDDE0 Tensors loading..',
  '\uD83D\uDCDC So it is written, so it shall be done.',
  '\uD83D\uDC7D Ack..ack ack',
  '\uD83D\uDC3B Loud wookiee noises..',
  "\uD83D\uDD34 I am sorry..I can't do that..j/k",
  '\uD83E\uDDE0 I have a brain the size of a planet and you ask for this?',
  '\uD83D\uDD75\uFE0F Ill be back',
  '\uD83E\uDD16 Come with me if you want to live',
  '\uD83D\uDD96 Fascinating..',
  '\uD83E\uDD16 Im 40% titanium!',
  '\uD83D\uDE80 Welcome to the future, baby!',
];

function randomAck() {
  return ACK_MESSAGES[Math.floor(Math.random() * ACK_MESSAGES.length)];
}

/**
 * Enqueue a message for processing. Non-blocking — returns immediately.
 * Messages within the same chat are processed sequentially (FIFO).
 */
function enqueueMessage(chatId, msg) {
  if (!chatQueues.has(chatId)) chatQueues.set(chatId, { queue: [], processing: false });
  chatQueues.get(chatId).queue.push(msg);
  if (!chatQueues.get(chatId).processing) drainQueue(chatId);
}

/**
 * Drain one message at a time from a chat's queue.
 * Waits for the reply callback before advancing to the next message.
 */
async function drainQueue(chatId) {
  const q = chatQueues.get(chatId);
  q.processing = true;
  while (q.queue.length > 0) {
    const msg = q.queue.shift();
    await dispatchMessage(chatId, msg);
  }
  q.processing = false;
}

/**
 * Dispatch a single message to OpenClaw and resolve when the reply is
 * delivered to Teams. Handles allowlist, attachments, ack threshold,
 * presence, and error notification.
 *
 * @param {string} chatId
 * @param {object} msg — Graph ChatMessage object
 * @returns {Promise<void>}
 */
async function dispatchMessage(chatId, msg) {
  const text        = extractPlainText(msg.body);
  const attachments = extractAttachments(msg);

  // Skip if no text AND no attachments
  if (!text && attachments.length === 0) return;

  const sender =
    msg.from?.user?.displayName ||
    msg.from?.user?.userPrincipalName ||
    msg.from?.user?.id ||
    'unknown';

  log('teams', `Chat ${chatId} | from: ${sender} | "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`);

  // ── Allowlist check ───────────────────────────────────────────────────
  if (ALLOWED_USERS.length > 0) {
    const senderUpn = (msg.from?.user?.userPrincipalName || '').toLowerCase();
    const senderId  = (msg.from?.user?.id || '').toLowerCase();
    log('bridge', `Allowlist check: upn="${senderUpn}" id="${senderId}"`);
    const isAllowed = ALLOWED_USERS.includes(senderUpn) || ALLOWED_USERS.includes(senderId);
    if (!isAllowed) {
      log('bridge', `Rejected message from unauthorized user: ${senderUpn || senderId}`);
      await sendMessage(chatId,
        `Sorry, I'm not authorized to chat with you. Please contact your admin if you need access.`
      ).catch(() => {});
      return;
    }
  }

  // ── Channel manager commands (DM only) ────────────────────────────────
  if (CHANNEL_MANAGER) {
    const senderUpnLower = (msg.from?.user?.userPrincipalName || '').toLowerCase();
    const senderIdLower  = (msg.from?.user?.id || '').toLowerCase();
    const isManager = senderUpnLower === CHANNEL_MANAGER || senderIdLower === CHANNEL_MANAGER;

    if (isManager && isManagerCommand(text)) {
      await handleManagerCommand(chatId, text);
      return;
    }
  }

  // ── Handle file attachments ───────────────────────────────────────────
  let attachmentContext = '';
  const tempFiles = [];

  if (attachments.length > 0) {
    const descriptions = [];
    for (const att of attachments) {
      log('files', `Attachment: ${att.name} (${att.contentType})`);
      if (att.contentUrl) {
        const downloaded = await downloadAttachment(att.contentUrl, att.name);
        if (downloaded) {
          const ext      = att.contentType.includes('image') ? '.jpg' : path.extname(att.name) || '.bin';
          const tmpPath  = path.join(os.tmpdir(), `teams-att-${crypto.randomBytes(8).toString('hex')}${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(downloaded.data, 'base64'));
          tempFiles.push(tmpPath);
          descriptions.push(`[File: ${att.name} | ${att.contentType} | ${Math.round(downloaded.sizeBytes/1024)}KB | ${tmpPath}]`);
        } else {
          descriptions.push(`[File: "${att.name}" - visible but not downloadable (needs Sites.Read.All)]`);
        }
      }
    }
    if (descriptions.length > 0) {
      attachmentContext = '\n' + descriptions.join('\n');
    }
  }

  // ── Build message with context ────────────────────────────────────────
  const contextPrefix = `[Channel: Microsoft Teams | From: ${sender}]\n`;
  const messageWithContext = contextPrefix + (text || '[File shared — see attachment below]') + attachmentContext;

  // ── 6s ack threshold (edit-in-place) ──────────────────────────────────
  let ackMessageId = null;
  const ackTimer = setTimeout(async () => {
    try {
      log('bridge', `Ack timer fired for chat ${chatId} — sending ack`);
      ackMessageId = await sendMessage(chatId, randomAck());
      log('bridge', `Ack sent (${ackMessageId}) in chat ${chatId}`);
    } catch (ackErr) {
      logErr('bridge', `Ack failed in chat ${chatId}`, ackErr);
    }
  }, ACK_THRESHOLD_MS);

  // ── Presence ──────────────────────────────────────────────────────────
  await acquirePresence();

  // ── Tool loop: send → reply → execute tools → send results → repeat ──
  const sessionKey = buildSessionKey('teams', chatId);
  let currentMessage = messageWithContext;
  let iteration = 0;

  try {
    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;
      let rawResponse;

      try {
        rawResponse = await sendAndWaitForReply(currentMessage, sessionKey);
      } catch (err) {
        clearTimeout(ackTimer);
        logErr('openclaw', 'Query failed', err);
        rawResponse = buildErrorMessage(err);
        // On error, deliver the error message and break out of the loop
        await deliverReply(chatId, rawResponse, [], ackMessageId);
        ackMessageId = null;
        break;
      }

      // Clear ack timer on first reply only
      if (iteration === 1) clearTimeout(ackTimer);

      // Parse file blocks and tool blocks from the reply
      const { text: afterFiles, files } = parseFileBlocks(rawResponse);
      const { text: cleanText, toolCalls } = parseToolBlocks(afterFiles);

      log('openclaw', `Reply (turn ${iteration}): "${cleanText.slice(0, 120)}${cleanText.length > 120 ? '...' : ''}"` +
        `${files.length ? ` (${files.length} file(s))` : ''}` +
        `${toolCalls.length ? ` (${toolCalls.length} tool call(s))` : ''}`);

      // Execute file blocks immediately (fire-and-forget per iteration)
      for (const f of files) {
        try {
          if (f.path) {
            const ok = await sendFile(chatId, f.path, f.name);
            log('teams', ok ? `Sent file "${f.name}"` : `Failed to send file "${f.name}"`);
          } else if (f.url) {
            await sendReferenceLink(chatId, f.url, f.name);
            log('teams', `Shared link "${f.name}"`);
          }
        } catch (fileErr) {
          logErr('teams', `Failed to send file "${f.name}"`, fileErr);
        }
      }

      // No tool calls → final reply, deliver and break
      if (toolCalls.length === 0) {
        await deliverReply(chatId, cleanText, [], ackMessageId);
        ackMessageId = null;
        break;
      }

      // Post intermediate text to user if present (edit-in-place)
      if (cleanText.trim()) {
        try {
          if (ackMessageId) {
            await editMessage(chatId, ackMessageId, cleanText);
            log('teams', `Posted intermediate reply (turn ${iteration})`);
          } else {
            ackMessageId = await sendMessage(chatId, cleanText);
            log('teams', `Posted intermediate reply (turn ${iteration})`);
          }
        } catch (_) { /* intermediate delivery is best-effort */ }
      }

      // Execute tool calls in parallel
      const results = await Promise.all(toolCalls.map(tc => executeTool(tc)));

      // Send results back to agent in the same session
      currentMessage = formatToolResults(results);
      log('tools', `Sent ${results.length} tool result(s) back to agent`);
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      logErr('tools', `Tool loop hit max iterations (${MAX_TOOL_ITERATIONS})`, new Error('max iterations'));
      await sendMessage(chatId, 'I got stuck in a loop. Please try rephrasing your request.');
    }
  } finally {
    // Clean up temp files
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    }
    await releasePresence();
  }
}

/**
 * Deliver the final reply to a Teams chat. Handles edit-in-place if ack exists.
 */
async function deliverReply(chatId, text, files, ackMessageId) {
  try {
    if (text.trim()) {
      if (ackMessageId) {
        await editMessage(chatId, ackMessageId, text);
        log('teams', `Edited ack in chat ${chatId}`);
      } else {
        await sendMessage(chatId, text);
        log('teams', `Replied to chat ${chatId}`);
      }
    } else if (ackMessageId) {
      await editMessage(chatId, ackMessageId, 'Here are the requested files:');
      log('teams', `Edited ack (files-only) in chat ${chatId}`);
    }
  } catch (sendErr) {
    logErr('teams', `Failed to send reply to chat ${chatId}`, sendErr);
  }
}

/**
 * Process all new messages in one chat.
 * Hands messages off to the per-chat queue (non-blocking).
 *
 * @param {object} chat — Graph Chat object (must have .id)
 */
async function processChat(chat) {
  const chatId = chat.id;

  try {
    // Seed cursor on first encounter
    if (!lastSeen.has(chatId)) {
      await seedChat(chatId);
      return;
    }

    const since = lastSeen.get(chatId);
    const messages = await getMessagesSince(chatId, since);

    // Filter to real user messages — skip bot's own messages and system events
    const userMessages = messages.filter((m) => {
      if (m.messageType !== 'message') return false;
      const senderId = m.from?.user?.id || m.from?.application?.id;
      if (BOT_USER_ID && senderId === BOT_USER_ID) return false;
      return true;
    });

    if (userMessages.length === 0) return;

    log('bridge', `${userMessages.length} new message(s) in chat ${chatId}`);

    for (const msg of userMessages) {
      lastSeen.set(chatId, msg.createdDateTime);
      enqueueMessage(chatId, msg);  // non-blocking
    }
  } catch (err) {
    logErr('bridge', `Error processing chat ${chatId}`, err);
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

let pollCount = 0;
let pollRunning = false;

async function poll() {
  if (pollRunning) {
    log('bridge', 'Previous poll still running — skipping this tick');
    return;
  }
  pollRunning = true;
  pollCount++;

  try {
    const chats = await getChats();

    if (pollCount === 1) {
      log('bridge', `Discovered ${chats.length} oneOnOne chat(s) — seeding cursors…`);
    }

    // Process all chats concurrently — each chat's queue handles ordering
    await Promise.allSettled(chats.map((chat) => processChat(chat)));
  } catch (err) {
    logErr('bridge', 'Poll failed', err);
  } finally {
    pollRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Email polling (EMAIL_MODE=full only)
// ---------------------------------------------------------------------------

/**
 * Per-conversation email queue — same FIFO model as Teams.
 * Key: conversationId, Value: { queue: EmailMsg[], processing: boolean }
 * @type {Map<string, { queue: object[], processing: boolean }>}
 */
const emailQueues = new Map();

function enqueueEmail(conversationId, emailMsg) {
  if (!emailQueues.has(conversationId)) emailQueues.set(conversationId, { queue: [], processing: false });
  emailQueues.get(conversationId).queue.push(emailMsg);
  if (!emailQueues.get(conversationId).processing) drainEmailQueue(conversationId);
}

async function drainEmailQueue(conversationId) {
  const q = emailQueues.get(conversationId);
  q.processing = true;
  while (q.queue.length > 0) {
    const emailMsg = q.queue.shift();
    await dispatchEmail(conversationId, emailMsg);
  }
  q.processing = false;
}

/**
 * Dispatch a single email to OpenClaw and reply when done.
 * @param {string} conversationId
 * @param {object} emailMsg — Graph message object
 */
async function dispatchEmail(conversationId, emailMsg) {
  const sender  = emailMsg.from?.emailAddress?.address || 'unknown';
  const subject = emailMsg.subject || '(no subject)';
  const bodyText = extractEmailPlainText(emailMsg.body);
  const messageId = emailMsg.id;
  const sharedMailbox = emailMsg._sharedMailbox || null;

  if (!bodyText) return;

  const mailboxLabel = sharedMailbox ? ` (via ${sharedMailbox})` : '';
  log('email', `From: ${sender}${mailboxLabel} | Subject: "${subject}" | "${bodyText.slice(0, 120)}${bodyText.length > 120 ? '…' : ''}"`);

  // ── Build message with context ──────────────────────────────────────
  const contextPrefix = sharedMailbox
    ? `[Channel: Email | Mailbox: ${sharedMailbox} | From: ${sender} | Subject: ${subject}]\n`
    : `[Channel: Email | From: ${sender} | Subject: ${subject}]\n`;
  const messageWithContext = contextPrefix + bodyText;

  // ── Presence ────────────────────────────────────────────────────────
  await acquirePresence();

  // ── Tool loop ──────────────────────────────────────────────────────
  const sessionKey = buildSessionKey('email', conversationId);
  let currentMessage = messageWithContext;
  let iteration = 0;

  try {
    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;
      let rawResponse;

      try {
        rawResponse = await sendAndWaitForReply(currentMessage, sessionKey);
      } catch (err) {
        logErr('openclaw', 'Email query failed', err);
        rawResponse = buildErrorMessage(err);
        try {
          if (sharedMailbox) {
            await replyToSharedEmail(sharedMailbox, messageId, markdownToEmailHtml(rawResponse));
          } else {
            await replyToEmail(messageId, markdownToEmailHtml(rawResponse));
          }
        } catch (_) { /* best-effort */ }
        break;
      }

      const { text: afterFiles, files } = parseFileBlocks(rawResponse);
      const { text: cleanText, toolCalls } = parseToolBlocks(afterFiles);

      log('email', `Reply to ${sender} (turn ${iteration}): "${cleanText.slice(0, 120)}${cleanText.length > 120 ? '…' : ''}"` +
        `${toolCalls.length ? ` (${toolCalls.length} tool call(s))` : ''}`);

      // No tool calls → final reply, send email and break
      if (toolCalls.length === 0) {
        try {
          if (sharedMailbox) {
            await replyToSharedEmail(sharedMailbox, messageId, markdownToEmailHtml(cleanText));
            log('email', `Replied via ${sharedMailbox} to ${sender}: ${subject}`);
          } else {
            await replyToEmail(messageId, markdownToEmailHtml(cleanText));
            log('email', `Replied to email from ${sender}: ${subject}`);
          }
        } catch (sendErr) {
          logErr('email', `Failed to reply to email from ${sender}`, sendErr);
        }
        break;
      }

      // Execute tool calls, send results back to agent
      const results = await Promise.all(toolCalls.map(tc => executeTool(tc)));
      currentMessage = formatToolResults(results);
      log('tools', `Email: sent ${results.length} tool result(s) back to agent`);
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      logErr('tools', `Email tool loop hit max iterations`, new Error('max iterations'));
    }
  } finally {
    await releasePresence();
  }
}

let emailPollRunning = false;

async function pollEmail() {
  if (EMAIL_MODE !== 'full') return;
  if (emailPollRunning) {
    log('email', 'Previous email poll still running — skipping');
    return;
  }
  emailPollRunning = true;

  try {
    const unread = await getUnreadEmails(25);
    if (unread.length === 0) { emailPollRunning = false; return; }

    log('email', `${unread.length} unread email(s)`);

    for (const emailMsg of unread) {
      // Mark as read immediately to prevent re-processing
      try { await markAsRead(emailMsg.id); } catch (_) { /* best-effort */ }

      const conversationId = emailMsg.conversationId || emailMsg.id;
      enqueueEmail(conversationId, emailMsg);
    }
  } catch (err) {
    logErr('email', 'Email poll failed', err);
  } finally {
    emailPollRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Shared mailbox polling
// ---------------------------------------------------------------------------

let sharedMailboxPollRunning = false;

async function pollSharedMailboxes() {
  if (EMAIL_MODE === 'off') return;
  if (sharedMailboxPollRunning) return;
  sharedMailboxPollRunning = true;

  const mailboxes = loadMailboxes();
  const addresses = Object.keys(mailboxes);

  if (addresses.length === 0) {
    sharedMailboxPollRunning = false;
    return;
  }

  for (const address of addresses) {
    try {
      const unread = await getSharedMailboxEmails(address, 25);

      if (unread.length > 0) {
        log('email', `${unread.length} unread in shared mailbox ${address}`);
      }

      for (const emailMsg of unread) {
        try { await markSharedAsRead(address, emailMsg.id); } catch (_) { /* best-effort */ }

        // Only dispatch for processing/reply in full mode
        if (EMAIL_MODE === 'full') {
          emailMsg._sharedMailbox = address;
          const conversationId = emailMsg.conversationId || emailMsg.id;
          enqueueEmail(`shared:${address}:${conversationId}`, emailMsg);
        }
      }

      updateLastPolled(address);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 || status === 401) {
        // Access revoked — auto-remove and notify manager
        log('email', `Lost access to shared mailbox ${address} (${status}) — removing`);
        await removeMailbox({ address, reason: `access denied (HTTP ${status})` });

        if (CHANNEL_MANAGER) {
          // Find manager's chat to send notification
          try {
            const chats = await getChats();
            for (const chat of chats) {
              const messages = await getMessagesSince(chat.id, null);
              if (messages.length > 0) {
                const lastSender = messages[0].from?.user?.userPrincipalName?.toLowerCase();
                if (lastSender === CHANNEL_MANAGER) {
                  await sendMessage(chat.id,
                    `**Shared mailbox access lost:** I can no longer access \`${address}\`. It has been removed from my mailbox list. If this is unexpected, please check Exchange permissions.`
                  ).catch(() => {});
                  break;
                }
              }
            }
          } catch (_) { /* best-effort notification */ }
        }
      } else {
        logErr('email', `Failed to poll shared mailbox ${address}`, err);
      }
    }
  }

  sharedMailboxPollRunning = false;
}

// ---------------------------------------------------------------------------
// Channel manager DM commands
// ---------------------------------------------------------------------------

async function handleManagerCommand(chatId, text) {
  const cmd = parseManagerCommand(text);
  if (!cmd) return;

  if (cmd.command === 'list') {
    try { await getCachedTeams(); } catch (_) { /* use cached */ }
    const reply = formatTeamList(channelModes, knownTeams);
    await sendMessage(chatId, reply).catch(() => {});
    log('channels', 'Manager requested team list');
    return;
  }

  if (cmd.command === 'set') {
    try { await getCachedTeams(); } catch (_) { /* use cached */ }
    const team = findTeamByName(knownTeams, cmd.teamName);
    if (!team) {
      await sendMessage(chatId, `Team "${cmd.teamName}" not found. Send "teams" to see the list.`).catch(() => {});
      return;
    }
    setMode(channelModes, team.id, cmd.mode, team.displayName, CHANNEL_MANAGER);
    await sendMessage(chatId, `**${team.displayName}** is now in **${cmd.mode}** mode.`).catch(() => {});
    log('channels', `Manager set ${team.displayName} to ${cmd.mode}`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Channel polling (managed and open modes only)
// ---------------------------------------------------------------------------

function enqueueChannelMessage(queueKey, msg, meta) {
  if (!channelQueues.has(queueKey)) channelQueues.set(queueKey, { queue: [], processing: false });
  channelQueues.get(queueKey).queue.push({ msg, ...meta });
  if (!channelQueues.get(queueKey).processing) drainChannelQueue(queueKey);
}

async function drainChannelQueue(queueKey) {
  const q = channelQueues.get(queueKey);
  q.processing = true;
  while (q.queue.length > 0) {
    const item = q.queue.shift();
    await dispatchChannelMessage(item);
  }
  q.processing = false;
}

async function dispatchChannelMessage({ msg, teamId, teamName, channelId, channelName, threadId: parentThreadId }) {
  const text     = extractPlainText(msg.body);
  const sender   = msg.from?.user?.displayName || msg.from?.user?.userPrincipalName || 'unknown';
  const senderId = msg.from?.user?.id || null;
  const threadId = parentThreadId || msg.id; // use parent thread for replies, msg.id for top-level

  // Build mention for reply notifications
  const senderMention = senderId ? [{ userId: senderId, name: sender }] : [];

  log('channels', `${teamName} #${channelName} | from: ${sender} | "${text.slice(0, 80)}"`);

  // Build context header
  const contextPrefix = `[Channel: Microsoft Teams | Team: ${teamName} | Channel: ${channelName} | From: ${sender} | Thread: ${threadId}]\n`;

  // Handle attachments
  let attachmentContext = '';
  const tempFiles = [];
  const attachments = extractAttachments(msg);

  if (attachments.length > 0) {
    for (const att of attachments) {
      if (att.contentUrl) {
        const downloaded = await downloadAttachment(att.contentUrl, att.name);
        if (downloaded) {
          const ext     = att.contentType?.includes('image') ? '.jpg' : path.extname(att.name) || '.bin';
          const tmpPath = path.join(os.tmpdir(), `teams-ch-${crypto.randomBytes(8).toString('hex')}${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(downloaded.data, 'base64'));
          tempFiles.push(tmpPath);
          const sizeKB = Math.round(fs.statSync(tmpPath).size / 1024);
          attachmentContext += `\n[File: ${att.name} | ${att.contentType} | ${sizeKB}KB | ${tmpPath}]`;
        }
      }
    }
  }

  const messageWithContext = contextPrefix + (text || '[File shared]') + attachmentContext;

  // Ack threshold — reply in-thread with @mention so sender gets notified
  const ackTimer = setTimeout(async () => {
    try { await replyToChannelMessage(teamId, channelId, threadId, randomAck(), senderMention); } catch (_) { /* best-effort */ }
  }, ACK_THRESHOLD_MS);

  await acquirePresence();

  const sessionKey = buildSessionKey('teams', `${channelId}_${threadId}`);
  let currentMessage = messageWithContext;
  let iteration = 0;

  try {
    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;
      let rawResponse;

      try {
        rawResponse = await sendAndWaitForReply(currentMessage, sessionKey);
      } catch (err) {
        clearTimeout(ackTimer);
        logErr('openclaw', 'Channel query failed', err);
        try {
          await replyToChannelMessage(teamId, channelId, threadId, buildErrorMessage(err), senderMention);
        } catch (_) { /* best-effort */ }
        break;
      }

      if (iteration === 1) clearTimeout(ackTimer);

      const { text: afterFiles, files } = parseFileBlocks(rawResponse);
      const { text: cleanText, toolCalls } = parseToolBlocks(afterFiles);

      log('openclaw', `Channel reply (turn ${iteration}): "${cleanText.slice(0, 80)}"` +
        `${files.length ? ` (${files.length} file(s))` : ''}` +
        `${toolCalls.length ? ` (${toolCalls.length} tool call(s))` : ''}`);

      // Execute file blocks immediately
      for (const f of files) {
        try {
          if (f.path) {
            const ok = await sendChannelFile(teamId, channelId, f.path, f.name);
            log('channels', ok ? `Sent file "${f.name}"` : `Failed to send file "${f.name}"`);
          } else if (f.url) {
            const id = Buffer.from(f.url).toString('base64').slice(0, 64);
            await graphRequest('POST', `/teams/${teamId}/channels/${channelId}/messages`, {
              body: { contentType: 'html', content: `<attachment id="${id}"></attachment>` },
              attachments: [{ id, contentType: 'reference', contentUrl: f.url, name: f.name }],
            });
            log('channels', `Shared link "${f.name}"`);
          }
        } catch (fileErr) {
          logErr('channels', `Failed to send file "${f.name}"`, fileErr);
        }
      }

      // No tool calls → final reply with @mention
      if (toolCalls.length === 0) {
        try {
          if (cleanText.trim()) {
            await replyToChannelMessage(teamId, channelId, threadId, cleanText, senderMention);
            log('channels', `Replied in-thread in ${teamName} #${channelName} (@${sender})`);
          }
        } catch (sendErr) {
          logErr('channels', `Failed to reply in ${teamName} #${channelName}`, sendErr);
        }
        break;
      }

      // Execute tool calls in parallel
      const results = await Promise.all(toolCalls.map(tc => executeTool(tc)));
      currentMessage = formatToolResults(results);
      log('tools', `Channel: sent ${results.length} tool result(s) back to agent`);
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      logErr('tools', `Channel tool loop hit max iterations`, new Error('max iterations'));
      try {
        await replyToChannelMessage(teamId, channelId, threadId, 'I got stuck in a loop. Please try rephrasing.');
      } catch (_) { /* best-effort */ }
    }
    // Register thread as active — bot has replied, track for follow-up replies
    const threadKey = `${teamId}:${channelId}:${threadId}`;
    activeThreads.set(threadKey, {
      lastReplyTime: new Date().toISOString(),
      lastActivity: Date.now(),
    });
    log('channels', `Thread tracked: ${teamName} #${channelName} thread ${threadId.slice(0, 12)}...`);
  } finally {
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    }
    await releasePresence();
  }
}

async function pollChannels() {
  if (channelPollRunning) {
    log('channels', 'Previous channel poll still running - skipping');
    return;
  }
  channelPollRunning = true;

  try {
    const currentTeams = await getCachedTeams();
    const { added, removed } = detectTeamChanges(currentTeams, channelModes);

    // Handle new teams
    for (const team of added) {
      setMode(channelModes, team.id, 'monitor', team.displayName, 'system');
      log('channels', `New team detected: ${team.displayName} - set to monitor`);

      if (CHANNEL_MANAGER) {
        await notifyManagerOfNewTeam(team.displayName);
      }
    }

    // Handle removed teams
    for (const team of removed) {
      delete channelModes[team.id];
      saveModes(channelModes);
      log('channels', `Removed from team: ${team.name}`);

      if (CHANNEL_MANAGER) {
        await notifyManagerOfRemovedTeam(team.name);
      }
    }

    knownTeams = currentTeams;

    // Prune idle threads (no activity for THREAD_IDLE_MS)
    const now = Date.now();
    for (const [key, thread] of activeThreads) {
      if (now - thread.lastActivity > THREAD_IDLE_MS) {
        activeThreads.delete(key);
        log('channels', `Thread pruned (idle ${THREAD_IDLE_MS / 60_000}m): ${key.slice(0, 40)}...`);
      }
    }

    // Poll channels for managed and open teams only
    for (const team of currentTeams) {
      const mode = getMode(channelModes, team.id);
      if (mode === 'monitor') continue;

      try {
        const channels = await getCachedChannels(team.id);

        for (const channel of channels) {
          const cursorKey = `${team.id}:${channel.id}`;

          // Seed cursor on first encounter
          if (!channelLastSeen.has(cursorKey)) {
            const recent = await getChannelMessages(team.id, channel.id, null);
            channelLastSeen.set(cursorKey, recent.length > 0 ? recent[0].createdDateTime : new Date().toISOString());
            log('channels', `Seeded cursor for ${team.displayName} #${channel.displayName}`);
            continue;
          }

          // Check if this channel has any active threads — only use $expand=replies if needed
          const threadPrefix = `${team.id}:${channel.id}:`;
          let hasActiveThreads = false;
          for (const k of activeThreads.keys()) {
            if (k.startsWith(threadPrefix)) { hasActiveThreads = true; break; }
          }
          const threads = hasActiveThreads
            ? await getChannelMessagesWithReplies(team.id, channel.id, 20)
            : await getChannelMessages(team.id, channel.id, channelLastSeen.get(cursorKey));
          const sinceIso = channelLastSeen.get(cursorKey);

          for (const msg of threads) {
            // ── New top-level messages: require @mention ──────────────
            if (msg.createdDateTime > sinceIso) {
              channelLastSeen.set(cursorKey, msg.createdDateTime);

              const senderId = msg.from?.user?.id || msg.from?.application?.id;
              if (BOT_USER_ID && senderId === BOT_USER_ID) continue;
              if (msg.messageType !== 'message') continue;

              const mentionsBot = (msg.mentions || []).some(m => m.mentioned?.user?.id === BOT_USER_ID);
              if (!mentionsBot) continue;

              if (mode === 'managed') {
                const senderOid = (msg.from?.user?.id || '').toLowerCase();
                const senderUpn = (msg.from?.user?.userPrincipalName || '').toLowerCase();
                const isAllowed = ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(senderUpn) || ALLOWED_USERS.includes(senderOid);
                if (!isAllowed) {
                  log('channels', `Ignored @mention from unauthorized user in ${team.displayName} #${channel.displayName}`);
                  continue;
                }
              }

              log('channels', `New @mention in ${team.displayName} #${channel.displayName} from ${msg.from?.user?.displayName || 'unknown'}`);
              enqueueChannelMessage(`${channel.id}:${msg.id}`, msg, {
                teamId: team.id, teamName: team.displayName,
                channelId: channel.id, channelName: channel.displayName,
              });
              continue;
            }

            // ── Thread replies: no @mention needed if bot is in the thread ──
            const threadKey = `${team.id}:${channel.id}:${msg.id}`;
            const tracked = activeThreads.get(threadKey);
            if (!tracked) continue;

            const replies = msg.replies || [];
            const lastReplyIso = tracked.lastReplyTime;

            for (const reply of replies) {
              if (reply.createdDateTime <= lastReplyIso) continue;

              const replySenderId = reply.from?.user?.id || reply.from?.application?.id;
              if (BOT_USER_ID && replySenderId === BOT_USER_ID) continue;
              if (reply.messageType !== 'message') continue;

              if (mode === 'managed') {
                const replyOid = (reply.from?.user?.id || '').toLowerCase();
                const replyUpn = (reply.from?.user?.userPrincipalName || '').toLowerCase();
                const isAllowed = ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(replyUpn) || ALLOWED_USERS.includes(replyOid);
                if (!isAllowed) continue;
              }

              log('channels', `Thread reply in ${team.displayName} #${channel.displayName} from ${reply.from?.user?.displayName || 'unknown'}`);

              // Update tracking
              activeThreads.set(threadKey, {
                lastReplyTime: reply.createdDateTime,
                lastActivity: Date.now(),
              });

              // Dispatch as channel message with the parent thread ID for in-thread reply
              enqueueChannelMessage(`${channel.id}:${msg.id}:${reply.id}`, reply, {
                teamId: team.id, teamName: team.displayName,
                channelId: channel.id, channelName: channel.displayName,
                threadId: msg.id, // parent thread — bot replies to this thread
              });
            }
          }
        }
      } catch (err) {
        logErr('channels', `Error polling channels for ${team.displayName}`, err);
      }
    }
  } catch (err) {
    logErr('channels', 'Channel poll failed', err);
  } finally {
    channelPollRunning = false;
  }
}

// Manager notifications for team membership changes

async function notifyManagerOfNewTeam(teamName) {
  log('channels', `Notification: added to "${teamName}" (monitor mode)`);

  // Email notification if enabled
  if (EMAIL_MODE === 'full') {
    try {
      const { sendEmail } = require('./lib/email');
      await sendEmail(
        CHANNEL_MANAGER,
        `Agent Bridge: Added to ${teamName}`,
        `<p>I was added to <strong>${teamName}</strong>. I'm in <strong>monitor</strong> mode (read-only, no posting).</p><p>To change the mode, DM me: <code>set ${teamName} open</code> or <code>set ${teamName} managed</code></p>`
      );
      log('channels', `Emailed manager about new team: ${teamName}`);
    } catch (_) { /* email is best-effort */ }
  }
}

async function notifyManagerOfRemovedTeam(teamName) {
  log('channels', `Notification: removed from "${teamName}"`);
  if (EMAIL_MODE === 'full') {
    try {
      const { sendEmail } = require('./lib/email');
      if (typeof sendEmail === 'function') {
        await sendEmail(
          CHANNEL_MANAGER,
          `Agent Bridge: Removed from ${teamName}`,
          `<p>I was removed from <strong>${teamName}</strong>.</p>`
        );
      }
    } catch (_) { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  // Write PID file for stop.ps1
  const pidPath = path.join(process.cwd(), 'bridge.pid');
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');

  console.log();
  printLogo();
  console.log();
  printDivider();
  printTagline();
  printDivider();
  console.log();
  logStartup('bridge', `  Log level     : ${LOG_LEVEL}`);
  logStartup('bridge', `  Bot user ID   : ${BOT_USER_ID || '(not set)'}`);
  logStartup('bridge', `  Openclaw URL  : ${process.env.OPENCLAW_URL}`);
  logStartup('bridge', `  DM poll       : ${POLL_INTERVAL_MS} ms`);
  logStartup('bridge', `  Channel poll  : ${CHANNEL_POLL_INTERVAL_MS} ms`);
  logStartup('bridge', `  Channel mgr   : ${CHANNEL_MANAGER || '(not set)'}`);
  logStartup('bridge', `  Email mode    : ${EMAIL_MODE}`);
  if (EMAIL_MODE !== 'off') {
    logStartup('bridge', `  Email poll    : ${EMAIL_POLL_INTERVAL_MS} ms`);
    logStartup('bridge', `  Email whitelist: ${process.env.EMAIL_WHITELIST || '(none)'}`);
    const sharedAddrs = Object.keys(loadMailboxes());
    if (sharedAddrs.length > 0) {
      logStartup('bridge', `  Shared mboxes : ${sharedAddrs.length} (${sharedAddrs.join(', ')})`);
    }
  }
  const toolNames = getToolNames();
  logStartup('bridge', `  Bridge tools  : ${toolNames.length} registered (${toolNames.join(', ')})`);
  console.log();
  printFooter();
  console.log();

  // Force token refresh on startup to pick up any new scopes
  try { await forceRefresh(); } catch (e) { log('bridge', `Token refresh: ${e.message}`); }

  // Set presence to Available on startup
  await setPresence('Available', 'Available', 60);

  // First poll immediately, then on interval
  await poll();
  const timer = setInterval(poll, POLL_INTERVAL_MS);

  // Start channel polling
  log('channels', 'Starting channel poll loop');
  await pollChannels();
  const channelTimer = setInterval(pollChannels, CHANNEL_POLL_INTERVAL_MS);

  // Start email polling if enabled
  let emailTimer = null;
  let sharedMailboxTimer = null;
  if (EMAIL_MODE === 'full') {
    log('email', 'Email polling enabled (full mode) - starting poll loop');
    await pollEmail();
    emailTimer = setInterval(pollEmail, EMAIL_POLL_INTERVAL_MS);
  } else if (EMAIL_MODE === 'read') {
    log('email', 'Email read mode enabled - mailbox functions available, no auto-polling');
  }

  // Start shared mailbox polling (runs alongside email polling if email mode is read or full)
  if (EMAIL_MODE !== 'off') {
    const sharedCount = Object.keys(loadMailboxes()).length;
    if (sharedCount > 0) {
      log('email', `Shared mailbox polling enabled - ${sharedCount} mailbox(es) configured`);
    }
    await pollSharedMailboxes();
    sharedMailboxTimer = setInterval(pollSharedMailboxes, EMAIL_POLL_INTERVAL_MS);
  }

  // Graceful shutdown
  const shutdown = (signal) => {
    log('bridge', `Received ${signal} - shutting down`);
    clearInterval(timer);
    clearInterval(channelTimer);
    if (emailTimer) clearInterval(emailTimer);
    if (sharedMailboxTimer) clearInterval(sharedMailboxTimer);
    try { fs.unlinkSync(pidPath); } catch (_) { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] [bridge] FATAL:`, err.message || err);
  process.exit(1);
});
