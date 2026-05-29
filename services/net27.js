const axios = require('axios');
const dns = require('dns').promises;

// ─── Mirror Configuration ───────────────────────────────────────────────────
const MIRROR_DOMAINS = [
  'https://net27.cc',
  'https://net52.cc',
  'https://net22.cc',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let _cachedDomain = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── HTTP Client ────────────────────────────────────────────────────────────
const client = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  },
});

// ─── Memory Caching ──────────────────────────────────────────────────────────
class MemoryCache {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.cache = new Map();
    this.ttl = ttlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }
}

const catalogDetailsCache = new MemoryCache();
const languagesCache = new MemoryCache();
const streamsCache = new MemoryCache();
const seasonEpisodesCache = new MemoryCache();

// ─── Mirror Discovery ───────────────────────────────────────────────────────

/**
 * Probe a single domain to check if it is the real NetMirror portal.
 * Returns true if the domain is responsive and serves the streaming site.
 */
async function probeDomain(baseUrl) {
  try {
    const res = await axios.get(baseUrl, {
      timeout: 4000,
      headers: { 'User-Agent': USER_AGENT },
      maxRedirects: 3,
    });
    if (res.status === 200) {
      const text = typeof res.data === 'string' ? res.data : '';
      // Verify it's the actual streaming portal, not a parked/blocked page
      if (text.includes('Search movies') && !text.includes('Sign-In is Required')) {
        return true;
      }
    }
  } catch (_) {
    // Unreachable or timed out
  }
  return false;
}

/**
 * Sweep netXX.cc domains (net10 to net99) via DNS to discover live mirrors.
 */
async function discoverViaDNS() {
  console.log('[Net27] DNS sweep: scanning net10.cc → net99.cc ...');
  const resolved = [];
  const lookups = [];

  for (let i = 10; i <= 99; i++) {
    const domain = `net${i}.cc`;
    lookups.push(
      dns
        .lookup(domain)
        .then(() => resolved.push(`https://${domain}`))
        .catch(() => {})
    );
  }
  await Promise.all(lookups);

  console.log(`[Net27] DNS sweep found ${resolved.length} candidates`);

  for (const url of resolved) {
    if (await probeDomain(url)) {
      console.log(`[Net27] ✅ Discovered active mirror via DNS: ${url}`);
      return url;
    }
  }
  return null;
}

/**
 * Find a working mirror domain. Uses a short cache to avoid repeated probing.
 */
async function getWorkingDomain() {
  // Return cached if still valid
  if (_cachedDomain && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedDomain;
  }

  // Try known mirrors first
  for (const domain of MIRROR_DOMAINS) {
    console.log(`[Net27] Probing ${domain} ...`);
    if (await probeDomain(domain)) {
      console.log(`[Net27] ✅ Using mirror: ${domain}`);
      _cachedDomain = domain;
      _cacheTimestamp = Date.now();
      return domain;
    }
  }

  // Fallback: DNS sweep
  const discovered = await discoverViaDNS();
  if (discovered) {
    _cachedDomain = discovered;
    _cacheTimestamp = Date.now();
    return discovered;
  }

  // Ultimate fallback
  console.log('[Net27] ⚠️ All probes failed, falling back to net27.cc');
  _cachedDomain = 'https://net27.cc';
  _cacheTimestamp = Date.now();
  return _cachedDomain;
}

/**
 * Make a GET request to a Net27 API endpoint with automatic mirror resolution.
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make a GET request to a Net27 API endpoint with automatic mirror resolution.
 */
async function apiGet(path, params = {}, retryCount = 0) {
  const domain = await getWorkingDomain();
  const url = `${domain}${path}`;
  console.log(`[Net27] GET ${url}`, Object.keys(params).length > 0 ? params : '');

  try {
    const response = await client.get(url, { params });
    return response.data;
  } catch (error) {
    if (error.response?.status === 429 && retryCount < 1) {
      console.warn(`[Net27] Got 429 Rate Limit for ${url}. Retrying in 3 seconds...`);
      await delay(3000);
      return apiGet(path, params, retryCount + 1);
    }
    throw error;
  }
}

// ─── Public API Methods ─────────────────────────────────────────────────────

/**
 * Get curated catalog (trending, netflix, etc.)
 * @param {string} tab - e.g. 'trending', 'netflix', 'prime-video'
 */
async function getCatalog(tab = 'trending') {
  return apiGet(`/api/catalog/curated/${tab}`);
}

/**
 * Search movies and TV shows.
 * @param {string} query - Search query
 * @param {number} page  - Page number (default 1)
 */
async function searchTitles(query, page = 1) {
  return apiGet('/api/catalog/search-hybrid', { q: query, page });
}

/**
 * Get full details for a title (movie or TV).
 * For TV shows, includes seasons array and initial episode list.
 *
 * @param {string} type   - 'movie' or 'tv'
 * @param {number} tmdbId - TMDB ID
 */
async function getTitleDetails(type, tmdbId) {
  const cacheKey = `${type}_${tmdbId}`;
  const cached = catalogDetailsCache.get(cacheKey);
  if (cached) {
    console.log(`[Net27] Cache hit for details: ${cacheKey}`);
    return cached;
  }

  const data = await apiGet(`/api/catalog/title/${type}/${tmdbId}`);
  catalogDetailsCache.set(cacheKey, data);
  return data;
}

/**
 * Get TV season episodes from Net27's catalog.
 *
 * @param {number} tmdbId       - TMDB ID
 * @param {number} seasonNumber - Season number
 */
async function getSeasonEpisodes(tmdbId, seasonNumber) {
  const cacheKey = `${tmdbId}_${seasonNumber}`;
  const cached = seasonEpisodesCache.get(cacheKey);
  if (cached) {
    console.log(`[Net27] Cache hit for season episodes: ${cacheKey}`);
    return cached;
  }

  try {
    const data = await apiGet(`/api/catalog/title/tv/${tmdbId}`, { season: seasonNumber });
    seasonEpisodesCache.set(cacheKey, data);
    return data;
  } catch (e) {
    console.error(`[Net27] Error fetching season ${seasonNumber} episodes:`, e.message);
    return null;
  }
}

/**
 * Get available language variants (dubs/subs) for a title.
 *
 * @param {string} type   - 'movie' or 'tv'
 * @param {number} tmdbId - TMDB ID
 * @param {object} opts   - For TV: { se, ep, sid, dp }
 */
async function getLanguages(type, tmdbId, opts = {}) {
  const cacheKey = `${type}_${tmdbId}_${opts.se || ''}_${opts.ep || ''}_${opts.sid || ''}_${opts.dp || ''}`;
  const cached = languagesCache.get(cacheKey);
  if (cached) {
    console.log(`[Net27] Cache hit for languages: ${cacheKey}`);
    return cached;
  }

  // Pass all available params to the Net27 variants API for BOTH movies and TV.
  // Without sid/dp, Net27 cannot identify the specific title and may return no variants.
  const params = {};
  if (opts.se) params.se = opts.se;
  if (opts.ep) params.ep = opts.ep;
  if (opts.sid) params.sid = opts.sid;
  if (opts.dp) params.dp = opts.dp;

  console.log(`[Net27] Fetching language variants for ${type}/${tmdbId}`, params);
  const data = await apiGet(`/api/variants-tmdb/${type}/${tmdbId}`, params);
  console.log(`[Net27] Language variants result: ok=${data?.ok}, count=${data?.variants?.length ?? 0}`);
  languagesCache.set(cacheKey, data);
  return data;
}

/**
 * Extract the UNIX timestamp `t` from a signed CDN URL.
 * Returns 0 if not found.
 */
function extractTokenExpiry(url) {
  if (!url) return 0;
  const m = url.match(/[?&]t=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Get fresh MP4 stream URLs for a title.
 *
 * ⚠️ NEVER CACHE the returned URLs — they contain signed tokens that expire.
 *
 * @param {number} tmdbId - TMDB ID
 * @param {object} opts   - { type, se, ep, sid, dp }
 *   - type: 'tv' for series (omit for movies)
 *   - se:   season number
 *   - ep:   episode number
 *   - sid:  subjectId (for language selection)
 *   - dp:   detailPath
 */
async function getStreams(tmdbId, opts = {}) {
  const params = {};
  if (opts.type) params.type = opts.type;
  if (opts.se) params.se = opts.se;
  if (opts.ep) params.ep = opts.ep;
  if (opts.dub) params.dub = opts.dub;
  if (opts.sid) params.sid = opts.sid;
  if (opts.dp) params.dp = opts.dp;

  // Always fetch fresh — never cache stream responses (signed tokens expire)
  const data = await apiGet(`/api/embed-tmdb/${tmdbId}`, params);

  // Note: Net27 sometimes returns tokens that appear "expired" by timestamp,
  // but the CDN (bcdnxw.hakunaymatata.com) validates by IP/region, not timestamp.
  // Requests routed through the Cloudflare Worker always succeed (206 Partial Content).
  const checkUrl = data?.mp4 || (data?.streams && data.streams[0]?.url);
  if (checkUrl) {
    const t = extractTokenExpiry(checkUrl);
    const nowSec = Math.floor(Date.now() / 1000);
    if (t && t < nowSec) {
      console.log(`[Net27] ℹ️ Token t=${t} appears expired by ${nowSec - t}s — CDN still accepts via CF Worker.`);
    } else {
      console.log(`[Net27] ✅ Token valid, expires in ${t ? t - nowSec : '?'}s`);
    }
  }

  return data;
}

module.exports = {
  getWorkingDomain,
  getCatalog,
  searchTitles,
  getTitleDetails,
  getSeasonEpisodes,
  getLanguages,
  getStreams,
};
