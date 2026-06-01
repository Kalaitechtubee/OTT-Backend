const axios = require('axios');

const MIRROR_DOMAINS = [
  'https://net52.cc',
  'https://net11.cc'
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let _cachedDomain = 'https://net52.cc';
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const client = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  },
});

async function probeDomain(baseUrl) {
  try {
    const res = await axios.get(`${baseUrl}/pv/search.php`, {
      params: { s: 'sirai' },
      timeout: 4000,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.status === 200 && res.data && (res.data.searchResult || res.data.head)) {
      return true;
    }
  } catch (_) {
    // Unreachable or timed out
  }
  return false;
}

async function getWorkingDomain() {
  if (_cachedDomain && (Date.now() - _cacheTimestamp < CACHE_TTL_MS)) {
    return _cachedDomain;
  }

  for (const domain of MIRROR_DOMAINS) {
    console.log(`[Net52] Probing ${domain} ...`);
    if (await probeDomain(domain)) {
      console.log(`[Net52] ✅ Using mirror: ${domain}`);
      _cachedDomain = domain;
      _cacheTimestamp = Date.now();
      return domain;
    }
  }

  // Ultimate fallback
  console.log('[Net52] ⚠️ All probes failed, falling back to net52.cc');
  _cachedDomain = 'https://net52.cc';
  _cacheTimestamp = Date.now();
  return _cachedDomain;
}

function getActiveDomainSync() {
  return _cachedDomain;
}

async function apiGet(path, params = {}) {
  const domain = await getWorkingDomain();
  const url = `${domain}${path}`;
  console.log(`[Net52] GET ${url}`, Object.keys(params).length > 0 ? params : '');
  const response = await client.get(url, { params });
  return response.data;
}

async function search(query, page = 1) {
  try {
    return await apiGet(`/pv/search.php`, { s: query, page });
  } catch (err) {
    console.error(`[Net52] Search failed:`, err.message);
    throw err;
  }
}

async function details(type, tmdbId) {
  try {
    return await apiGet(`/pv/post.php`, { id: tmdbId });
  } catch (err) {
    console.error(`[Net52] Details failed:`, err.message);
    throw err;
  }
}

async function streams(tmdbId, opts = {}) {
  try {
    const id = opts.sid || tmdbId;
    return await apiGet(`/pv/playlist.php`, { id });
  } catch (err) {
    console.error(`[Net52] Streams failed:`, err.message);
    throw err;
  }
}

async function homepage() {
  try {
    return await apiGet(`/pv/homepage.php`);
  } catch (err) {
    console.error(`[Net52] Homepage failed:`, err.message);
    throw err;
  }
}

async function getLanguages(type, tmdbId, opts = {}) {
  try {
    const detailData = await details(type, tmdbId);
    const languagesList = detailData?.languages || [];
    const variants = languagesList.map(lang => ({
      dubSubjectId: String(tmdbId),
      language: lang,
      isOriginal: lang.toLowerCase().includes('english') || lang.toLowerCase().includes('original')
    }));
    return { ok: true, variants };
  } catch (err) {
    return { ok: false, variants: [] };
  }
}

module.exports = {
  provider: 'net52',
  enabled: true,

  getWorkingDomain,
  getActiveDomainSync,

  search,
  details,
  languages: getLanguages,
  streams,
  homepage,

  // Interface aliases
  searchTitles: search,
  getTitleDetails: details,
  getLanguages,
  getStreams: streams,
};
