// TMDB API base URL — using api.tmdb.org which is accessible even when api.themoviedb.org is regionally blocked
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.tmdb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

if (!TMDB_API_KEY) {
  console.warn('[TMDB Config] ⚠️  TMDB_API_KEY is not set! Poster/rating/metadata enrichment will be skipped.');
} else {
  console.log(`[TMDB Config] ✅ TMDB_API_KEY loaded (${TMDB_API_KEY.substring(0, 6)}...) → ${TMDB_BASE_URL}`);
}

module.exports = {
  TMDB_BASE_URL,
  TMDB_API_KEY,
};
