const fs = require('fs');
const path = require('path');
const { getProvider, getEnabledProviders } = require('./searchResolver');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'provider-config.json');
const PRIORITY_PATH = path.join(__dirname, '..', 'data', 'source-priority.json');

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
  return { play: ['net27'] };
}

/**
 * V1: net27 only — same as previous sourceManager.play().
 * V2: net27 → net11 → moviesda until streams are found.
 */
async function resolve(tmdbId, opts = {}) {
  const config = loadProviderConfig();
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.play || ['net27']);

  if (!config.multiSourcePlay || chain.length <= 1) {
    const primary = chain[0] || 'net27';
    const provider = getProvider(primary);
    if (!provider) throw new Error(`Provider "${primary}" is not registered`);
    return provider.streams(tmdbId, opts);
  }

  let lastError = null;

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      const data = await provider.streams(tmdbId, opts);
      if (provider.hasStreams(data)) {
        console.log(`[PlayResolver] Streams from ${name} for tmdbId=${tmdbId}`);
        return { ...data, provider: name };
      }
    } catch (e) {
      lastError = e;
      console.warn(`[PlayResolver] ${name} failed for tmdbId=${tmdbId}:`, e.message);
    }
  }

  if (lastError) throw lastError;
  return { ok: false, error: 'No streams found from any provider' };
}

module.exports = { resolve, loadPriority };
