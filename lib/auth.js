'use strict';

/**
 * auth.js — Microsoft OAuth2 token management (delegated / user context).
 *
 * Uses a stored refresh_token to obtain short-lived access tokens.
 * Microsoft rotates refresh tokens on every use, so we write the new
 * refresh_token back to .env immediately after each refresh.
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const ENV_PATH = path.resolve(process.cwd(), '.env');

// In-memory cache
let _accessToken  = null;
let _tokenExpiry  = 0;        // epoch ms when the cached token becomes invalid
let _refreshInFlight = null;  // shared promise to deduplicate concurrent refreshes

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildTokenEndpoint() {
  return `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
}

const BASE_SCOPES = [
  // Core
  'User.Read',
  'offline_access',
  // Teams DMs
  'Chat.ReadWrite',
  // Presence
  'Presence.ReadWrite',
  'Presence.Read.All',
  // Teams channels
  'ChannelMessage.Read.All',
  'ChannelMessage.Send',
  'Channel.ReadBasic.All',
  'Team.ReadBasic.All',
  // Files / OneDrive / SharePoint
  'Files.ReadWrite',
  'Files.ReadWrite.All',
  'Sites.ReadWrite.All',
  // Calendar, tasks, people
  'Calendars.ReadWrite',
  'Calendars.ReadWrite.Shared',
  'Schedule.ReadWrite.All',
  'Contacts.ReadWrite',
  'People.Read',
  'Tasks.ReadWrite',
  'User.ReadBasic.All',
  'MailboxSettings.Read',
];

const EMAIL_MODE = (process.env.EMAIL_MODE || 'off').toLowerCase();
if (EMAIL_MODE === 'read') {
  BASE_SCOPES.push('Mail.ReadWrite');
} else if (EMAIL_MODE === 'full') {
  BASE_SCOPES.push('Mail.ReadWrite', 'Mail.Send');
}

const SCOPES = BASE_SCOPES.join(' ');

/**
 * Persist a single key=value line in the .env file.
 * Replaces an existing line or appends if not found.
 */
function writeEnvKey(key, value) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
  } catch (err) {
    console.warn(`[auth] Could not write ${key} to .env: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a valid access token, refreshing automatically when expired.
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) {
    return _accessToken;
  }
  return _refreshOnce();
}

/**
 * Force a token refresh regardless of cache state.
 * Useful after a 401 response from Graph.
 * @returns {Promise<string>}
 */
async function forceRefresh() {
  _accessToken = null;
  _tokenExpiry = 0;
  _refreshInFlight = null;
  return _refreshOnce();
}

/**
 * Deduplicates concurrent refresh calls — all callers share the same
 * in-flight promise so only one token request hits Azure at a time.
 */
function _refreshOnce() {
  if (!_refreshInFlight) {
    _refreshInFlight = _doRefresh().finally(() => { _refreshInFlight = null; });
  }
  return _refreshInFlight;
}

async function _doRefresh() {
  const params = new URLSearchParams({
    client_id:     process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    refresh_token: process.env.REFRESH_TOKEN,
    grant_type:    'refresh_token',
    scope:         SCOPES,
  });

  let data;
  try {
    const resp = await axios.post(buildTokenEndpoint(), params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    });
    data = resp.data;
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    throw new Error(`[auth] Token refresh failed: ${detail}`);
  }

  const { access_token, refresh_token, expires_in } = data;

  // Cache the new access token (expire 90 s early for safety)
  _accessToken = access_token;
  _tokenExpiry  = Date.now() + Math.max(0, (expires_in - 90)) * 1000;

  // Microsoft rotates refresh tokens — persist the new one immediately
  if (refresh_token && refresh_token !== process.env.REFRESH_TOKEN) {
    process.env.REFRESH_TOKEN = refresh_token;
    writeEnvKey('REFRESH_TOKEN', refresh_token);
    console.log(`[${new Date().toISOString()}] [auth] Refresh token rotated — saved to .env`);
  }

  return _accessToken;
}

module.exports = { getAccessToken, forceRefresh };
