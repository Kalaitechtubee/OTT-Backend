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
      const data = await provider.details(type, tmdbId);
      if (data) {
        console.log(`[SourceManager] Title details from ${name} for tmdbId=${tmdbId}`);
        const adapt = adapters[name]?.adaptDetails || ((x) => x);
        const movie = adapt(data);

        if (!primaryResult) {
          primaryResult = { provider: name, movie };
          console.log(`[SourceManager] Details primary provider ${name} for tmdbId=${tmdbId}`);
        } else {
          // Merge missing helpful fields from subsequent providers into the primary movie
          const fieldsToMerge = ['subjectId', 'detailPath', 'seasons', 'languages'];
          for (const f of fieldsToMerge) {
            if ((primaryResult.movie[f] === null || primaryResult.movie[f] === undefined || (Array.isArray(primaryResult.movie[f]) && primaryResult.movie[f].length === 0)) && movie[f]) {
              primaryResult.movie[f] = movie[f];
              console.log(`[SourceManager] Merged field ${f} from ${name} into primary details for tmdbId=${tmdbId}`);
            }
          }
        }

        // If primary has all necessary fields, stop early
        const hasSubject = primaryResult && primaryResult.movie && (primaryResult.movie.subjectId || primaryResult.movie.detailPath);
        if (hasSubject) break;
      }
    } catch (e) {
      console.warn(`[SourceManager] ${name} details failed for tmdbId=${tmdbId}:`, e.message);
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
