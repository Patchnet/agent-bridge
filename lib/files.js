'use strict';

const fs = require('fs');

const FILE_BLOCK_RE = /```teams-file\s*\n([\s\S]*?)```/g;

/**
 * Extract teams-file JSON blocks from an agent reply.
 * Returns cleaned text (blocks removed) and an array of file directives.
 *
 * @param {string} text
 * @returns {{ text: string, files: Array<{ path?: string, url?: string, name: string }> }}
 */
function parseFileBlocks(text) {
  const files = [];

  const cleaned = text.replace(FILE_BLOCK_RE, (match, json) => {
    let parsed;
    try {
      parsed = JSON.parse(json.trim());
    } catch (_) {
      console.warn(`[${new Date().toISOString()}] [files] Malformed teams-file block, leaving in text`);
      return match;
    }

    if (!parsed.name || (!parsed.path && !parsed.url)) {
      console.warn(`[${new Date().toISOString()}] [files] teams-file block missing name or path/url, leaving in text`);
      return match;
    }

    if (parsed.path) {
      if (!fs.existsSync(parsed.path)) {
        console.warn(`[${new Date().toISOString()}] [files] File not found: ${parsed.path}`);
        return `[File not found: ${parsed.path}]`;
      }
      files.push({ path: parsed.path, name: parsed.name });
      return '';
    }

    if (parsed.url) {
      if (!parsed.url.startsWith('https://')) {
        console.warn(`[${new Date().toISOString()}] [files] Invalid URL (must be HTTPS): ${parsed.url}`);
        return `[Invalid file URL: ${parsed.url}]`;
      }
      files.push({ url: parsed.url, name: parsed.name });
      return '';
    }

    return match;
  });

  return { text: cleaned.trim(), files };
}

module.exports = { parseFileBlocks };
