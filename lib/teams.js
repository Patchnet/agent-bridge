'use strict';

/**
 * teams.js — Microsoft Graph API helpers for Teams chat messaging.
 *
 * Delegated (user-context) calls using the token from auth.js.
 * All calls target the signed-in bot account configured in .env.
 */

const axios = require('axios');
const { getAccessToken } = require('./auth');
const { graphRequest, GRAPH_BASE } = require('./graph');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and decode basic entities from a Teams message body.
 * Teams wraps even plain text in <p> tags when contentType is 'html'.
 */
function extractPlainText(body) {
  if (!body || !body.content) return '';
  let text = body.content;
  if (body.contentType === 'html' || /<[a-z]/i.test(text)) {
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all chats for the bot account (oneOnOne DMs and group chats).
 * Filters to oneOnOne chats only — adjust chatType filter below if needed.
 *
 * @returns {Promise<Array>}
 */
async function getChats() {
  // $filter on chatType requires ConsistencyLevel: eventual (set in graphRequest)
  const result = await graphRequest(
    'GET',
    '/me/chats?$top=50',
  );
  return result.value || [];
}

/**
 * Fetch messages in a chat newer than `sinceIso` (ISO 8601 string).
 * If sinceIso is null, fetches only the single most-recent message
 * (used on startup to initialise the last-seen cursor).
 *
 * @param {string} chatId
 * @param {string|null} sinceIso  — ISO timestamp, e.g. '2024-01-01T00:00:00Z'
 * @returns {Promise<Array>}
 */
async function getMessagesSince(chatId, sinceIso) {
  // Graph chat messages API does not support $filter or $orderby on createdDateTime.
  // Fetch newest 50, filter client-side by cursor timestamp.
  const result = await graphRequest('GET', `/me/chats/${chatId}/messages?$top=50`);
  const msgs = result.value || [];

  if (!sinceIso) {
    return msgs.slice(0, 1);
  }

  const since = new Date(sinceIso);
  return msgs
    .filter((m) => new Date(m.createdDateTime) > since)
    .sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
}

/**
 * Convert markdown to HTML for Teams rendering via Graph API.
 *
 * Approach: line-by-line parser to avoid regex fragmentation issues.
 * Order: structure (headers, lists, tables, code blocks) → then inline formatting last.
 *
 * Known Teams constraints applied:
 * - Outer wrapper: <div> not <p> (Graph API examples use div)
 * - Links: <a href="..."> required for clickable hyperlinks
 * - Lists: must be wrapped in <ul>/<ol> with proper <li> items
 * - Code blocks: <codeblock class=""><code>...</code></codeblock> (Teams native)
 * - Inline code + codeblock in same message causes MS bug — tracked below
 * - Tables: <thead>/<tbody> with <th>/<td> distinction
 * - No <hr/> support in Teams (omitted)
 */
function markdownToHtml(text) {
  const lines = text.split('\n');
  const output = [];
  let i = 0;
  let hasInlineCode = false;
  let hasCodeBlock = false;

  // First pass: detect inline code and fenced code blocks to avoid MS bug
  for (const line of lines) {
    if (/^```/.test(line)) hasCodeBlock = true;
    if (/`[^`]+`/.test(line)) hasInlineCode = true;
  }

  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code blocks ---
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim() || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing ```
      // Use codeblock only if no inline code in the message (avoid MS bug)
      if (!hasInlineCode) {
        output.push(`<codeblock class="${escapeHtml(lang)}"><code>${codeLines.join('<br/>')}</code></codeblock>`);
      } else {
        output.push(`<div><code>${codeLines.join('<br/>')}</code></div>`);
      }
      continue;
    }

    // --- Headers ---
    if (/^### (.+)$/.test(line)) {
      output.push(`<h3>${applyInline(line.replace(/^### /, ''))}</h3>`);
      i++; continue;
    }
    if (/^## (.+)$/.test(line)) {
      output.push(`<h2>${applyInline(line.replace(/^## /, ''))}</h2>`);
      i++; continue;
    }
    if (/^# (.+)$/.test(line)) {
      output.push(`<h1>${applyInline(line.replace(/^# /, ''))}</h1>`);
      i++; continue;
    }

    // --- Horizontal rule (omit — not supported in Teams) ---
    if (/^---+$/.test(line)) {
      i++; continue;
    }

    // --- Table ---
    if (/^\|.+\|$/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      output.push(buildTable(tableLines));
      continue;
    }

    // --- Unordered list ---
    if (/^[\-\*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[\-\*] /.test(lines[i])) {
        items.push(`<li>${applyInline(lines[i].replace(/^[\-\*] /, ''))}</li>`);
        i++;
      }
      output.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // --- Ordered list ---
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${applyInline(lines[i].replace(/^\d+\. /, ''))}</li>`);
        i++;
      }
      output.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // --- Blank line (paragraph break) ---
    if (line.trim() === '') {
      output.push('<br/>');
      i++; continue;
    }

    // --- Regular paragraph line ---
    output.push(`<div>${applyInline(line)}</div>`);
    i++;
  }

  return `<div>${output.join('')}</div>`;
}

/** Escape HTML special characters */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Apply inline formatting: links, bold, italic, inline code.
 * Escapes HTML first, then applies formatting in safe order.
 * Inline code is applied last to prevent formatting inside code spans.
 */
function applyInline(text) {
  // Escape HTML
  let out = escapeHtml(text);

  // Protect inline code spans first (replace with placeholders)
  const codePlaceholders = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${code}</code>`); // already escaped via escapeHtml above
    return `\x00CODE${idx}\x00`;
  });

  // Hyperlinks [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold + italic
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
  out = out.replace(/_(.+?)_/g, '<em>$1</em>');

  // Restore inline code placeholders
  out = out.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codePlaceholders[parseInt(idx)]);

  return out;
}

/** Build an HTML table from markdown table lines */
function buildTable(lines) {
  // Filter out separator rows (e.g. |---|---|)
  const dataLines = lines.filter(l => !/^\|[\s\-:|]+\|$/.test(l));
  if (dataLines.length === 0) return '';

  const rows = dataLines.map(l =>
    l.split('|').slice(1, -1).map(c => c.trim())
  );

  const header = rows[0];
  const body = rows.slice(1);

  const thead = `<thead><tr>${header.map(c => `<th>${applyInline(c)}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${applyInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';

  return `<table>${thead}${tbody}</table>`;
}

/**
 * Post a reply message to a Teams chat.
 * Converts markdown to HTML for clean rendering in Teams desktop/mobile.
 *
 * @param {string} chatId
 * @param {string} text  — markdown content
 * @returns {Promise<string>} — the Graph messageId of the posted message
 */
async function sendMessage(chatId, text) {
  const result = await graphRequest('POST', `/me/chats/${chatId}/messages`, {
    body: {
      contentType: 'html',
      content: markdownToHtml(text),
    },
  });
  return result.id;
}

/**
 * Edit an existing message in a Teams chat (PATCH).
 * Used for edit-in-place ack — replace "Working on it..." with the full reply.
 *
 * @param {string} chatId
 * @param {string} messageId — the Graph messageId to edit
 * @param {string} text — markdown content (converted to HTML)
 */
async function editMessage(chatId, messageId, text) {
  await graphRequest('PATCH', `/me/chats/${chatId}/messages/${messageId}`, {
    body: {
      contentType: 'html',
      content: markdownToHtml(text),
    },
  });
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Set the bot account's Teams presence via setUserPreferredPresence.
 * This sets the user-level preferred status (no sessionId required)
 * and supports Busy/Busy, Available/Available directly.
 * @param {'Available'|'Busy'|'Away'|'DoNotDisturb'} availability
 * @param {string} activity  e.g. 'Available', 'Busy', 'Away', 'DoNotDisturb'
 * @param {number} expirationDurationMinutes  how long before it auto-expires
 */
async function setPresence(availability, activity, expirationDurationMinutes = 60) {
  try {
    const userId = process.env.BOT_USER_ID;
    await graphRequest('POST', `/users/${userId}/presence/setUserPreferredPresence`, {
      availability,
      activity,
      expirationDuration: `PT${expirationDurationMinutes}M`,
    });
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] [presence] Failed to set presence: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// File attachments
// ---------------------------------------------------------------------------

// Allowed hostnames for file downloads — prevents SSRF
const ALLOWED_DOWNLOAD_HOSTS = [
  'graph.microsoft.com',
  '.sharepoint.com',
  '.1drv.ms',
];

function isMicrosoftHost(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return ALLOWED_DOWNLOAD_HOSTS.some(h =>
      h.startsWith('.') ? hostname.endsWith(h) : hostname === h
    );
  } catch { return false; }
}

/**
 * Extract file attachments from a Teams message.
 * Handles both explicit attachments array AND inline images in HTML body.
 * Returns array of { name, contentUrl, contentType } objects.
 */
function extractAttachments(msg) {
  const results = [];

  // Standard attachments array (files, cards)
  const attachments = msg.attachments || [];
  for (const a of attachments) {
    if (!a.contentType || a.contentType === 'messageReference') continue;
    if (a.contentUrl) {
      results.push({
        name:        a.name || 'attachment',
        contentUrl:  a.contentUrl,
        contentType: a.contentType,
        id:          a.id,
      });
    }
  }

  // Inline images embedded in HTML body (Teams sends images this way)
  const body = msg.body?.content || '';
  if (msg.body?.contentType === 'html') {
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    let match;
    let idx = 0;
    while ((match = imgRegex.exec(body)) !== null) {
      const src = match[1];
      // Only download from verified Microsoft domains (strict hostname check)
      if (isMicrosoftHost(src)) {
        results.push({
          name:        `image-${++idx}.jpg`,
          contentUrl:  src,
          contentType: 'image/jpeg',
          id:          null,
        });
      }
    }
  }

  return results;
}

/**
 * Download a file attachment from Teams via Graph API.
 * Uses SharePoint site search to find the file by name and get a download URL.
 * Returns base64-encoded content and mimeType.
 */
async function downloadAttachment(contentUrl, fileName) {
  try {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };

    // Extract the SharePoint hostname and personal site path from the contentUrl
    // e.g. https://<tenant>-my.sharepoint.com/personal/<user>/...
    let downloadUrl = null;

    if (contentUrl && contentUrl.includes('sharepoint.com')) {
      const match = contentUrl.match(/https:\/\/([^/]+)(\/personal\/[^/]+)/);
      if (match) {
        const host     = match[1];
        const sitePath = match[2];

        // Get site ID
        const siteResp = await axios.get(
          `https://graph.microsoft.com/v1.0/sites/${host}:${sitePath}`,
          { headers, timeout: 10_000 }
        ).catch(() => null);

        if (siteResp?.data?.id) {
          const siteId = siteResp.data.id;
          const name   = fileName || contentUrl.split('/').pop().split('?')[0];

          // Search for file by name
          const searchResp = await axios.get(
            `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root/search(q='${encodeURIComponent(name)}')`,
            { headers, timeout: 10_000 }
          ).catch(() => null);

          const item = (searchResp?.data?.value || [])[0];
          if (item?.id) {
            const itemResp = await axios.get(
              `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${item.id}`,
              { headers, timeout: 10_000 }
            ).catch(() => null);
            downloadUrl = itemResp?.data?.['@microsoft.graph.downloadUrl'];
          }
        }
      }
    }

    if (!downloadUrl) {
      // Fallback — only attempt if the URL is a verified Microsoft host
      if (!isMicrosoftHost(contentUrl)) {
        console.warn(`[${new Date().toISOString()}] [files] Blocked download from non-Microsoft host: ${contentUrl}`);
        return null;
      }
      downloadUrl = contentUrl;
    }

    // Only send bearer token to Microsoft domains; pre-signed URLs don't need it
    const useAuth = isMicrosoftHost(downloadUrl) && downloadUrl === contentUrl;
    const resp = await axios({
      method:       'GET',
      url:          downloadUrl,
      headers:      useAuth ? headers : {},
      responseType: 'arraybuffer',
      timeout:      30_000,
    });

    return {
      data:      Buffer.from(resp.data).toString('base64'),
      mimeType:  resp.headers['content-type'] || 'application/octet-stream',
      sizeBytes: resp.data.byteLength,
    };
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] [files] Download failed: ${err.message}`);
    return null;
  }
}

/**
 * Send a file to a Teams chat by uploading to OneDrive then sharing.
 * @param {string} chatId
 * @param {string} filePath  — local file path
 * @param {string} fileName  — display name in Teams
 */
async function sendFile(chatId, filePath, fileName) {
  try {
    const fs       = require('fs');
    const token    = await getAccessToken();
    const fileData = fs.readFileSync(filePath);

    // Upload to bot's OneDrive
    const uploadResp = await axios({
      method:  'PUT',
      url:     `https://graph.microsoft.com/v1.0/me/drive/root:/${fileName}:/content`,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      data:    fileData,
      timeout: 60_000,
    });

    const driveItemId = uploadResp.data.id;
    const webUrl      = uploadResp.data.webUrl;

    // Share as attachment in Teams chat
    await graphRequest('POST', `/me/chats/${chatId}/messages`, {
      body: {
        contentType: 'html',
        content:     `<attachment id="${driveItemId}"></attachment>`,
      },
      attachments: [{
        id:          driveItemId,
        contentType: 'reference',
        contentUrl:  webUrl,
        name:        fileName,
      }],
    });

    return true;
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] [files] Send file failed: ${err.message}`);
    return false;
  }
}

/**
 * Share an existing SharePoint/OneDrive URL as a reference attachment.
 * @param {string} chatId
 * @param {string} url       - HTTPS URL to the file
 * @param {string} fileName  - display name in Teams
 */
async function sendReferenceLink(chatId, url, fileName) {
  const id = Buffer.from(url).toString('base64').slice(0, 64);
  await graphRequest('POST', `/me/chats/${chatId}/messages`, {
    body: {
      contentType: 'html',
      content:     `<attachment id="${id}"></attachment>`,
    },
    attachments: [{
      id,
      contentType: 'reference',
      contentUrl:  url,
      name:        fileName,
    }],
  });
}

// Channel functions

async function getJoinedTeams() {
  const result = await graphRequest('GET', '/me/joinedTeams?$select=id,displayName,description');
  return result.value || [];
}

async function getChannels(teamId) {
  const result = await graphRequest('GET', `/teams/${teamId}/channels?$select=id,displayName,membershipType`);
  return (result.value || []).filter(ch => ch.membershipType === 'standard');
}

async function getChannelMessages(teamId, channelId, sinceIso) {
  if (!sinceIso) {
    const result = await graphRequest('GET', `/teams/${teamId}/channels/${channelId}/messages?$top=1`);
    return result.value || [];
  }

  // Channel messages API has limited $filter support — use $top=50 and filter client-side
  const result = await graphRequest('GET',
    `/teams/${teamId}/channels/${channelId}/messages?$top=50`
  );
  const msgs = result.value || [];
  const since = new Date(sinceIso);
  return msgs
    .filter((m) => new Date(m.createdDateTime) > since)
    .sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
}

/**
 * Fetch channel messages with replies expanded.
 * Sorted by last thread activity (threads with newest replies first).
 * Used by channel polling to detect both new top-level posts and thread replies.
 *
 * @param {string} teamId
 * @param {string} channelId
 * @param {number} top — number of threads to fetch (default 20)
 * @returns {Promise<Array>} — messages with replies[] arrays
 */
async function getChannelMessagesWithReplies(teamId, channelId, top = 20) {
  const result = await graphRequest('GET',
    `/teams/${teamId}/channels/${channelId}/messages?$top=${top}&$expand=replies`
  );
  return result.value || [];
}

async function sendChannelMessage(teamId, channelId, text, { importance, mentions } = {}) {
  let html = markdownToHtml(text);
  const mentionObjects = [];

  if (mentions && mentions.length > 0) {
    for (let i = 0; i < mentions.length; i++) {
      const m = mentions[i];
      mentionObjects.push({
        id: i,
        mentionText: m.name,
        mentioned: {
          user: { id: m.userId, displayName: m.name, userIdentityType: 'aadUser' },
        },
      });
      html = `<at id="${i}">${m.name}</at> ${html}`;
    }
  }

  const payload = {
    body: { contentType: 'html', content: html },
  };
  if (mentionObjects.length > 0) payload.mentions = mentionObjects;
  if (importance && ['high', 'urgent'].includes(importance)) payload.importance = importance;

  return graphRequest('POST', `/teams/${teamId}/channels/${channelId}/messages`, payload);
}

async function replyToChannelMessage(teamId, channelId, messageId, text, mentions = []) {
  let html = markdownToHtml(text);
  const mentionObjects = [];

  // Build @mention tags — Teams requires <at id="N">name</at> in HTML + mentions array
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    mentionObjects.push({
      id: i,
      mentionText: m.name,
      mentioned: {
        user: { id: m.userId, displayName: m.name, userIdentityType: 'aadUser' },
      },
    });
    // Prepend @mention to reply so the user gets a notification
    html = `<at id="${i}">${m.name}</at> ${html}`;
  }

  const body = {
    body: { contentType: 'html', content: html },
  };
  if (mentionObjects.length > 0) body.mentions = mentionObjects;

  return graphRequest('POST', `/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`, body);
}

async function setMessageReaction(teamId, channelId, messageId, reactionType) {
  await graphRequest('POST',
    `/teams/${teamId}/channels/${channelId}/messages/${messageId}/setReaction`,
    { reactionType }
  );
}

async function unsetMessageReaction(teamId, channelId, messageId, reactionType) {
  await graphRequest('POST',
    `/teams/${teamId}/channels/${channelId}/messages/${messageId}/unsetReaction`,
    { reactionType }
  );
}

async function sendChannelFile(teamId, channelId, filePath, fileName) {
  try {
    const fs    = require('fs');
    const token = await getAccessToken();
    const fileData = fs.readFileSync(filePath);

    const uploadResp = await axios({
      method:  'PUT',
      url:     `https://graph.microsoft.com/v1.0/me/drive/root:/${fileName}:/content`,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      data:    fileData,
      timeout: 60_000,
    });

    const driveItemId = uploadResp.data.id;
    const webUrl      = uploadResp.data.webUrl;

    await graphRequest('POST', `/teams/${teamId}/channels/${channelId}/messages`, {
      body: {
        contentType: 'html',
        content:     `<attachment id="${driveItemId}"></attachment>`,
      },
      attachments: [{
        id:          driveItemId,
        contentType: 'reference',
        contentUrl:  webUrl,
        name:        fileName,
      }],
    });

    return true;
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] [files] Send channel file failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bridge tool registrations (on-demand channel/team reads)
// ---------------------------------------------------------------------------

const { registerTool } = require('./tools');

registerTool('get_teams', {}, async () => {
  return getJoinedTeams();
});

registerTool('get_channels', {
  teamId: { type: 'string', required: true },
}, async ({ teamId }) => {
  return getChannels(teamId);
});

registerTool('get_channel_messages', {
  teamId:    { type: 'string', required: true },
  channelId: { type: 'string', required: true },
  top:       { type: 'number' },
}, async ({ teamId, channelId, top = 25 }) => {
  const result = await graphRequest('GET',
    `/teams/${teamId}/channels/${channelId}/messages?$top=${top}`
  );
  const msgs = result.value || [];
  return msgs.map(m => ({
    id: m.id,
    from: m.from?.user?.displayName || m.from?.application?.displayName || 'unknown',
    createdDateTime: m.createdDateTime,
    bodyPreview: m.body?.content ? extractPlainText(m.body).slice(0, 200) : '',
  }));
});

registerTool('send_channel_message', {
  teamId:     { type: 'string', required: true },
  channelId:  { type: 'string', required: true },
  message:    { type: 'string', required: true },
  importance: { type: 'string' },
  mentions:   { type: 'array' },
}, async ({ teamId, channelId, message, importance, mentions = [] }) => {
  const result = await sendChannelMessage(teamId, channelId, message, { importance, mentions });
  return { sent: true, messageId: result.id };
});

registerTool('react_to_message', {
  teamId:       { type: 'string', required: true },
  channelId:    { type: 'string', required: true },
  messageId:    { type: 'string', required: true },
  reactionType: { type: 'string', required: true },
}, async ({ teamId, channelId, messageId, reactionType }) => {
  await setMessageReaction(teamId, channelId, messageId, reactionType);
  return { reacted: true, messageId, reactionType };
});

registerTool('remove_reaction', {
  teamId:       { type: 'string', required: true },
  channelId:    { type: 'string', required: true },
  messageId:    { type: 'string', required: true },
  reactionType: { type: 'string', required: true },
}, async ({ teamId, channelId, messageId, reactionType }) => {
  await unsetMessageReaction(teamId, channelId, messageId, reactionType);
  return { removed: true, messageId, reactionType };
});

registerTool('reply_to_channel_message', {
  teamId:    { type: 'string', required: true },
  channelId: { type: 'string', required: true },
  messageId: { type: 'string', required: true },
  message:   { type: 'string', required: true },
  mentions:  { type: 'array' },
}, async ({ teamId, channelId, messageId, message, mentions = [] }) => {
  await replyToChannelMessage(teamId, channelId, messageId, message, mentions);
  return { replied: true, messageId };
});

module.exports = {
  getChats,
  getMessagesSince,
  sendMessage,
  editMessage,
  extractPlainText,
  extractAttachments,
  downloadAttachment,
  sendFile,
  sendReferenceLink,
  setPresence,
  markdownToHtml,
  getJoinedTeams,
  getChannels,
  getChannelMessages,
  getChannelMessagesWithReplies,
  sendChannelMessage,
  replyToChannelMessage,
  setMessageReaction,
  unsetMessageReaction,
  sendChannelFile,
};
