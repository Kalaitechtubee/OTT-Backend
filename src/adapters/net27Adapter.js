function adaptSearch(rawResponse) {
  const items = Array.isArray(rawResponse) ? rawResponse : (rawResponse?.items || []);
  return items.map(item => ({
    id: String(item.tmdbId || item.subjectId || ''),
    title: item.title || 'Untitled',
    year: String(item.year || ''),
    runtime: null,
    type: item.type === 'tv' ? 'series' : 'movie',
    poster: item.poster || item.poster_path || null
  }));
}

function adaptDetails(rawResponse) {
  if (!rawResponse) return null;
  return {
    id: String(rawResponse.tmdbId || rawResponse.subjectId || ''),
    title: rawResponse.title || '',
    year: String(rawResponse.year || ''),
    runtime: rawResponse.runtime || null,
    rating: rawResponse.rating ? `IMDb ${rawResponse.rating}` : null,
    director: rawResponse.director || null,
    genres: rawResponse.genres || [],
    languages: rawResponse.languages || [],
    description: rawResponse.overview || '',
    subjectId: rawResponse.subjectId || null,
    detailPath: rawResponse.detailPath || null
  };
}

function adaptStreams(rawResponse) {
  if (!rawResponse) return { streams: [], subtitles: [] };
  const streams = (rawResponse.streams || []).map(s => ({
    quality: s.resolution ? `${s.resolution}p` : 'Auto',
    url: s.url
  }));
  if (streams.length === 0 && rawResponse.mp4) {
    streams.push({
      quality: rawResponse.resolution ? `${rawResponse.resolution}p` : 'Auto',
      url: rawResponse.mp4
    });
  }
  return {
    streams,
    subtitles: (rawResponse.subtitles || []).map(sub => ({
      language: sub.language || 'English',
      url: sub.url
    }))
  };
}

module.exports = {
  adaptSearch,
  adaptDetails,
  adaptStreams
};
