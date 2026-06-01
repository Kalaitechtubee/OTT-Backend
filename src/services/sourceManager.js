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

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      const data = await provider.details(type, tmdbId);
      if (data) {
        console.log(`[SourceManager] Title details from ${name} for tmdbId=${tmdbId}`);
        const adapt = adapters[name]?.adaptDetails || ((x) => x);
        return {
          success: true,
          provider: name,
          movie: adapt(data)
        };
      }
    } catch (e) {
      console.warn(`[SourceManager] ${name} details failed for tmdbId=${tmdbId}:`, e.message);
    }
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
