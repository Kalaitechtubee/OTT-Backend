const fs = require('fs');
const path = require('path');
const registry = require('./sourceRegistry');
const { adaptProvider } = require('../utils/providerHelpers');
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
    console.warn('[SearchResolver] Failed to load provider-config.json:', e.message);
  }
  return {
    multiSourceSearch: false,
    enabled: { net27: true, net52: true, net11: false, moviesda: false },
  };
}

function loadPriority() {
  try {
    if (fs.existsSync(PRIORITY_PATH)) {
      return JSON.parse(fs.readFileSync(PRIORITY_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[SearchResolver] Failed to load source-priority.json:', e.message);
  }
  return { search: ['net52', 'net27'] };
}

function getProvider(name) {
  return adaptProvider(registry[name], name);
}

function getEnabledProviders(priorityList = []) {
  const config = loadProviderConfig();
  return priorityList.filter((name) => {
    if (config.enabled?.[name] === false) return false;
    const raw = registry[name];
    if (!raw) return false;
    if (raw.enabled === false) return false;
    return true;
  });
}

/**
 * V1 (multiSourceSearch: false): DEFAULT_PROVIDER only.
 * V2: try sources in priority order until results are found.
 */
async function search(query, page = 1) {
  const config = loadProviderConfig();
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.search || [DEFAULT_PROVIDER || 'net27']);

  if (!config.multiSourceSearch || chain.length <= 1) {
    const primary = chain[0] || DEFAULT_PROVIDER || 'net27';
    const provider = getProvider(primary);
    if (!provider) throw new Error(`Provider "${primary}" is not registered`);
    
    const data = await provider.search(query, page);
    const adapt = adapters[primary]?.adaptSearch || ((x) => x);
    return {
      success: true,
      provider: primary,
      results: adapt(data)
    };
  }

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      const data = await provider.search(query, page);
      if (provider.hasSearchResults(data)) {
        console.log(`[SearchResolver] Hit on ${name} for "${query}"`);
        const adapt = adapters[name]?.adaptSearch || ((x) => x);
        return {
          success: true,
          provider: name,
          results: adapt(data)
        };
      }
    } catch (e) {
      console.warn(`[SearchResolver] ${name} failed for "${query}":`, e.message);
    }
  }

  return { success: false, provider: null, results: [] };
}

module.exports = { search, getProvider, getEnabledProviders, loadPriority };
