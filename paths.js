const fs = require('fs');
const path = require('path');

const PATHS_FILE = path.join(__dirname, 'paths.txt');

function parseStoreConfig(value) {
  if (!value) {
    return { stores: [], storeMap: {} };
  }

  const stores = [];
  const storeMap = {};

  value
    .split('|')
    .map(entry => entry.trim())
    .filter(Boolean)
    .forEach(entry => {
      const [namePart, idPart] = entry.split(':').map(part => part.trim());
      if (!namePart) return;
      stores.push(namePart);
      if (idPart) {
        const idNumber = Number(idPart);
        if (!Number.isNaN(idNumber)) {
          storeMap[namePart] = idNumber;
        }
      }
    });

  return { stores, storeMap };
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

  const parsedStores = parseStoreConfig(entries.STORES);
  entries.STORES_LIST = parsedStores.stores;
  entries.STORES_MAP = parsedStores.storeMap;
  return entries;
}

module.exports = loadPaths();
