const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'search-cache.json');
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Popular Tamil queries to warm on server start (optional). */
const WARM_QUERIES = [
  'mersal',
  'amaran',
  'leo',
  'jailer',
  'vikram',
  'master',
  'beast',
  'thunivu',
  'vidamuyarchi',
  'retro',
  'dragon',
  'tourist family',
];

let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return _cache;
    }
  } catch (e) {
    console.warn('[SearchCache] Failed to load:', e.message);
  }
  _cache = { entries: {} };
  return _cache;
}

function saveCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[SearchCache] Failed to save:', e.message);
  }
}

function cacheKey(query) {
  return query.trim().toLowerCase();
}

function get(query) {
  const key = cacheKey(query);
  const store = loadCache();
  const entry = store.entries[key];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    delete store.entries[key];
    return null;
  }
  console.log(`[SearchCache] File hit: "${query}"`);
  return entry.data;
}

function set(query, data) {
  const key = cacheKey(query);
  loadCache();
  _cache.entries[key] = {
    cachedAt: Date.now(),
    data,
  };
  saveCache();
}

function warmFromFetcher(fetchFn) {
  const run = async () => {
    for (const q of WARM_QUERIES) {
      if (get(q)) continue;
      try {
        const raw = await fetchFn(q, 1);
        if (raw?.items?.length) {
          const { normalizeSearchResponse } = require('./searchNormalize');
          set(q, normalizeSearchResponse(raw, q));
          console.log(`[SearchCache] Warmed "${q}" (${raw.items.length} raw → cached)`);
        }
      } catch (e) {
        console.warn(`[SearchCache] Warm failed for "${q}":`, e.message);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  };
  run().catch(() => {});
}

module.exports = {
  get,
  set,
  warmFromFetcher,
  WARM_QUERIES,
};
