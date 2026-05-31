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

    const raw = await sourceManager.search(query, pageNum);
    const normalized = normalizeSearchResponse(raw, query);

    if (pageNum === 1 && normalized.items?.length) {
      searchCache.set(query, normalized);
    }

    res.json(normalized);
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

    const { type, tmdbId } = req.params;
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
    const { type, tmdbId } = req.params;
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
 */
router.get('/season/:tmdbId/:seasonNumber', async (req, res) => {
  try {
    const { tmdbId, seasonNumber } = req.params;
    const data = await net27.getSeasonEpisodes(parseInt(tmdbId), parseInt(seasonNumber));
    if (!data) {
      return res.status(404).json({ ok: false, error: 'Season not found' });
    }
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch season episodes');
  }
});

module.exports = router;
