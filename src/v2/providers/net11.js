const {
  net11Request,
  buildHeaders,
  USER_AGENT,
  getNet11Domain,
  getNet52Domain
} = require('../utils/axiosClient');
const { resolvePlaylistWithFallbacks, hasValidToken, expandMasterPlaylist } = require('../utils/playlistResolver');

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
        provider: 'net11',
        mediaType: data.type === 't' ? 'tv' : 'movie',
        seasons: data.season || null
      };
    } catch (err) {
      console.error(`[Net11 Provider] Details failed for ID ${id}:`, err.message);
      return null;
    }
  },

  async stream(id, clientHeaders = {}) {
    let playToken = '';
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

      // ─── DIAGNOSTIC: Raw play.php response ───
      console.log(`[Net11 DIAG] play.php RAW response for ID ${id}:`, JSON.stringify(playRes.data, null, 2));

      playToken = playRes.data?.h || '';
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

      // Extract full token value for injection into playlist URLs.
      // play.php returns: "in=HASH1::HASH2::TIMESTAMP::ni::i::"
      // ipHash = just HASH1
      // fullTokenValue = "HASH1::HASH2::TIMESTAMP" (first 3 parts, excludes ::ni::i::)
      const fullTokenValue = (() => {
        try {
          const stripped = playToken.replace(/^in=/, '');
          const parts = stripped.split('::').filter(Boolean);
          // Use first 3 meaningful parts: hash, hash2, timestamp
          // Exclude 'ni', 'i', and empty trailing parts
          const meaningful = parts.filter(p => p !== 'ni' && p !== 'i');
          return meaningful.join('::');
        } catch (_e) {
          return ipHash;
        }
      })();
      console.log(`[Net11 DIAG] ipHash: ${ipHash}`);
      console.log(`[Net11 DIAG] fullTokenValue: ${fullTokenValue}`);

      // Step 2: Fetch enriched playlist JSON from net52.cc (net11 redirects there)
      const net52Domain = await getNet52Domain();
      const net11Domain = await getNet11Domain();
      const now = Math.floor(Date.now() / 1000);

      const upstreamHeaders = buildHeaders('net11', clientHeaders);
      const candidateHeaders = (originDomain) => ({
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${originDomain}/`,
        'Origin': originDomain,
        // Browser-like Sec-Fetch headers — the provider may inspect these
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...(upstreamHeaders.Cookie ? { Cookie: upstreamHeaders.Cookie } : {})
      });

      // IMPORTANT: Non-/pv/ candidates FIRST!
      // Browser uses /playlist.php → returns /hls/ paths → real content
      // /pv/playlist.php → returns /pv/hls/ paths → anti-abuse video (files/220884)
      const resolvedPlaylist = await resolvePlaylistWithFallbacks({
        params: { id, t: now, tm: now, h: playToken.replace(/^in=/, '') },
        candidates: [
          { url: `${net52Domain}/playlist.php`, headers: candidateHeaders(net52Domain) },
          { url: `${net11Domain}/playlist.php`, headers: candidateHeaders(net11Domain) },
          { url: `${net52Domain}/pv/playlist.php`, headers: candidateHeaders(net52Domain) },
          { url: `${net11Domain}/pv/playlist.php`, headers: candidateHeaders(net11Domain) }
        ]
      });

      // ─── DIAGNOSTIC: Raw playlist.php response ───
      console.log(`[Net11 DIAG] playlist.php resolved from: ${resolvedPlaylist?.candidate?.url || 'NONE'}`);
      console.log(`[Net11 DIAG] playlist.php RAW entry:`, JSON.stringify(resolvedPlaylist?.entry, null, 2));
      if (resolvedPlaylist?.entry?.sources) {
        resolvedPlaylist.entry.sources.forEach((s, i) => {
          console.log(`[Net11 DIAG] source[${i}] file URL: ${s.file}`);
          if (s.file && s.file.includes('220884')) {
            console.warn(`[Net11 DIAG] ⚠️ ANTI-ABUSE DETECTED in source[${i}]! Contains files/220884`);
          }
        });
      }

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
      const rawStreams = entry.sources
        .filter(s => s && s.file)
        .map(s => {
          let fileWithIp = String(s.file || '').replace('in=in=', 'in=');
          // Handle /pv/ format: in=::hash::timestamp::ni
          if (ipHash && fileWithIp.includes('in=::')) {
            fileWithIp = fileWithIp.replace('in=::', `in=${ipHash}::`);
          }
          // Handle standard format: in=unknown::ni (placeholder from /playlist.php)
          // CRITICAL: Browser replaces 'unknown::ni' with the full derived token.
          // Using only ipHash (first part) results in anti-abuse video.
          // Try fullTokenValue (hash1::hash2::timestamp) for proper authorization.
          if (fullTokenValue && fileWithIp.includes('in=unknown::ni')) {
            fileWithIp = fileWithIp.replace('in=unknown::ni', `in=${fullTokenValue}`);
          } else if (fullTokenValue && fileWithIp.includes('in=unknown')) {
            fileWithIp = fileWithIp.replace('in=unknown', `in=${fullTokenValue}`);
          }
          const url = toAbsolute(fileWithIp, playlistOrigin);
          return {
            quality: labelToQuality(s.label),
            label: s.label || 'Auto',
            default: s.default === 'true' || s.default === true,
            url
          };
        })
        // Drop broken/untokenized variants that still have 'unknown' after injection
        .filter((s) => hasValidToken(s.url));

      // ─── DIAGNOSTIC: Mapped raw streams ───
      rawStreams.forEach((s, i) => {
        console.log(`[Net11 DIAG] rawStream[${i}] quality=${s.quality} url=${s.url}`);
        if (s.url.includes('220884')) {
          console.warn(`[Net11 DIAG] ⚠️ ANTI-ABUSE in rawStream[${i}]!`);
        }
      });

      // Expand HLS master playlist to discover resolution variant playlists
      const streams = await expandMasterPlaylist(rawStreams, resolvedPlaylist?.candidate?.headers || {});

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
        // Raw play token — forwarded through proxy chain to fix in=unknown::ni
        playToken: playToken.replace(/^in=/, ''),
        debug: {
          playlistSource: resolvedPlaylist?.candidate?.url || null
        }
      };
    } catch (err) {
      console.error(`[Net11 Provider] Stream failed for ID ${id}:`, err.message);
      return { success: false, streams: [], subtitles: [] };
    }
  },

  async getEpisodes(seasonId, seriesId, clientHeaders = {}) {
    try {
      const isNumeric = /^\d+$/.test(seasonId);
      const url = isNumeric ? '/episodes.php' : '/pv/episodes.php';
      const res = await net11Request({
        method: 'GET',
        url,
        params: {
          s: seasonId,
          series: seriesId,
          page: 1
        }
      }, clientHeaders);
      return res.data?.episodes || [];
    } catch (err) {
      console.error(`[Net11 Provider] getEpisodes failed for season ${seasonId}:`, err.message);
      return [];
    }
  }
};
