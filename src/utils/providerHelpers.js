function hasSearchResults(data) {
  const items = data?.items;
  return Array.isArray(items) && items.length > 0;
}

function hasStreams(data) {
  if (!data || data.ok === false) return false;
  return Boolean(data.mp4 || (Array.isArray(data.streams) && data.streams.length > 0));
}

function hasLanguages(data) {
  return Array.isArray(data?.variants) && data.variants.length > 0;
}

/**
 * Attach resolver helpers to any registered provider.
 * All providers expose search, details, languages, streams (net27 also keeps legacy names).
 */
function adaptProvider(source, name) {
  if (!source) return null;

  return {
    ...source,
    provider: source.provider || name,
    search: source.search || ((q, p) => source.searchTitles(q, p)),
    details: source.details || ((type, id) => source.getTitleDetails(type, id)),
    languages: source.languages || ((type, id, opts) => source.getLanguages(type, id, opts)),
    streams: source.streams || ((id, opts) => source.getStreams(id, opts)),
    hasSearchResults: source.hasSearchResults || hasSearchResults,
    hasStreams: source.hasStreams || hasStreams,
    hasLanguages: source.hasLanguages || hasLanguages,
  };
}

module.exports = {
  adaptProvider,
  hasSearchResults,
  hasStreams,
  hasLanguages,
};
