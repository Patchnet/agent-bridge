'use strict';

/**
 * people.js — People and directory bridge tools.
 *
 * Discrete, validated operations for user lookup, org directory search,
 * and mailbox settings via Microsoft Graph.
 */

const { graphRequest } = require('./graph');
const { registerTool } = require('./tools');

// ── Tool implementations ────────────────────────────────────────────────

/**
 * Search org directory by name, email, or department.
 * @param {{ query: string }} params
 */
async function lookupUser({ query }) {
  const data = await graphRequest('GET',
    `/users?$search="displayName:${encodeURIComponent(query)}" OR "mail:${encodeURIComponent(query)}"&$top=10&$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation`
  );
  return data.value || [];
}

/**
 * Get full profile for a specific user.
 * @param {{ userId: string }} params
 */
async function getUser({ userId }) {
  return graphRequest('GET',
    `/users/${userId}?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,mobilePhone,businessPhones`
  );
}

/**
 * Relevance-ranked people search.
 * @param {{ query: string, top?: number }} params
 */
async function searchPeople({ query, top = 10 }) {
  const data = await graphRequest('GET',
    `/me/people?$search="${encodeURIComponent(query)}"&$top=${top}&$select=id,displayName,scoredEmailAddresses,jobTitle,department,officeLocation`
  );
  return data.value || [];
}

/**
 * Get mailbox settings (working hours, timezone, auto-reply).
 * @param {{ userId?: string }} params
 */
async function getMailboxSettings() {
  return graphRequest('GET', '/me/mailboxSettings');
}

// ── Register tools ──────────────────────────────────────────────────────

registerTool('lookup_user', {
  query: { type: 'string', required: true },
}, lookupUser);

registerTool('get_user', {
  userId: { type: 'string', required: true },
}, getUser);

registerTool('search_people', {
  query: { type: 'string', required: true },
  top:   { type: 'number' },
}, searchPeople);

registerTool('get_mailbox_settings', {}, getMailboxSettings);

module.exports = {
  lookupUser,
  getUser,
  searchPeople,
  getMailboxSettings,
};
