const net52 = require('../providers/net52');

function adaptSearchItem(item) {
  if (!item) return null;
  return {
    id: String(item.id || ''),
    title: item.t || item.title || 'Untitled',
    year: String(item.y || item.year || ''),
    runtime: item.r || item.runtime || null,
    type: item.r === 'Series' || item.type === 'series' || item.type === 'tv' ? 'series' : 'movie',
    poster: item.poster || item.img || null
  };
}

function adaptSearch(rawResponse) {
  // Net52 returns results under `searchResult` key
  const items = Array.isArray(rawResponse)
    ? rawResponse
    : (rawResponse?.searchResult || rawResponse?.results || rawResponse?.items || []);
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
    // Use `overview` as the key so frontend movieFromJson picks it up
    overview: rawResponse.description || rawResponse.desc || rawResponse.overview || '',
    // Net52 doesn't provide these, but include them so sourceManager can merge from Net27
    subjectId: rawResponse.subjectId || null,
    detailPath: rawResponse.detailPath || null,
    seasons: rawResponse.seasons || [],
    // Poster/backdrop for frontend compatibility
    poster: rawResponse.poster || rawResponse.img || null,
    backdrop: rawResponse.backdrop || null,
  };
}

/**
 * Parse a quality label like "720p", "1080p", "Auto" into a numeric resolution.
 */
function parseResolution(label) {
  if (!label) return 0;
  if (typeof label === 'number') return label;
  const match = String(label).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function adaptStreams(rawResponse) {
  if (!rawResponse) return { streams: [], subtitles: [] };

  const streams = [];
  const subtitles = [];
  const baseUrl = net52.getActiveDomainSync();

  // Parse Net52 playlist array
  if (Array.isArray(rawResponse)) {
    for (const playlist of rawResponse) {
      if (playlist && Array.isArray(playlist.sources)) {
        for (const src of playlist.sources) {
          if (src && src.file) {
            let streamUrl = src.file;
            // Prepend base URL if relative path
            if (streamUrl.startsWith('/')) {
              streamUrl = `${baseUrl}${streamUrl}`;
            }
            const resolution = parseResolution(src.label);
            streams.push({
              quality: src.label || 'Auto',
              url: streamUrl,
              resolution: resolution,
              size: src.size || 0
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
          streamUrl = `${baseUrl}${streamUrl}`;
        }
        const resolution = parseResolution(s.label || s.quality || s.resolution);
        streams.push({
          quality: s.quality || s.label || 'Auto',
          url: streamUrl,
          resolution: resolution,
          size: s.size || 0
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
        subUrl = `${baseUrl}${subUrl}`;
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
