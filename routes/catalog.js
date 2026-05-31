const express = require('express');
const router = express.Router();
const net27 = require('../services/net27');
const sourceManager = require('../services/sourceManager');
const { TMDB_API_KEY, TMDB_BASE_URL } = require('../config/tmdb');

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
    const { language } = req.query;
    const data = await net27.getCatalog('trending');
    if (!data) return res.json(data);
    
    const activeLang = language || 'All Languages';
    const langLower = activeLang.toLowerCase().trim();
    const isLangSelected = activeLang !== 'All Languages';

    // 1. Collect all unique items
    const itemsMap = new Map();
    if (data.rails) {
      data.rails.forEach(rail => {
        if (rail.items) {
          rail.items.forEach(item => {
            const key = `${item.type}_${item.tmdbId}`;
            if (!itemsMap.has(key)) {
              itemsMap.set(key, item);
            }
          });
        }
      });
    }
    if (data.hero) {
      data.hero.forEach(h => {
        const key = `${h.type}_${h.tmdbId}`;
        if (!itemsMap.has(key)) {
          itemsMap.set(key, {
            tmdbId: h.tmdbId,
            type: h.type,
            title: h.title,
            rating: h.rating,
            poster: h.poster || '',
            backdrop: h.backdropUrl || h.backdrop
          });
        } else {
          // Merge backdrop if not present
          const existing = itemsMap.get(key);
          if (!existing.backdrop && (h.backdropUrl || h.backdrop)) {
            existing.backdrop = h.backdropUrl || h.backdrop;
          }
        }
      });
    }
    const itemsList = Array.from(itemsMap.values());

    // 2. Fetch variants for unique items in parallel
    const langResults = await Promise.all(
      itemsList.map(async (item) => {
        try {
          const variantsData = await net27.getLanguages(item.type, item.tmdbId, {
            sid: item.subjectId,
            dp: item.detailPath
          });
          return { item, variantsData };
        } catch (_) {
          return { item, variantsData: null };
        }
      })
    );

    // Map each item's language details
    const itemLanguages = new Map(); // key -> { originalLangs, dubLangs }
    langResults.forEach(({ item, variantsData }) => {
      const originalLangs = [];
      const dubLangs = [];
      if (variantsData && variantsData.variants) {
        variantsData.variants.forEach(v => {
          if (v.isOriginal) {
            originalLangs.push(v.language.toLowerCase());
          } else {
            dubLangs.push(v.language.toLowerCase());
          }
        });
      }
      itemLanguages.set(`${item.type}_${item.tmdbId}`, { originalLangs, dubLangs });
    });

    // Helper to check language support
    const isNativeLang = (item) => {
      if (!isLangSelected) return true;
      const langs = itemLanguages.get(`${item.type}_${item.tmdbId}`);
      if (!langs) return false;
      return langs.originalLangs.some(l => l.includes(langLower));
    };

    const isDubbedLang = (item) => {
      if (!isLangSelected) return false;
      const langs = itemLanguages.get(`${item.type}_${item.tmdbId}`);
      if (!langs) return false;
      return langs.dubLangs.some(l => l.includes(langLower));
    };

    const supportsLang = (item) => {
      if (!isLangSelected) return true;
      return isNativeLang(item) || isDubbedLang(item);
    };

    // Helper to sort a list of items putting preferred language first
    const sortPreferredFirst = (items) => {
      if (!isLangSelected) return items;
      const sorted = [...items];
      sorted.sort((a, b) => {
        const aSupports = supportsLang(a);
        const bSupports = supportsLang(b);
        if (aSupports && !bSupports) return -1;
        if (!aSupports && bSupports) return 1;
        return 0;
      });
      return sorted;
    };

    // 3. Reconstruct Category Rails
    const filteredRails = [];

    // 1. Trending Now (Mixed, preferred lang first)
    const rawTrending = getItemsFromOriginalMatches(data.rails, ['trending', 'top 10', 'popular']);
    const trendingItems = sortPreferredFirst(rawTrending.length > 0 ? rawTrending : itemsList).slice(0, 15);
    filteredRails.push({
      key: 'trending',
      title: 'Trending Now',
      ranked: true,
      items: trendingItems
    });

    // 2. New Releases (Mixed, preferred lang first)
    const rawNew = getItemsFromOriginalMatches(data.rails, ['newest', 'latest', 'hot new', 'fresh']);
    const newItems = sortPreferredFirst(rawNew.length > 0 ? rawNew : itemsList).slice(0, 15);
    filteredRails.push({
      key: 'new_releases',
      title: 'New Releases',
      ranked: false,
      items: newItems
    });

    // Language specific rails (only shown if a language is selected)
    if (isLangSelected) {
      // 3. <Language> Movies (Native only)
      const nativeMovies = itemsList
        .filter(item => item.type === 'movie' && isNativeLang(item))
        .slice(0, 15);
      if (nativeMovies.length > 0) {
        filteredRails.push({
          key: 'native_movies_lang',
          title: `${activeLang} Movies`,
          ranked: false,
          items: nativeMovies
        });
      }

      // 4. <Language> Dubbed Movies (Dubbed only)
      const dubbedMovies = itemsList
        .filter(item => item.type === 'movie' && isDubbedLang(item))
        .slice(0, 15);
      if (dubbedMovies.length > 0) {
        filteredRails.push({
          key: 'dubbed_movies_lang',
          title: `${activeLang} Dubbed Movies`,
          ranked: false,
          items: dubbedMovies
        });
      }

      // 5. <Language> TV Shows (TV shows supporting language)
      const langTV = itemsList
        .filter(item => item.type === 'tv' && supportsLang(item))
        .slice(0, 15);
      if (langTV.length > 0) {
        filteredRails.push({
          key: 'tv_shows_lang',
          title: `${activeLang} TV Shows`,
          ranked: false,
          items: langTV
        });
      }
    }

    // Global Rails:
    // 6. Popular Movies
    const popularMovies = itemsList.filter(item => item.type === 'movie').slice(0, 15);
    filteredRails.push({
      key: 'popular_movies',
      title: 'Popular Movies',
      ranked: false,
      items: popularMovies
    });

    // 7. Top Rated Movies (Sorted by rating)
    const topRatedMovies = [...popularMovies];
    topRatedMovies.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    filteredRails.push({
      key: 'top_rated_movies',
      title: 'Top Rated Movies',
      ranked: false,
      items: topRatedMovies.slice(0, 15)
    });

    // 8. Action Movies
    const actionMovies = getItemsFromOriginalMatches(data.rails, ['action', 'thriller']).filter(item => item.type === 'movie').slice(0, 15);
    filteredRails.push({
      key: 'action_movies',
      title: 'Action Movies',
      ranked: false,
      items: actionMovies.length > 0 ? actionMovies : popularMovies.slice(5, 15)
    });

    // 9. Comedy Movies
    const comedyMovies = getItemsFromOriginalMatches(data.rails, ['comedy', 'romance', 'animation']).filter(item => item.type === 'movie').slice(0, 15);
    filteredRails.push({
      key: 'comedy_movies',
      title: 'Comedy Movies',
      ranked: false,
      items: comedyMovies.length > 0 ? comedyMovies : popularMovies.slice(7, 17)
    });

    // 10. Popular TV Shows
    const popularTV = itemsList.filter(item => item.type === 'tv').slice(0, 15);
    filteredRails.push({
      key: 'popular_tv',
      title: 'Popular TV Shows',
      ranked: false,
      items: popularTV
    });

    res.json({
      ok: true,
      tab: data.tab,
      hero: sortPreferredFirst(data.hero || []).slice(0, 5),
      rails: filteredRails
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch trending catalog');
  }
});

// Helper function to extract items from original rails matching keywords
function getItemsFromOriginalMatches(rails, keywords) {
  const items = [];
  const seen = new Set();
  if (rails) {
    rails.forEach(rail => {
      const title = rail.title.toLowerCase();
      if (keywords.some(kw => title.includes(kw))) {
        if (rail.items) {
          rail.items.forEach(item => {
            const key = `${item.type}_${item.tmdbId}`;
            if (!seen.has(key)) {
              seen.add(key);
              items.push(item);
            }
          });
        }
      }
    });
  }
  return items;
}

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
    const data = await sourceManager.search(q.trim(), parseInt(page) || 1);
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Search failed');
  }
});

/**
 * GET /api/catalog/trailer/:type/:tmdbId
 *
 * Returns a YouTube trailer key from TMDB (requires TMDB_API_KEY in env).
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
    const response = await axios.get(
      `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/videos`,
      { params: { api_key: apiKey }, timeout: 10000 },
    );

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
    const data = await sourceManager.details(type, parseInt(tmdbId));
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
