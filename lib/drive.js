'use strict';

/**
 * drive.js — OneDrive and SharePoint file bridge tools.
 *
 * Discrete, validated operations for browsing, searching, and accessing
 * files via Microsoft Graph. Scopes: Files.ReadWrite, Files.ReadWrite.All,
 * Sites.ReadWrite.All (already granted).
 */

const { graphRequest } = require('./graph');
const { registerTool } = require('./tools');

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Encode a file path for Graph API colon-path syntax.
 * Encodes each segment individually but preserves / separators.
 */
function encodePath(p) {
  return p.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

function userTarget(userId) {
  return userId ? `/users/${encodeURIComponent(userId)}` : '/me';
}

// ── Tool implementations ────────────────────────────────────────────────

/**
 * List files in a OneDrive folder.
 * @param {{ path?: string, userId?: string, top?: number }} params
 */
async function listFiles({ path = 'root', userId, top = 25 } = {}) {
  const target = userTarget(userId);
  const select = '$select=id,name,size,lastModifiedDateTime,webUrl,file,folder';
  const endpoint = path === 'root'
    ? `${target}/drive/root/children?$top=${top}&${select}`
    : `${target}/drive/root:/${encodePath(path)}:/children?$top=${top}&${select}`;
  const data = await graphRequest('GET', endpoint);
  return data.value || [];
}

/**
 * Search files across OneDrive and SharePoint.
 * @param {{ query: string, userId?: string, top?: number }} params
 */
async function searchFiles({ query, userId, top = 25 }) {
  const target = userTarget(userId);
  const data = await graphRequest('GET',
    `${target}/drive/root/search(q='${encodeURIComponent(query)}')?$top=${top}&$select=id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference`
  );
  return data.value || [];
}

/**
 * List files shared with the bot account.
 * @param {{ top?: number }} params
 */
async function getSharedWithMe({ top = 25 } = {}) {
  const data = await graphRequest('GET',
    `/me/drive/sharedWithMe?$top=${top}&$select=id,name,size,lastModifiedDateTime,webUrl,file,folder,remoteItem,shared`
  );
  return data.value || [];
}

/**
 * Get file metadata by ID or path.
 * @param {{ fileId?: string, path?: string, userId?: string }} params
 */
async function getFileInfo({ fileId, path, userId }) {
  if (!fileId && !path) {
    return { success: false, error: 'Either fileId or path is required' };
  }
  const target = userTarget(userId);
  const select = '$select=id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference,shared';
  if (fileId) {
    return graphRequest('GET', `${target}/drive/items/${fileId}?${select}`);
  }
  return graphRequest('GET', `${target}/drive/root:/${encodePath(path)}?${select}`);
}

/**
 * Get a download URL for a file.
 * @param {{ fileId: string, userId?: string }} params
 */
async function getDownloadUrl({ fileId, userId }) {
  const target = userTarget(userId);
  const item = await graphRequest('GET', `${target}/drive/items/${fileId}?$select=id,name,@microsoft.graph.downloadUrl`);
  return {
    fileId: item.id,
    name: item.name,
    downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
  };
}

// ── Register tools ──────────────────────────────────────────────────────

registerTool('list_files', {
  path:   { type: 'string' },
  userId: { type: 'string' },
  top:    { type: 'number' },
}, listFiles);

registerTool('search_files', {
  query:  { type: 'string', required: true },
  userId: { type: 'string' },
  top:    { type: 'number' },
}, searchFiles);

registerTool('get_shared_with_me', {
  top: { type: 'number' },
}, getSharedWithMe);

registerTool('get_file_info', {
  fileId: { type: 'string' },
  path:   { type: 'string' },
  userId: { type: 'string' },
}, getFileInfo);

registerTool('get_download_url', {
  fileId: { type: 'string', required: true },
  userId: { type: 'string' },
}, getDownloadUrl);

module.exports = {
  listFiles,
  searchFiles,
  getSharedWithMe,
  getFileInfo,
  getDownloadUrl,
};
