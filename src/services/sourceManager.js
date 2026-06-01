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

      // If primary has all necessary fields, stop early
      const hasSubject = primaryResult && primaryResult.movie && (primaryResult.movie.subjectId || primaryResult.movie.detailPath);
      if (hasSubject) break;
    } catch (e) {
      console.warn(`[SourceManager] ${name} details failed for tmdbId=${tmdbId}: ${e.message}, trying next...`);
    }
  }

  if (primaryResult) {
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
