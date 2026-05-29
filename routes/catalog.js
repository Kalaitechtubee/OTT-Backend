const express = require('express');
const router = express.Router();
const net27 = require('../services/net27');

const handleRouteError = (res, error, defaultMessage, statusCode = 502) => {
  console.error(`${defaultMessage}:`, error.message);
  if (error.response?.status === 429) {
    return res.status(429).json({ ok: false, error: 'Rate limited by upstream provider' });
  }
  return res.status(statusCode).json({ ok: false, error: defaultMessage });
};

/**
 * GET /api/catalog/trending
 *
 * Returns curated trending content from Net27 (movies + TV shows).
 * Response includes hero banners and category rails.
 */
router.get('/trending', async (req, res) => {
  try {
    const data = await net27.getCatalog('trending');
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch trending catalog');
  }
});

/**
 * GET /api/catalog/category/:tab
 *
 * Returns curated content for a specific tab (netflix, prime-video, etc.)
 */
router.get('/category/:tab', async (req, res) => {
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
 * Hybrid search across movies and TV shows.
 * Returns items with streamable flag, subjectId, detailPath, and variants.
 */
router.get('/search', async (req, res) => {
  try {
    const { q, page } = req.query;
    if (!q || q.trim() === '') {
      return res.status(400).json({ ok: false, error: 'Query parameter "q" is required' });
    }
    const data = await net27.searchTitles(q.trim(), parseInt(page) || 1);
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Search failed');
  }
});

/**
 * GET /api/catalog/title/:type/:tmdbId
 *
 * Full details for a movie or TV show.
 * For TV: includes seasons array and episode list for the initial season.
 *
 * :type  = 'movie' or 'tv'
 * :tmdbId = TMDB ID (e.g. 550 for Fight Club, 76479 for The Boys)
 */
router.get('/title/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Type must be "movie" or "tv"' });
    }
    const data = await net27.getTitleDetails(type, parseInt(tmdbId));
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch title details');
  }
});

/**
 * GET /api/catalog/season/:tmdbId/:seasonNumber
 *
 * Get episodes for a specific season of a TV show.
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
