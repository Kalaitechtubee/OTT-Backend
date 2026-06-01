const fs = require('fs');
const path = require('path');
const { getProvider, getEnabledProviders } = require('./searchResolver');
const { DEFAULT_PROVIDER } = require('../config/provider');
const net27Adapter = require('../adapters/net27Adapter');
const net52Adapter = require('../adapters/net52Adapter');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'provider-config.json');
const PRIORITY_PATH = path.join(__dirname, '..', 'data', 'source-priority.json');

const adapters = {
  net27: net27Adapter,
  net52: net52Adapter
};

function loadProviderConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[PlayResolver] Failed to load provider-config.json:', e.message);
  }
  return { multiSourcePlay: false };
}

function loadPriority() {
  try {
    if (fs.existsSync(PRIORITY_PATH)) {
      return JSON.parse(fs.readFileSync(PRIORITY_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[PlayResolver] Failed to load source-priority.json:', e.message);
  }
  return { play: ['net52', 'net27'] };
}

/**
 * V1: DEFAULT_PROVIDER only.
 * V2: try sources in priority order until streams are found.
 */
async function resolve(tmdbId, opts = {}) {
  const config = loadProviderConfig();
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.play || [DEFAULT_PROVIDER || 'net27']);

  if (!config.multiSourcePlay || chain.length <= 1) {
    const primary = chain[0] || DEFAULT_PROVIDER || 'net27';
    const provider = getProvider(primary);
    if (!provider) throw new Error(`Provider "${primary}" is not registered`);

    try {
      const data = await provider.streams(tmdbId, opts);
      const adapt = adapters[primary]?.adaptStreams || ((x) => x);
      const adapted = adapt(data);

      if (provider.hasStreams(data)) {
        return {
          success: true,
          provider: primary,
          streams: adapted.streams || [],
          subtitles: adapted.subtitles || []
        };
      }
      // If primary returned no streams and there are other enabled providers,
      // fall through to try them (useful when multiSourcePlay is disabled).
    } catch (e) {
      console.warn(`[PlayResolver] Primary provider ${primary} failed for tmdbId=${tmdbId}:`, e.message);
      // Continue to try other providers below
    }

    // If we reach here, primary did not yield usable streams — try other providers.
    if (chain.length <= 1) {
      // No other providers available
      return { success: false, provider: null, streams: [], subtitles: [] };
    }
  }

  let lastError = null;

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      const data = await provider.streams(tmdbId, opts);
      if (provider.hasStreams(data)) {
        console.log(`[PlayResolver] Streams from ${name} for tmdbId=${tmdbId}`);
        const adapt = adapters[name]?.adaptStreams || ((x) => x);
        const adapted = adapt(data);
        return {
          success: true,
          provider: name,
          streams: adapted.streams || [],
          subtitles: adapted.subtitles || []
        };
      }
    } catch (e) {
      lastError = e;
      console.warn(`[PlayResolver] ${name} failed for tmdbId=${tmdbId}:`, e.message);
    }
  }

  if (lastError) {
    console.warn(`[PlayResolver] All providers failed for tmdbId=${tmdbId}. Last error:`, lastError.message);
  }
  return { success: false, provider: null, streams: [], subtitles: [] };
}

module.exports = { resolve, loadPriority };
