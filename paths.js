const fs = require('fs');
const path = require('path');

const PATHS_FILE = path.join(__dirname, 'paths.txt');

function parseStoreList(value) {
  if (!value) return [];
  return value
    .split('|')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function loadPaths() {
  if (!fs.existsSync(PATHS_FILE)) {
    return {};
  }

  const raw = fs.readFileSync(PATHS_FILE, 'utf8');
  const lines = raw.split(/\r?\n/);
  const entries = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('REM ')) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith(';')) continue;

    const splitIndex = trimmed.indexOf('=');
    if (splitIndex === -1) continue;

    const key = trimmed.slice(0, splitIndex).trim();
    const value = trimmed.slice(splitIndex + 1).trim();
    if (!key) continue;

    entries[key] = value;
  }

  entries.STORES_LIST = parseStoreList(entries.STORES);
  return entries;
}

module.exports = loadPaths();
