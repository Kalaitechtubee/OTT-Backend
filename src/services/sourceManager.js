const registry = require('./sourceRegistry');
const searchResolver = require('./searchResolver');
const playResolver = require('./playResolver');
const languageResolver = require('./languageResolver');
const { adaptProvider } = require('../utils/providerHelpers');

/**
 * Single entry point for routes.
 *
 *   routes → sourceManager → resolvers → sourceRegistry → providers/*
 *
 * Multi-source flags in src/data/provider-config.json default to off (V1).
 */

function getProvider(name) {
  return adaptProvider(registry[name], name);
}

async function search(query, page = 1) {
  return searchResolver.search(query, page);
}

async function details(type, tmdbId) {
  const provider = getProvider('net27');
  if (!provider) throw new Error('Provider net27 is not registered');
  return provider.details(type, tmdbId);
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
