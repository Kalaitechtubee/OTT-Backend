const {
  net11Request,
  buildHeaders,
  USER_AGENT,
  getNet11Domain,
  getNet52Domain
} = require('../utils/axiosClient');
const { resolvePlaylistWithFallbacks, hasValidToken } = require('../utils/playlistResolver');

/**
 * Normalize a URL that might be relative (/path or path) to absolute.
 */
function toAbsolute(url, domain) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  // protocol-relative: //host/path
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${domain}${url}`;
  try {
    return new URL(url, domain).toString();
  } catch (_err) {
    return url;
  }
}

/**
 * Map provider source label → quality string.
 */
function labelToQuality(label) {
  if (!label) return 'Auto';
  const l = String(label).toLowerCase();
  if (l.includes('full')) return '1080p';
  if (l.includes('mid')) return '720p';
  if (l.includes('low')) return '480p';
  if (l.includes('auto')) return 'Auto';
  return label;
}

/**
 * Parse subtitle/caption tracks from provider tracks[].
 */
function parseTracks(tracks, domain) {
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter(t => t && t.file && t.kind === 'captions')
    .map(t => ({
      kind: t.kind,
      label: t.label || t.language || 'Unknown',
      language: t.language || '',
      url: toAbsolute(t.file, domain)
    }));
}

module.exports = {
  provider: 'net11',

  async search(query, clientHeaders = {}) {
    try {
      const res = await net11Request({
        method: 'GET',
        url: `/search.php`,
        params: { s: query, t: Math.floor(Date.now() / 1000) },
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      }, clientHeaders);

      const items = res.data?.searchResult || res.data?.results || [];
      return items.map(item => ({
        id: String(item.id || ''),
        title: item.t || item.title || 'Untitled',
        year: String(item.y || item.year || ''),
        provider: 'net11'
      }));
    } catch (err) {
      console.error(`[Net11 Provider] Search failed:`, err.message);
      return [];
    }
  },

  async details(id, clientHeaders = {}) {
    try {
      const res = await net11Request({
        method: 'GET',
        url: `/post.php`,
        params: { id, t: Math.floor(Date.now() / 1000) }
      }, clientHeaders);

      const data = res.data;
      if (!data || data.status === 'n' || data.error) {
        console.warn(`[Net11 Provider] Details returned invalid status for ID ${id}:`, data?.error || 'Invalid User');
        return null;
      }

      return {
        id: String(id),
        title: data.title || data.t || '',
        year: String(data.year || data.y || ''),
        description: data.desc || data.description || '',
        director: data.director || '',
        genre: data.genre || '',
        runtime: data.runtime || '',
        cast: data.cast || '',
        languages: data.lang || [],
        provider: 'net11'
      };
    } catch (err) {
      console.error(`[Net11 Provider] Details failed for ID ${id}:`, err.message);
      return null;
    }
  },

  async stream(id, clientHeaders = {}) {
    try {
      // Step 1: POST play.php to get the play token + title hint
      const playRes = await net11Request({
        method: 'POST',
        url: `/play.php`,
        data: `id=${id}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        }
      }, clientHeaders);

      const playToken = playRes.data?.h;
      if (!playToken) {
        console.error(`[Net11 Provider] Failed to obtain play token for ID ${id}`);
        return { success: false, streams: [], subtitles: [] };
      }

      const ipHash = (() => {
        try {
          return playToken.replace(/^in=/, '').split('::')[0] || '';
        } catch (_e) {
          return '';
        }
      })();

      // Step 2: Fetch enriched playlist JSON from net52.cc (net11 redirects there)
      const net52Domain = await getNet52Domain();
      const net11Domain = await getNet11Domain();
      const now = Math.floor(Date.now() / 1000);

      const upstreamHeaders = buildHeaders('net11', clientHeaders);
      const candidateHeaders = (originDomain) => ({
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${originDomain}/search`,
        'Origin': originDomain,
        ...(upstreamHeaders.Cookie ? { Cookie: upstreamHeaders.Cookie } : {})
      });

      const resolvedPlaylist = await resolvePlaylistWithFallbacks({
        params: { id, t: now, tm: now, h: playToken },
        candidates: [
          { url: `${net52Domain}/pv/playlist.php`, headers: candidateHeaders(net52Domain) },
          { url: `${net52Domain}/playlist.php`, headers: candidateHeaders(net52Domain) },
          { url: `${net11Domain}/pv/playlist.php`, headers: candidateHeaders(net11Domain) },
          { url: `${net11Domain}/playlist.php`, headers: candidateHeaders(net11Domain) }
        ]
      });

      if (!resolvedPlaylist?.entry || !Array.isArray(resolvedPlaylist.entry.sources)) {
        return { success: false, streams: [], subtitles: [] };
      }

      const entry = resolvedPlaylist.entry;
      const playlistOrigin = (() => {
        try {
          return new URL(resolvedPlaylist.candidate.url).origin;
        } catch (_err) {
          return net52Domain;
        }
      })();

      // Step 3: Map sources[] → streams[]
      const streams = entry.sources
        .filter(s => s && s.file)
        .map(s => {
          let fileWithIp = s.file;
          if (ipHash && fileWithIp.includes('in=::')) {
            fileWithIp = fileWithIp.replace('in=::', `in=${ipHash}::`);
          }
          const url = toAbsolute(fileWithIp, playlistOrigin);
          return {
            quality: labelToQuality(s.label),
            label: s.label || 'Auto',
            default: s.default === 'true' || s.default === true,
            url
          };
        })
        // Drop broken/untokenized variants like `in=unknown::ni` so clients never hit 403.
        .filter((s) => hasValidToken(s.url));

      // Step 4: Map tracks[] → subtitles[]
      const subtitles = parseTracks(entry.tracks, playlistOrigin);

      // Step 5: Thumbnail VTT (useful for player seek preview)
      const thumbnailTrack = Array.isArray(entry.tracks)
        ? entry.tracks.find(t => t && t.kind === 'thumbnails')
        : null;

      return {
        success: true,
        provider: 'net11',
        title: entry.title || '',
        poster: entry.image2 ? toAbsolute(entry.image2, playlistOrigin) : null,
        streams,
        subtitles,
        thumbnails: thumbnailTrack ? toAbsolute(thumbnailTrack.file, playlistOrigin) : null,
        debug: {
          playlistSource: resolvedPlaylist?.candidate?.url || null
        }
      };
    } catch (err) {
      console.error(`[Net11 Provider] Stream failed for ID ${id}:`, err.message);
      return { success: false, streams: [], subtitles: [] };
    }
  }
};
