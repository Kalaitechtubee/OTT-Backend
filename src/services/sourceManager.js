const registry = require('./sourceRegistry');
const searchResolver = require('./searchResolver');
const playResolver = require('./playResolver');
const languageResolver = require('./languageResolver');
const { adaptProvider } = require('../utils/providerHelpers');
const { DEFAULT_PROVIDER } = require('../config/provider');
const { getEnabledProviders, loadPriority } = require('./searchResolver');
const net27Adapter = require('../adapters/net27Adapter');
const net52Adapter = require('../adapters/net52Adapter');

const adapters = {
  net27: net27Adapter,
  net52: net52Adapter
};

function getProvider(name) {
  return adaptProvider(registry[name], name);
}

async function search(query, page = 1) {
  return searchResolver.search(query, page);
}

async function details(type, tmdbId) {
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.details || ['net52', 'net27']);

  let primaryResult = null;

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      console.log(`[SourceManager] Trying ${name} for details tmdbId=${tmdbId}`);
      const data = await provider.details(type, tmdbId);
      if (!data) {
        console.warn(`[SourceManager] ${name} returned null for tmdbId=${tmdbId}, trying next...`);
        continue;
      }

      const adapt = adapters[name]?.adaptDetails || ((x) => x);
      const movie = adapt(data);

      // Check if the adapted movie has meaningful data (at least a title)
      const hasTitle = movie && movie.title && movie.title.trim().length > 0;

      if (!primaryResult) {
        if (hasTitle) {
          primaryResult = { provider: name, movie };
          console.log(`[SourceManager] ✅ Details primary provider ${name} for tmdbId=${tmdbId}: "${movie.title}"`);
        } else {
          console.warn(`[SourceManager] ${name} returned empty details for tmdbId=${tmdbId}, trying next...`);
          continue;
        }
      } else {
        // Merge missing helpful fields from subsequent providers into the primary movie
        const fieldsToMerge = ['subjectId', 'detailPath', 'seasons', 'languages', 'title', 'overview', 'rating', 'director', 'genres', 'poster', 'backdrop'];
        for (const f of fieldsToMerge) {
          const primaryVal = primaryResult.movie[f];
          const isEmpty = primaryVal === null || primaryVal === undefined || primaryVal === '' ||
            (Array.isArray(primaryVal) && primaryVal.length === 0);
          if (isEmpty && movie[f]) {
            primaryResult.movie[f] = movie[f];
            console.log(`[SourceManager] Merged field ${f} from ${name} into primary details for tmdbId=${tmdbId}`);
          }
        }
      }

      // If primary has all necessary fields, stop early.
      // For TV shows, also require seasons data before breaking — Net27 is usually the
      // only provider that returns season metadata and must not be skipped.
      const hasSubject = primaryResult && primaryResult.movie && (primaryResult.movie.subjectId || primaryResult.movie.detailPath);
      const hasSeasonsData = Array.isArray(primaryResult?.movie?.seasons) && primaryResult.movie.seasons.length > 0;
      if (hasSubject && (type !== 'tv' || hasSeasonsData)) break;
    } catch (e) {
      console.warn(`[SourceManager] ${name} details failed for tmdbId=${tmdbId}: ${e.message}, trying next...`);
    }
  }

  if (primaryResult) {
    // TMDB fallback: if this is a TV show and we still don't have seasons data,
    // fetch season metadata directly from TMDB so the Flutter app can show the season picker.
    if (type === 'tv') {
      const hasSeasonsData = Array.isArray(primaryResult.movie.seasons) && primaryResult.movie.seasons.length > 0;
      if (!hasSeasonsData) {
        try {
          const { TMDB_API_KEY, TMDB_BASE_URL } = require('../config/tmdb');
          if (TMDB_API_KEY) {
            const axios = require('axios');
            const tmdbRes = await axios.get(`${TMDB_BASE_URL}/tv/${tmdbId}`, {
              params: { api_key: TMDB_API_KEY },
              timeout: 8000,
            });
            const tmdbSeasons = tmdbRes.data?.seasons;
            if (Array.isArray(tmdbSeasons) && tmdbSeasons.length > 0) {
              primaryResult.movie.seasons = tmdbSeasons
                .filter(s => s.season_number > 0) // skip "Specials" (season 0)
                .map(s => ({
                  season_number: s.season_number,
                  seasonNumber: s.season_number,
                  episode_count: s.episode_count || 0,
                  episodeCount: s.episode_count || 0,
                  name: s.name || `Season ${s.season_number}`,
                }));
              console.log(`[SourceManager] TMDB fallback: populated ${primaryResult.movie.seasons.length} seasons for tmdbId=${tmdbId}`);
            }
          }
        } catch (tmdbErr) {
          console.warn(`[SourceManager] TMDB seasons fallback failed for tmdbId=${tmdbId}: ${tmdbErr.message}`);
        }
      }
    }

    return { success: true, provider: primaryResult.provider, movie: primaryResult.movie };
  }

  return { success: false, provider: null, movie: null };
}

async function languages(type, tmdbId, opts = {}) {
  return languageResolver.resolve(type, tmdbId, opts);
}

async function play(tmdbId, opts = {}) {
  return playResolver.resolve(tmdbId, opts);
}

module.exports = {
  getProvider,
  search,
  details,
  languages,
  play,
};
