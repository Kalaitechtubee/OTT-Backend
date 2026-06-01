const fs = require('fs');
const path = require('path');
const { getProvider, getEnabledProviders } = require('./searchResolver');
const { DEFAULT_PROVIDER } = require('../config/provider');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'provider-config.json');
const PRIORITY_PATH = path.join(__dirname, '..', 'data', 'source-priority.json');

function loadProviderConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[LanguageResolver] Failed to load provider-config.json:', e.message);
  }
  return { multiSourceLanguages: false };
}

function loadPriority() {
  try {
    if (fs.existsSync(PRIORITY_PATH)) {
      return JSON.parse(fs.readFileSync(PRIORITY_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[LanguageResolver] Failed to load source-priority.json:', e.message);
  }
  return { languages: ['net52', 'net27'] };
}

/**
 * V1: DEFAULT_PROVIDER only.
 * V2: try sources in priority order until variants are found.
 */
async function resolve(type, tmdbId, opts = {}) {
  const config = loadProviderConfig();
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.languages || [DEFAULT_PROVIDER || 'net27']);

  if (!config.multiSourceLanguages || chain.length <= 1) {
    const primary = chain[0] || DEFAULT_PROVIDER || 'net27';
    const provider = getProvider(primary);
    if (!provider) throw new Error(`Provider "${primary}" is not registered`);
    return provider.languages(type, tmdbId, opts);
  }

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      const data = await provider.languages(type, tmdbId, opts);
      if (provider.hasLanguages(data)) {
        console.log(`[LanguageResolver] Variants from ${name} for ${type}/${tmdbId}`);
        return { ...data, provider: name };
      }
    } catch (e) {
      console.warn(`[LanguageResolver] ${name} failed for ${type}/${tmdbId}:`, e.message);
    }
  }

  return { ok: true, variants: [] };
}

module.exports = { resolve, loadPriority };
