const express = require('express');
const router = express.Router();

const searchController = require('../controllers/search.controller');
const detailsController = require('../controllers/details.controller');
const streamController = require('../controllers/stream.controller');
const streamProxyController = require('../controllers/streamProxy.controller');
const tmdbController = require('../controllers/tmdb.controller');

router.get('/search', searchController.search);
router.get('/details/tmdb/:tmdbId', tmdbController.getDetailsByTmdbId);
router.get('/details/:provider/:id', detailsController.getDetails);
router.get('/stream/proxy', streamProxyController.proxyStream);
router.get('/stream/:provider/:id', streamController.getStream);

// TMDB List Proxies
router.get('/tmdb/trending', tmdbController.getTrending);
router.get('/tmdb/popular', tmdbController.getPopular);
router.get('/tmdb/top_rated', tmdbController.getTopRated);
router.get('/tmdb/upcoming', tmdbController.getUpcoming);
router.get('/tmdb/popular_tv', tmdbController.getPopularTv);
router.get('/tmdb/discover', tmdbController.discover);
router.get('/tmdb/season/:tmdbId/:seasonNumber', tmdbController.getSeasonEpisodes);

// ─── Debug / Diagnostics ────────────────────────────────────────────────────
// GET /api/v2/debug/tmdb?q=Leo  — live TMDB search test
router.get('/debug/tmdb', async (req, res) => {
  const axios = require('axios');
  const { TMDB_API_KEY, TMDB_BASE_URL } = require('../config/tmdb');
  const query = req.query.q || 'Avengers';
  if (!TMDB_API_KEY) {
    return res.status(503).json({ ok: false, error: 'TMDB_API_KEY not configured in .env' });
  }
  try {
    const result = await axios.get(`${TMDB_BASE_URL}/search/multi`, {
      params: { api_key: TMDB_API_KEY, query },
      timeout: 8000
    });
    const hits = (result.data.results || []).slice(0, 3).map(r => ({
      id: r.id,
      title: r.title || r.name,
      media_type: r.media_type,
      year: (r.release_date || r.first_air_date || '').substring(0, 4),
      popularity: r.popularity,
      poster_path: r.poster_path
    }));
    res.json({
      ok: true,
      tmdb_url: TMDB_BASE_URL,
      api_key_prefix: TMDB_API_KEY.substring(0, 6) + '...',
      query,
      total_results: result.data.total_results,
      top3: hits
    });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.status_message || err.message;
    res.status(500).json({ ok: false, http_status: status, error: msg });
  }
});

// GET /api/v2/debug/providers  — net11/net52 domain probe
router.get('/debug/providers', async (req, res) => {
  const { getNet11Domain, getNet52Domain } = require('../utils/axiosClient');
  const [net11, net52] = await Promise.all([
    getNet11Domain().catch(e => `ERROR: ${e.message}`),
    getNet52Domain().catch(e => `ERROR: ${e.message}`)
  ]);
  res.json({ ok: true, net11_domain: net11, net52_domain: net52 });
});

module.exports = router;

