const express = require('express');
const router = express.Router();
const net27 = require('../providers/net27');
const sourceManager = require('../services/sourceManager');
const { buildFilteredCatalog, buildItemLanguageMap, getCategoryItems } = require('../utils/catalogFilter');
const { normalizeLanguageName } = require('../utils/languageMatchers');
const { normalizeSearchResponse } = require('../utils/searchNormalize');
const searchCache = require('../utils/searchCache');
const { TMDB_API_KEY, TMDB_BASE_URL } = require('../config/tmdb');

const handleRouteError = (res, error, defaultMessage, statusCode = 502) => {
  console.error(`${defaultMessage}:`, error.message);
  if (error.response?.status === 429) {
    return res.status(429).json({ ok: false, error: 'Rate limited by upstream provider' });
  }
  return res.status(statusCode).json({ ok: false, error: defaultMessage });
};

const RAW_CATALOG_TTL_MS = 20 * 60 * 1000;
const FILTERED_CATALOG_TTL_MS = 10 * 60 * 1000;

let rawCatalogCache = { data: null, fetchedAt: 0 };
let itemLanguagesCache = { map: null, fetchedAt: 0, rawFetchedAt: 0 };
const filteredCatalogCache = new Map();
/** Single-flight loader so parallel requests don't double-probe Net27. */
let catalogLoadPromise = null;

async function getRawTrendingCatalog() {
  const now = Date.now();
  if (rawCatalogCache.data && now - rawCatalogCache.fetchedAt < RAW_CATALOG_TTL_MS) {
    return rawCatalogCache.data;
  }
  try {
    const data = await net27.getCatalog('trending');
    if (!data) return rawCatalogCache.data;
    rawCatalogCache = { data, fetchedAt: now };
    itemLanguagesCache = { map: null, fetchedAt: 0, rawFetchedAt: 0 };
    filteredCatalogCache.clear();
    return data;
  } catch (error) {
    if (error.response?.status === 429 && rawCatalogCache.data) {
      console.warn('[Catalog] Upstream 429 — serving stale raw catalog');
      return rawCatalogCache.data;
    }
    throw error;
  }
}

async function getItemLanguagesForCatalog(rawData) {
  const now = Date.now();
  if (
    itemLanguagesCache.map &&
    itemLanguagesCache.rawFetchedAt === rawCatalogCache.fetchedAt &&
    now - itemLanguagesCache.fetchedAt < RAW_CATALOG_TTL_MS
  ) {
    return itemLanguagesCache.map;
  }
  const map = await buildItemLanguageMap(rawData);
  itemLanguagesCache = { map, fetchedAt: now, rawFetchedAt: rawCatalogCache.fetchedAt };
  return map;
}

async function loadFilteredCatalog(language) {
  const langKey = normalizeLanguageName(language) || 'All Languages';
  const now = Date.now();
  const cached = filteredCatalogCache.get(langKey);
  if (cached && now - cached.fetchedAt < FILTERED_CATALOG_TTL_MS) {
    return cached.catalog;
  }

  if (!catalogLoadPromise) {
    catalogLoadPromise = (async () => {
      const data = await getRawTrendingCatalog();
      if (!data) return null;
      const itemLanguages = await getItemLanguagesForCatalog(data);
      return { data, itemLanguages };
    })().finally(() => {
      catalogLoadPromise = null;
    });
  }

  const shared = await catalogLoadPromise;
  if (!shared) return null;

  const catalog = await buildFilteredCatalog(shared.data, language, shared.itemLanguages);
  filteredCatalogCache.set(langKey, { catalog, fetchedAt: Date.now() });
  return catalog;
}

/**
 * GET /api/catalog/trending?language=Tamil
 *
 * Returns curated trending content with hero banners and category rails.
 */
router.get('/trending', async (req, res) => {
  try {
    const { language } = req.query;
    const catalog = await loadFilteredCatalog(language);
    if (!catalog) return res.json(catalog);

    res.json({
      ok: true,
      tab: catalog.tab,
      hero: catalog.hero,
      rails: catalog.rails,
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch trending catalog');
  }
});

/**
 * GET /api/catalog/movies?language=Tamil
 */
router.get('/movies', async (req, res) => {
  try {
    const { language } = req.query;
    const catalog = await loadFilteredCatalog(language);
    if (!catalog) return res.json(catalog);

    const items = getCategoryItems(catalog, 'movies');
    res.json({
      ok: true,
      language: language || 'All Languages',
      items,
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch movies catalog');
  }
});

/**
 * GET /api/catalog/series?language=Tamil
 */
router.get('/series', async (req, res) => {
  try {
    const { language } = req.query;
    const catalog = await loadFilteredCatalog(language);
    if (!catalog) return res.json(catalog);

    const items = getCategoryItems(catalog, 'series');
    res.json({
      ok: true,
      language: language || 'All Languages',
      items,
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch series catalog');
  }
});

/**
 * GET /api/catalog/category/:category?language=Tamil
 *
 * Categories: movies, dubbed, series, trending, new_releases, action, comedy, horror, romance
 */
router.get('/category/:category', async (req, res) => {
  try {
    const { language } = req.query;
    const { category } = req.params;
    const catalog = await loadFilteredCatalog(language);
    if (!catalog) return res.json(catalog);

    const items = getCategoryItems(catalog, category);
    res.json({
      ok: true,
      category,
      language: language || 'All Languages',
      items,
    });
  } catch (e) {
    handleRouteError(res, e, `Failed to fetch ${req.params.category} catalog`);
  }
});

/**
 * GET /api/catalog/category/:tab
 *
 * Legacy tab catalog (netflix, prime-video, etc.)
 */
router.get('/tab/:tab', async (req, res) => {
  try {
    const data = await net27.getCatalog(req.params.tab);
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, `Failed to fetch ${req.params.tab} catalog`);
  }
});

/**
 * GET /api/catalog/search?q=<query>&page=1
 *
 * Uses Net27 search-hybrid (streamable + tmdbId + subjectId).
 * Results are deduped, sorted (streamable first), and file-cached 24h.
 */
router.get('/search', async (req, res) => {
  try {
    const { q, page } = req.query;
    if (!q || q.trim() === '') {
      return res.status(400).json({ ok: false, error: 'Query parameter "q" is required' });
    }
    const query = q.trim();
    const pageNum = parseInt(page) || 1;

    if (pageNum === 1) {
      const cached = searchCache.get(query);
      if (cached) return res.json(cached);
    }

    const unifiedResult = await sourceManager.search(query, pageNum);

    if (pageNum === 1 && unifiedResult.results?.length) {
      searchCache.set(query, unifiedResult);
    }

    res.json(unifiedResult);
  } catch (e) {
    handleRouteError(res, e, 'Search failed');
  }
});

/**
 * GET /api/catalog/trailer/:type/:tmdbId
 */
router.get('/trailer/:type/:tmdbId', async (req, res) => {
  try {
    const apiKey = TMDB_API_KEY;
    if (!apiKey) {
      return res.json({
        ok: false,
        error: 'Trailer service is not configured on the server. Set TMDB_API_KEY in backend env.',
        code: 'TMDB_NOT_CONFIGURED',
      });
    }

    let { type, tmdbId } = req.params;
    if (type === 'series') type = 'tv';
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Type must be "movie" or "tv"' });
    }

    const axios = require('axios');
    const tmdbType = type === 'tv' ? 'tv' : 'movie';
    const response = await axios.get(`${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/videos`, {
      params: { api_key: apiKey },
      timeout: 10000,
    });

    const videos = response.data?.results ?? [];
    const trailer =
      videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
      videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser') ||
      videos.find((v) => v.site === 'YouTube');

    if (!trailer?.key) {
      return res.json({ ok: false, error: 'No trailer found for this title.' });
    }

    res.json({
      ok: true,
      youtubeKey: trailer.key,
      name: trailer.name || 'Trailer',
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch trailer');
  }
});

/**
 * GET /api/catalog/title/:type/:tmdbId
 */
router.get('/title/:type/:tmdbId', async (req, res) => {
  try {
    let { type, tmdbId } = req.params;
    if (type === 'series') type = 'tv';
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Type must be "movie" or "tv"' });
    }
    const data = await sourceManager.details(type, parseInt(tmdbId));
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch title details');
  }
});

/**
 * GET /api/catalog/season/:tmdbId/:seasonNumber
 *
 * Returns episodes for a specific season.
 * Primary source: Net27 upstream. Falls back to TMDB API.
 */
router.get('/season/:tmdbId/:seasonNumber', async (req, res) => {
  try {
    const { tmdbId, seasonNumber } = req.params;
    const tmdbIdInt = parseInt(tmdbId);
    const seasonNum = parseInt(seasonNumber);

    // Try Net27 first
    let data = null;
    try {
      data = await net27.getSeasonEpisodes(tmdbIdInt, seasonNum);
    } catch (net27Err) {
      console.warn(`[Catalog] Net27 season episodes failed for ${tmdbId}/S${seasonNumber}: ${net27Err.message}`);
    }

    // Check if Net27 returned usable episodes
    const hasEpisodes = data && (
      (Array.isArray(data.initialEpisodes) && data.initialEpisodes.length > 0) ||
      (Array.isArray(data.episodes) && data.episodes.length > 0)
    );

    if (hasEpisodes) {
      return res.json(data);
    }

    // TMDB fallback: fetch season episode metadata directly
    console.log(`[Catalog] Net27 returned no episodes for ${tmdbId}/S${seasonNumber}, trying TMDB fallback...`);
    const tmdbApiKey = TMDB_API_KEY;
    if (!tmdbApiKey) {
      return res.status(404).json({ ok: false, error: 'Season not found and TMDB fallback unavailable' });
    }

    const axios = require('axios');
    const tmdbRes = await axios.get(`${TMDB_BASE_URL}/tv/${tmdbId}/season/${seasonNumber}`, {
      params: { api_key: tmdbApiKey },
      timeout: 8000,
    });

    const tmdbEpisodes = tmdbRes.data?.episodes;
    if (!Array.isArray(tmdbEpisodes) || tmdbEpisodes.length === 0) {
      return res.status(404).json({ ok: false, error: 'No episodes found for this season' });
    }

    // Normalize TMDB episode format to match what Flutter expects
    const normalizedEpisodes = tmdbEpisodes.map(ep => ({
      episode: ep.episode_number,
      episode_number: ep.episode_number,
      episodeNumber: ep.episode_number,
      name: ep.name || `Episode ${ep.episode_number}`,
      overview: ep.overview || '',
      still: ep.still_path ? `https://image.tmdb.org/t/p/w342${ep.still_path}` : null,
      still_path: ep.still_path || null,
      runtime: ep.runtime || 0,
      airDate: ep.air_date || '',
      air_date: ep.air_date || '',
    }));

    console.log(`[Catalog] TMDB fallback: returning ${normalizedEpisodes.length} episodes for ${tmdbId}/S${seasonNumber}`);
    res.json({
      ok: true,
      initialEpisodes: normalizedEpisodes,
      tmdbFallback: true,
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch season episodes');
  }
});

module.exports = router;
