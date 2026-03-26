'use strict';

const fs   = require('fs');
const path = require('path');

const MODES_FILE = path.join(__dirname, '..', 'channel-modes.json');
const VALID_MODES = ['monitor', 'managed', 'open'];

// Mode storage

function loadModes() {
  try {
    if (fs.existsSync(MODES_FILE)) {
      return JSON.parse(fs.readFileSync(MODES_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] [channels] Failed to load channel-modes.json, starting fresh: ${err.message}`);
  }
  return {};
}

function saveModes(modes) {
  try {
    fs.writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2), 'utf8');
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [channels] Failed to save channel-modes.json: ${err.message}`);
  }
}

function getMode(modes, teamId) {
  return modes[teamId]?.mode || 'monitor';
}

function setMode(modes, teamId, mode, teamName, setBy) {
  modes[teamId] = {
    mode,
    name: teamName,
    setBy,
    setAt: new Date().toISOString(),
  };
  saveModes(modes);
}

// Team membership detection

function detectTeamChanges(currentTeams, modes) {
  const currentIds = new Set(currentTeams.map(t => t.id));
  const knownIds   = new Set(Object.keys(modes));

  const added = currentTeams.filter(t => !knownIds.has(t.id));
  const removed = [...knownIds]
    .filter(id => !currentIds.has(id))
    .map(id => ({ id, name: modes[id]?.name || id }));

  return { added, removed };
}

// Manager DM command parsing

function parseManagerCommand(text) {
  const trimmed = (text || '').trim();

  if (/^teams$/i.test(trimmed)) {
    return { command: 'list' };
  }

  const setMatch = trimmed.match(/^set\s+(.+?)\s+(monitor|managed|open)$/i);
  if (setMatch) {
    return {
      command: 'set',
      teamName: setMatch[1].trim(),
      mode: setMatch[2].toLowerCase(),
    };
  }

  return null;
}

function isManagerCommand(text) {
  return parseManagerCommand(text) !== null;
}

// Format helpers

function formatTeamList(modes, teams) {
  if (teams.length === 0) return 'I am not a member of any teams.';

  const lines = teams.map(t => {
    const mode = getMode(modes, t.id);
    return `- **${t.displayName}** - ${mode}`;
  });

  return 'My teams:\n\n' + lines.join('\n');
}

function findTeamByName(teams, name) {
  const lower = name.toLowerCase();
  return teams.find(t => t.displayName.toLowerCase() === lower);
}

module.exports = {
  VALID_MODES,
  loadModes,
  saveModes,
  getMode,
  setMode,
  detectTeamChanges,
  parseManagerCommand,
  isManagerCommand,
  formatTeamList,
  findTeamByName,
};
