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
    const { language } = req.query;
    const data = await net27.getCatalog('trending');
    if (!data || !language) {
      return res.json(data);
    }

    const langLower = language.toLowerCase().trim();

    // 1. Collect unique items from hero and rails
    const itemsMap = new Map();
    if (data.hero) {
      data.hero.forEach(h => {
        const key = `${h.type}_${h.tmdbId}`;
        itemsMap.set(key, { tmdbId: h.tmdbId, type: h.type, title: h.title });
      });
    }
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

    // 2. Fetch variants for unique items in parallel
    const itemsList = Array.from(itemsMap.values());
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

    // 3. Filter items matching the language (either original or dub)
    const supportedItems = new Map(); // key -> { item, preferredDubSubjectId }
    const dubbedItems = new Map(); // key -> item
    
    langResults.forEach(({ item, variantsData }) => {
      if (variantsData && variantsData.variants) {
        const match = variantsData.variants.find(
          v => v.language.toLowerCase().includes(langLower)
        );
        if (match) {
          supportedItems.set(`${item.type}_${item.tmdbId}`, {
            item,
            preferredDubSubjectId: match.dubSubjectId || match.sid
          });
          
          if (!match.isOriginal) {
            dubbedItems.set(`${item.type}_${item.tmdbId}`, item);
          }
        }
      }
    });

    // 4. Reconstruct hero banners
    const filteredHero = [];
    if (data.hero) {
      data.hero.forEach(h => {
        const key = `${h.type}_${h.tmdbId}`;
        if (supportedItems.has(key)) {
          filteredHero.push(h);
        }
      });
    }

    // 5. Reconstruct category rails based on preferred language
    const filteredRails = [];

    // 🔥 Trending <Language>
    const trendingItems = [];
    const trendingRail = data.rails ? data.rails.find(r => r.title.toLowerCase().includes('trending') || r.title.toLowerCase().includes('today')) : null;
    if (trendingRail && trendingRail.items) {
      trendingRail.items.forEach(item => {
        if (supportedItems.has(`${item.type}_${item.tmdbId}`)) {
          trendingItems.push(item);
        }
      });
    }
    // If we didn't find items in the trending rail, fallback to any highly rated supported items
    if (trendingItems.length === 0 && data.rails) {
      data.rails.forEach(rail => {
        if (rail.items) {
          rail.items.forEach(item => {
            if (supportedItems.has(`${item.type}_${item.tmdbId}`) && trendingItems.length < 10) {
              trendingItems.push(item);
            }
          });
        }
      });
    }

    if (trendingItems.length > 0) {
      filteredRails.push({
        key: 'trending_lang',
        title: `🔥 Trending in ${language}`,
        ranked: true,
        items: trendingItems.slice(0, 10)
      });
    }

    // 🎬 <Language> Movies
    const langMovies = itemsList
      .filter(item => item.type === 'movie' && supportedItems.has(`${item.type}_${item.tmdbId}`))
      .slice(0, 15);
    if (langMovies.length > 0) {
      filteredRails.push({
        key: 'movies_lang',
        title: `🎬 ${language} Movies`,
        ranked: false,
        items: langMovies
      });
    }

    // 📺 <Language> TV Shows
    const langSeries = itemsList
      .filter(item => item.type === 'tv' && supportedItems.has(`${item.type}_${item.tmdbId}`))
      .slice(0, 15);
    if (langSeries.length > 0) {
      filteredRails.push({
        key: 'series_lang',
        title: `📺 ${language} TV Shows`,
        ranked: false,
        items: langSeries
      });
    }

    // 🎭 <Language> Dubbed Movies
    const langDubbed = Array.from(dubbedItems.values())
      .filter(item => item.type === 'movie')
      .slice(0, 15);
    if (langDubbed.length > 0) {
      filteredRails.push({
        key: 'dubbed_lang',
        title: `🎭 ${language} Dubbed Movies`,
        ranked: false,
        items: langDubbed
      });
    }

    // ⭐ Top Rated <Language>
    const topRatedItems = itemsList
      .filter(item => supportedItems.has(`${item.type}_${item.tmdbId}`))
      .slice(0, 15);
    if (topRatedItems.length > 0) {
      filteredRails.push({
        key: 'top_rated_lang',
        title: `⭐ Top Rated ${language}`,
        ranked: false,
        items: topRatedItems
      });
    }

    // 🆕 New <Language> Releases
    const newItems = [];
    const newRail = data.rails ? data.rails.find(r => r.title.toLowerCase().includes('newest') || r.title.toLowerCase().includes('latest') || r.title.toLowerCase().includes('hot')) : null;
    if (newRail && newRail.items) {
      newRail.items.forEach(item => {
        if (supportedItems.has(`${item.type}_${item.tmdbId}`)) {
          newItems.push(item);
        }
      });
    }
    if (newItems.length > 0) {
      filteredRails.push({
        key: 'new_lang',
        title: `🆕 New ${language} Releases`,
        ranked: false,
        items: newItems.slice(0, 15)
      });
    }

    res.json({
      ok: true,
      tab: data.tab,
      hero: filteredHero.length > 0 ? filteredHero : data.hero,
      rails: filteredRails.length > 0 ? filteredRails : data.rails
    });
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
