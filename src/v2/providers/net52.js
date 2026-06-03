const { buildHeaders, USER_AGENT, getNet52Domain, getNet11Domain, net52Request, net11Request } = require('../utils/axiosClient');
const { resolvePlaylistWithFallbacks, hasValidToken } = require('../utils/playlistResolver');

function toAbsolute(url, domain) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${domain}${url}`;
  try { return new URL(url, domain).toString(); } catch (_err) { return url; }
}

function labelToQuality(label) {
  if (!label) return 'Auto';
  const l = String(label).toLowerCase();
  if (l.includes('full')) return '1080p';
  if (l.includes('mid')) return '720p';
  if (l.includes('low')) return '480p';
  if (l.includes('auto')) return 'Auto';
  return label;
}

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
  provider: 'net52',

  async search(query, clientHeaders = {}) {
    try {
      const res = await net52Request({
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
        provider: 'net52'
      }));
    } catch (err) {
      console.error(`[Net52 Provider] Search failed:`, err.message);
      return [];
    }
  },

  async details(id, clientHeaders = {}) {
    try {
      const res = await net52Request({
        method: 'GET',
        url: `/pv/post.php`,
        params: { id, t: Math.floor(Date.now() / 1000) }
      }, clientHeaders);

      const data = res.data;
      if (!data || data.status === 'n' || data.error) {
        console.warn(`[Net52 Provider] Details returned invalid status for ID ${id}`);
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
        provider: 'net52'
      };
    } catch (err) {
      console.error(`[Net52 Provider] Details failed for ID ${id}:`, err.message);
      return null;
    }
  },

  async stream(id, clientHeaders = {}) {
    try {
      const domain = await getNet52Domain();
      const net11Domain = await getNet11Domain();
      const now = Math.floor(Date.now() / 1000);

      // Step 1: Query Net11 play.php to get backend IP hash
      let ipHash = '';
      try {
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
        if (playToken) {
          ipHash = playToken.replace(/^in=/, '').split('::')[0] || '';
        }
      } catch (err) {
        console.warn('[Net52 Provider] Failed to obtain IP hash from play.php:', err.message);
      }

      const upstreamHeaders = buildHeaders('net52', clientHeaders);
      const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${domain}/search`,
        'Origin': domain,
        ...(upstreamHeaders.Cookie ? { Cookie: upstreamHeaders.Cookie } : {})
      };

      const resolvedPlaylist = await resolvePlaylistWithFallbacks({
        params: { id, tm: now, t: now },
        candidates: [
          { url: `${domain}/pv/playlist.php`, headers },
          { url: `${domain}/playlist.php`, headers }
        ]
      });

      const entry = resolvedPlaylist?.entry;

      if (!entry || !Array.isArray(entry.sources)) {
        return { success: false, streams: [], subtitles: [] };
      }

      const streams = entry.sources
        .filter(s => s && s.file)
        .map(s => {
          let fileWithIp = s.file;
          if (ipHash && fileWithIp.includes('in=::')) {
            fileWithIp = fileWithIp.replace('in=::', `in=${ipHash}::`);
          }
          const url = toAbsolute(fileWithIp, domain);
          return {
            quality: labelToQuality(s.label),
            label: s.label || 'Auto',
            default: s.default === 'true' || s.default === true,
            url
          };
        })
        // Drop broken/untokenized variants like `in=unknown::ni` so clients never hit 403.
        .filter((s) => hasValidToken(s.url));

      const subtitles = parseTracks(entry.tracks, domain);

      const thumbnailTrack = Array.isArray(entry.tracks)
        ? entry.tracks.find(t => t && t.kind === 'thumbnails')
        : null;

      return {
        success: true,
        provider: 'net52',
        title: entry.title || '',
        poster: entry.image2 ? toAbsolute(entry.image2, domain) : null,
        streams,
        subtitles,
        thumbnails: thumbnailTrack ? toAbsolute(thumbnailTrack.file, domain) : null,
        debug: {
          playlistSource: resolvedPlaylist?.candidate?.url || null
        }
      };
    } catch (err) {
      console.error(`[Net52 Provider] Stream failed for ID ${id}:`, err.message);
      return { success: false, streams: [], subtitles: [] };
    }
  }
};
