const axios = require('axios');
const { TMDB_BASE_URL, TMDB_API_KEY } = require('../../config/tmdb');

const client = axios.create({
  baseURL: TMDB_BASE_URL,
  timeout: 8000,
  params: {
    api_key: TMDB_API_KEY
  }
});

function cleanTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // remove special chars
    .trim();
}

/**
 * Searches TMDB and returns the best matching movie or show.
 */
async function findMatch(title, year = '') {
  if (!TMDB_API_KEY) {
    console.warn('[TMDB Service] No TMDB_API_KEY configured');
    return null;
  }

  try {
    const res = await client.get('/search/multi', {
      params: { query: title }
    });

    const results = res.data?.results || [];
    const mediaResults = results.filter(item => item.media_type === 'movie' || item.media_type === 'tv');

    if (mediaResults.length === 0) return null;

    const cleanedSearchTitle = cleanTitle(title);
    const searchYear = String(year || '').substring(0, 4);

    let bestMatch = null;
    let highestScore = -1;

    for (const item of mediaResults) {
      const itemTitle = item.title || item.name || '';
      const cleanedItemTitle = cleanTitle(itemTitle);
      const itemDate = item.release_date || item.first_air_date || '';
      const itemYear = itemDate.substring(0, 4);

      let score = 0;

      // 1. Title Similarity
      if (cleanedSearchTitle === cleanedItemTitle) {
        score += 100;
      } else if (cleanedItemTitle.includes(cleanedSearchTitle) || cleanedSearchTitle.includes(cleanedItemTitle)) {
        score += 50;
      }

      // 2. Year Match
      if (searchYear && itemYear === searchYear) {
        score += 80;
      } else if (searchYear && Math.abs(parseInt(itemYear) - parseInt(searchYear)) <= 1) {
        score += 30;
      }

      // 3. Popularity Tiebreaker
      score += (item.popularity || 0) / 100;

      if (score > highestScore) {
        highestScore = score;
        bestMatch = item;
      }
    }

    // Only accept match if it meets a minimum score (e.g. title matched or year + substring match)
    if (highestScore > 40 && bestMatch) {
      return {
        tmdbId: bestMatch.id,
        mediaType: bestMatch.media_type,
        title: bestMatch.title || bestMatch.name,
        overview: bestMatch.overview,
        posterPath: bestMatch.poster_path ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}` : null,
        backdropPath: bestMatch.backdrop_path ? `https://image.tmdb.org/t/p/original${bestMatch.backdrop_path}` : null,
        rating: bestMatch.vote_average ? `TMDB ${bestMatch.vote_average.toFixed(1)}` : null,
        year: (bestMatch.release_date || bestMatch.first_air_date || '').substring(0, 4)
      };
    }

    return null;
  } catch (err) {
    console.error(`[TMDB Service] Search failed for "${title}":`, err.message);
    return null;
  }
}

/**
 * Retrieves supplementary details like trailers and cast list for a specific TMDB ID.
 */
async function getAssets(tmdbId, mediaType) {
  if (!TMDB_API_KEY || !tmdbId) return null;

  const typePath = mediaType === 'tv' ? 'tv' : 'movie';
  const assets = {
    trailer: null,
    cast: [],
    recommendations: []
  };

  try {
    // 1. Fetch Videos (Trailers)
    const videoRes = await client.get(`/${typePath}/${tmdbId}/videos`).catch(() => null);
    if (videoRes?.data?.results) {
      const videos = videoRes.data.results;
      const trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                      videos.find(v => v.site === 'YouTube' && v.type === 'Teaser') ||
                      videos.find(v => v.site === 'YouTube');
      if (trailer?.key) {
        assets.trailer = `https://www.youtube.com/watch?v=${trailer.key}`;
      }
    }

    // 2. Fetch Credits (Cast)
    const creditsRes = await client.get(`/${typePath}/${tmdbId}/credits`).catch(() => null);
    if (creditsRes?.data?.cast) {
      assets.cast = creditsRes.data.cast.slice(0, 10).map(c => ({
        name: c.name,
        character: c.character,
        profilePath: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
      }));
    }

    // 3. Fetch Recommendations
    const recsRes = await client.get(`/${typePath}/${tmdbId}/recommendations`).catch(() => null);
    if (recsRes?.data?.results) {
      assets.recommendations = recsRes.data.results.slice(0, 6).map(r => ({
        id: r.id,
        title: r.title || r.name || 'Untitled',
        posterPath: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
        mediaType: r.media_type || (mediaType === 'tv' ? 'tv' : 'movie')
      }));
    }

    return assets;
  } catch (err) {
    console.error(`[TMDB Service] Failed to load assets for tmdbId ${tmdbId}:`, err.message);
    return assets;
  }
}

module.exports = {
  findMatch,
  getAssets
};
