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
 * Try sources in priority order until streams are found.
 * If a provider errors or returns empty streams, fall through to the next.
 */
async function resolve(tmdbId, opts = {}) {
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.play || ['net52', 'net27']);

  let lastError = null;

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      console.log(`[PlayResolver] Trying provider ${name} for tmdbId=${tmdbId}`);
      const data = await provider.streams(tmdbId, opts);
      const adapt = adapters[name]?.adaptStreams || ((x) => x);
      const adapted = adapt(data);

      // Check if we got usable streams (adapted format: { streams: [...], subtitles: [...] })
      const hasUsableStreams = adapted?.streams?.length > 0;

      // Also check raw data format
      const hasRawStreams = provider.hasStreams(data);

      if (hasUsableStreams || hasRawStreams) {
        console.log(`[PlayResolver] ✅ Streams from ${name} for tmdbId=${tmdbId} (${adapted?.streams?.length || 0} streams)`);
        return {
          success: true,
          provider: name,
          streams: adapted.streams || [],
          subtitles: adapted.subtitles || []
        };
      }

      console.warn(`[PlayResolver] ${name} returned no streams for tmdbId=${tmdbId}, trying next...`);
    } catch (e) {
      lastError = e;
      console.warn(`[PlayResolver] ${name} failed for tmdbId=${tmdbId}: ${e.message}, trying next...`);
    }
  }

  if (lastError) {
    console.warn(`[PlayResolver] All providers failed for tmdbId=${tmdbId}. Last error:`, lastError.message);
  }
  return { success: false, provider: null, streams: [], subtitles: [] };
}

module.exports = { resolve, loadPriority };
