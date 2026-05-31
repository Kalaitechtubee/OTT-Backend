const TMDB_BASE_URL =
  process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

module.exports = {
  TMDB_BASE_URL,
  TMDB_API_KEY,
};
