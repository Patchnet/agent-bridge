'use strict';

/**
 * graph.js — Shared Microsoft Graph API request helper.
 *
 * Authenticated via delegated tokens from auth.js.
 * Auto-retries once on 401 (token may have been revoked mid-session).
 */

const axios = require('axios');
const { getAccessToken, forceRefresh } = require('./auth');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Make an authenticated Graph API request.
 * Automatically retries once after a 401 by forcing a token refresh.
 *
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} endpoint  — path relative to GRAPH_BASE, e.g. '/me/chats'
 * @param {object|null} body — JSON body for POST/PATCH/PUT
 * @returns {Promise<object>}
 */
async function graphRequest(method, endpoint, body = null) {
  const execute = async (token) => {
    const cfg = {
      method,
      url: `${GRAPH_BASE}${endpoint}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ConsistencyLevel: 'eventual',
      },
      timeout: 20_000,
    };
    if (body !== null) cfg.data = body;
    const resp = await axios(cfg);
    return resp.data;
  };

  try {
    return await execute(await getAccessToken());
  } catch (err) {
    const status = err.response?.status;

    if (status === 401) {
      return execute(await forceRefresh());
    }

    // Throttled — honor Retry-After with jitter
    if (status === 429) {
      const retryAfter = parseInt(err.response.headers?.['retry-after'], 10) || 10;
      const jitter = Math.random() * 2;
      const delay = retryAfter + jitter;
      console.warn(`[${new Date().toISOString()}] [graph] Throttled (429) — retrying after ${delay.toFixed(1)}s`);
      await new Promise(r => setTimeout(r, delay * 1000));
      return execute(await getAccessToken());
    }

    // Transient server errors — retry once with backoff + jitter
    if (status >= 500 && status < 600) {
      const delay = 3 + Math.random() * 2;
      console.warn(`[${new Date().toISOString()}] [graph] Server error (${status}) — retrying after ${delay.toFixed(1)}s`);
      await new Promise(r => setTimeout(r, delay * 1000));
      return execute(await getAccessToken());
    }

    throw err;
  }
}

module.exports = { graphRequest, GRAPH_BASE };
