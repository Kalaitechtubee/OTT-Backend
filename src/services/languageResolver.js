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
 * Try sources in priority order until language variants are found.
 * If a provider errors or returns no variants, fall through to the next.
 */
async function resolve(type, tmdbId, opts = {}) {
  const priority = loadPriority();
  const chain = getEnabledProviders(priority.languages || [DEFAULT_PROVIDER || 'net27']);

  for (const name of chain) {
    const provider = getProvider(name);
    if (!provider) continue;

    try {
      console.log(`[LanguageResolver] Trying provider ${name} for ${type}/${tmdbId}`);
      const data = await provider.languages(type, tmdbId, opts);
      if (provider.hasLanguages(data)) {
        console.log(`[LanguageResolver] ✅ Variants from ${name} for ${type}/${tmdbId} (${data?.variants?.length || 0} variants)`);
        return { ...data, provider: name };
      }
      console.warn(`[LanguageResolver] ${name} returned no variants for ${type}/${tmdbId}, trying next...`);
    } catch (e) {
      console.warn(`[LanguageResolver] ${name} failed for ${type}/${tmdbId}: ${e.message}, trying next...`);
    }
  }

  return { ok: true, variants: [] };
}

module.exports = { resolve, loadPriority };
