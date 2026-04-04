'use strict';

/**
 * text.js — small text normalization helpers.
 *
 * The bridge mostly handles UTF-8 correctly already, but upstream content can
 * occasionally arrive as common UTF-8 mojibake (for example "â€”" instead of
 * "—" or "ðŸ“… " instead of an emoji). We repair that defensively at the
 * OpenClaw boundary before the text reaches tool parsing or user delivery.
 */

const MOJIBAKE_RE = /(?:Ã.|Â.|â[\u0080-\u00bf]|ð[\u0080-\u00bf]|ï[\u0080-\u00bf]|œ|ž|™)/g;

function countMojibakeMarkers(text) {
  const matches = text.match(MOJIBAKE_RE);
  return matches ? matches.length : 0;
}

function looksMojibaked(text) {
  return countMojibakeMarkers(text) > 0;
}

/**
 * Try the classic "latin1 bytes re-decoded as UTF-8" repair and only keep it
 * when it clearly improves the text.
 *
 * @param {string} text
 * @returns {string}
 */
function repairMojibake(text) {
  if (!text || !looksMojibaked(text)) return text;

  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  const originalScore = countMojibakeMarkers(text);
  const repairedScore = countMojibakeMarkers(repaired);

  // Keep the repair only when it materially reduces mojibake markers and does
  // not introduce replacement chars.
  if (repairedScore < originalScore && !repaired.includes('\uFFFD')) {
    return repaired;
  }

  return text;
}

module.exports = { repairMojibake };
