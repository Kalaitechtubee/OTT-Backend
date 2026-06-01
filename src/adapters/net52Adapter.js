function adaptSearchItem(item) {
  if (!item) return null;
  return {
    id: String(item.id || ''),
    title: item.t || 'Untitled',
    year: String(item.y || ''),
    runtime: item.r || null,
    type: item.r === 'Series' ? 'series' : 'movie',
    poster: item.poster || null
  };
}

function adaptSearch(rawResponse) {
  const items = Array.isArray(rawResponse) ? rawResponse : (rawResponse?.results || []);
  return items.map(adaptSearchItem).filter(Boolean);
}

function adaptDetails(rawResponse) {
  if (!rawResponse) return null;
  return {
    id: String(rawResponse.id || ''),
    title: rawResponse.title || rawResponse.t || '',
    year: String(rawResponse.year || rawResponse.y || ''),
    runtime: rawResponse.runtime || rawResponse.r || null,
    rating: rawResponse.rating ? `IMDb ${rawResponse.rating}` : null,
    director: rawResponse.director || rawResponse.d || null,
    genres: rawResponse.genres || rawResponse.g || [],
    languages: rawResponse.languages || rawResponse.l || [],
    description: rawResponse.description || rawResponse.desc || ''
  };
}

function adaptStreams(rawResponse) {
  if (!rawResponse) return { streams: [], subtitles: [] };
  const rawStreams = Array.isArray(rawResponse) ? rawResponse : (rawResponse.streams || []);
  const streams = rawStreams.map(s => ({
    quality: s.quality || 'Auto',
    url: s.url || ''
  }));
  const rawSubs = rawResponse.subtitles || [];
  const subtitles = rawSubs.map(sub => ({
    language: sub.language || 'English',
    url: sub.url || ''
  }));
  return {
    streams,
    subtitles
  };
}

module.exports = {
  adaptSearch,
  adaptDetails,
  adaptStreams
};
