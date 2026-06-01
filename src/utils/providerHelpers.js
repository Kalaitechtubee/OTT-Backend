function hasSearchResults(data) {
  const items = data?.results || data?.items || (Array.isArray(data) ? data : null);
  return Array.isArray(items) && items.length > 0;
}

function hasStreams(data) {
  if (!data || data.ok === false || data.success === false) return false;
  if (data.playlist === null) return false;
  if (Array.isArray(data.sources) && data.sources.length === 0) return false;
  if (Array.isArray(data.streams) && data.streams.length === 0) return false;
  
  if (Array.isArray(data)) {
    if (data.length === 0) return false;
    return data.some(item => {
      if (!item) return false;
      if (item.url || item.file) return true;
      if (Array.isArray(item.sources) && item.sources.length > 0) {
        return item.sources.some(src => src && (src.file || src.url));
      }
      if (Array.isArray(item.streams) && item.streams.length > 0) {
        return item.streams.some(st => st && (st.url || st.file));
      }
      return false;
    });
  }
  
  return Boolean(data.mp4 || (Array.isArray(data.streams) && data.streams.length > 0) || (Array.isArray(data.sources) && data.sources.length > 0));
}

function hasLanguages(data) {
  if (!data || data.ok === false || data.success === false) return false;
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
