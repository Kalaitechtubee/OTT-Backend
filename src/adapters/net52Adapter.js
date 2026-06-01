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
    description: rawResponse.description || rawResponse.desc || '',
    seasons: rawResponse.seasons || []
  };
}

const providerConfig = require('../config/provider');
const BASE_URL = process.env.NET52_BASE_URL || providerConfig.NET52_BASE_URL || 'https://net52.cc';

function adaptStreams(rawResponse) {
  if (!rawResponse) return { streams: [], subtitles: [] };

  const streams = [];
  const subtitles = [];

  // Parse Net52 playlist array
  if (Array.isArray(rawResponse)) {
    for (const playlist of rawResponse) {
      if (playlist && Array.isArray(playlist.sources)) {
        for (const src of playlist.sources) {
          if (src && src.file) {
            let streamUrl = src.file;
            // Prepend base URL if relative path
            if (streamUrl.startsWith('/')) {
              streamUrl = `${BASE_URL}${streamUrl}`;
            }
            streams.push({
              quality: src.label || 'Auto',
              url: streamUrl
            });
          }
        }
      }
    }
  } else if (rawResponse.streams) {
    // Fallback if Net52 returns { streams: [...] } directly
    const rawStreams = Array.isArray(rawResponse.streams) ? rawResponse.streams : [];
    for (const s of rawStreams) {
      if (s) {
        let streamUrl = s.url || s.file || '';
        if (streamUrl.startsWith('/')) {
          streamUrl = `${BASE_URL}${streamUrl}`;
        }
        streams.push({
          quality: s.quality || s.label || 'Auto',
          url: streamUrl
        });
      }
    }
  }

  // Handle subtitles if present
  const rawSubs = rawResponse.subtitles || [];
  for (const sub of rawSubs) {
    if (sub) {
      let subUrl = sub.url || '';
      if (subUrl.startsWith('/')) {
        subUrl = `${BASE_URL}${subUrl}`;
      }
      subtitles.push({
        language: sub.language || 'English',
        url: subUrl
      });
    }
  }

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
