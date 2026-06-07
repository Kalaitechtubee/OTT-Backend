const axios = require('axios');

function hasValidToken(fileUrl = '') {
  const value = String(fileUrl || '');
  return value.includes('in=') && !value.includes('in=unknown::ni');
}

/**
 * Check if a source URL has ANY token (including the 'unknown' placeholder).
 * Used during playlist candidate selection — placeholder tokens are replaced
 * with the real play.php token later in the provider code.
 */
function hasTokenOrPlaceholder(fileUrl = '') {
  const value = String(fileUrl || '');
  return value.includes('in=');
}

function getEntry(data) {
  return Array.isArray(data) ? data[0] : data;
}

function isValidPlaylistData(data) {
  const entry = getEntry(data);
  if (!entry || !Array.isArray(entry.sources) || entry.sources.length === 0) {
    return false;
  }

  // Accept sources with any token including 'unknown' placeholder.
  // The provider code will inject the real token before streaming.
  return entry.sources.some((source) => hasTokenOrPlaceholder(source?.file || ''));
}

async function resolvePlaylistWithFallbacks({
  candidates = [],
  params = {},
  timeout = 12000
}) {
  for (const candidate of candidates) {
    try {
      const response = await axios({
        method: 'GET',
        url: candidate.url,
        params,
        headers: candidate.headers || {},
        timeout
      });

      // ─── DIAGNOSTIC: Raw playlist candidate response ───
      const rawEntry = getEntry(response?.data);
      if (rawEntry?.sources) {
        console.log(`[PlaylistResolver DIAG] Candidate ${candidate.url} returned ${rawEntry.sources.length} source(s):`);
        rawEntry.sources.forEach((s, i) => {
          console.log(`[PlaylistResolver DIAG]   source[${i}]: ${s.file}`);
        });
      } else {
        console.log(`[PlaylistResolver DIAG] Candidate ${candidate.url} returned NO sources. Data keys:`, response?.data ? Object.keys(getEntry(response.data) || {}) : 'null');
      }

      if (isValidPlaylistData(response?.data)) {
        return {
          candidate,
          data: response.data,
          entry: getEntry(response.data)
        };
      }
    } catch (_err) {
      // Fallback to next candidate.
    }
  }

  return null;
}

/**
 * Fetches an HLS master playlist (if streams contains exactly one auto-quality m3u8),
 * parses any #EXT-X-STREAM-INF variant playlists, and returns the expanded quality list.
 */
async function expandMasterPlaylist(streams, headers = {}) {
  if (!Array.isArray(streams) || streams.length !== 1) {
    return streams;
  }

  const primaryStream = streams[0];
  if (!primaryStream.url || !primaryStream.url.includes('.m3u8')) {
    return streams;
  }

  try {
    console.log(`[PlaylistResolver] Fetching HLS master playlist to expand qualities: ${primaryStream.url.split('?')[0]}`);
    const response = await axios({
      method: 'GET',
      url: primaryStream.url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        ...headers
      },
      timeout: 6000
    });

    const body = response.data;

    // ─── DIAGNOSTIC: Raw master playlist contents ───
    console.log(`[PlaylistResolver DIAG] Master playlist RAW content (${primaryStream.url.split('?')[0]}):`);
    console.log('--- BEGIN M3U8 ---');
    console.log(body);
    console.log('--- END M3U8 ---');
    if (typeof body === 'string' && body.includes('220884')) {
      console.warn(`[PlaylistResolver DIAG] ⚠️ ANTI-ABUSE: Master playlist contains 'files/220884'!`);
    }

    if (typeof body !== 'string' || !body.includes('#EXTM3U')) {
      return streams;
    }

    const resolvedCdnHostsCache = global.resolvedCdnHostsCache || new Map();
    const movieId = (() => {
      const match = primaryStream.url.match(/\/hls\/([^/.]+)/i) || body.match(/\/files\/([^/]+)/i);
      return match ? match[1] : null;
    })();

    const cdnBase = (() => {
      if (movieId && resolvedCdnHostsCache.has(movieId)) {
        console.log(`[PlaylistResolver] Using cached CDN base host ${resolvedCdnHostsCache.get(movieId)} for movie ${movieId}`);
        return `https://${resolvedCdnHostsCache.get(movieId)}`;
      }
      if (typeof body === 'string') {
        const m = body.match(/https:\/\/(s\d+\.freecdn\d+\.top|s\d+\.nm-cdn\d+\.top|[^/]+\.nfmirrorcdn\.top|[^/]+\.freecdn\d+\.top)/i);
        if (m) return `https://${m[1]}`;
      }
      return 'https://s21.freecdn4.top';
    })();

    // Detect if primary stream comes from a provider domain and extract its movie ID
    const PROVIDER_DOMAINS_RE = /^(?:net52|net11|net22)\.cc$/i;
    const isProviderPrimaryStream = (() => {
      try { return PROVIDER_DOMAINS_RE.test(new URL(primaryStream.url).hostname); }
      catch (_e) { return false; }
    })();
    const providerStreamMovieId = (() => {
      try {
        const m = new URL(primaryStream.url).pathname.match(/\/(?:pv\/)?hls\/([^/?]+)\.m3u8/i);
        return m ? m[1] : null;
      } catch (_e) { return null; }
    })();
    const providerStreamBase = (() => {
      try {
        const u = new URL(primaryStream.url);
        return `${u.protocol}//${u.hostname}`;
      } catch (_e) { return null; }
    })();
    const providerStreamHlsPrefix = (() => {
      try { return new URL(primaryStream.url).pathname.startsWith('/pv/') ? '/pv' : ''; }
      catch (_e) { return ''; }
    })();
    // Extract the in= token from the primary stream URL
    const providerStreamToken = (() => {
      try {
        const t = new URL(primaryStream.url).searchParams.get('in') || '';
        return t.replace(/^in=/, '');
      } catch (_e) { return ''; }
    })();

    const lines = body.split(/\r?\n/);
    const expanded = [
      {
        ...primaryStream,
        quality: 'Auto',
        label: primaryStream.label || 'Auto',
        default: true
      }
    ];

    let currentResolution = '';
    let currentBandwidth = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
        currentResolution = resMatch ? resMatch[1] : '';
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        currentBandwidth = bwMatch ? bwMatch[1] : '';
      } else if (line && !line.startsWith('#')) {
        let variantUrl = line;
        const isHostlessVariant = /^https?:\/\/\//.test(variantUrl) ||
                                  (/\/files\//.test(variantUrl) && !/^https?:\/\/[^/]+\//.test(variantUrl));

        if (isHostlessVariant && isProviderPrimaryStream && providerStreamMovieId && providerStreamBase) {
          // Route through provider quality endpoint instead of guessing CDN host
          const qualityMatch = variantUrl.match(/\/(1080p|720p|480p|360p|240p)(?:\/|\.m3u8)/i);
          if (qualityMatch) {
            const q = qualityMatch[1].toLowerCase();
            const tokenSuffix = providerStreamToken ? `&in=${providerStreamToken}` : '';
            variantUrl = `${providerStreamBase}${providerStreamHlsPrefix}/hls/${providerStreamMovieId}.m3u8?q=${q}${tokenSuffix}`;
            console.log(`[PlaylistResolver] Hostless variant → provider quality URL: ?q=${q}`);
          } else {
            // Fallback for unrecognized quality paths: use cdnBase
            variantUrl = variantUrl.replace(/^https?:\/+\/?files\//i, `${cdnBase}/files/`);
          }
        } else if (/^https:\/+\/?files\//i.test(variantUrl)) {
          variantUrl = variantUrl.replace(/^https:\/+\/?files\//i, `${cdnBase}/files/`);
        } else {
          // net52 PV playlists sometimes emit URLs with no CDN host: https:///files/ID/720p/720p.m3u8
          // /^https?:\/\// matches this (only checks two slashes), treating it as absolute — wrong!
          // Strip the bogus scheme+empty-host prefix so it becomes a root-relative path (/files/...)
          // which then gets correctly resolved against the master playlist URL below.
          if (/^https?:\/\/\//.test(variantUrl)) {
            variantUrl = variantUrl.replace(/^https?:\/\//, ''); // https:///files/... → /files/...
          }

          if (!/^https?:\/\//i.test(variantUrl)) {
            variantUrl = new URL(variantUrl, primaryStream.url).toString();
          }
        }

        // Infer resolution label
        let quality = 'Auto';
        if (currentResolution) {
          const height = currentResolution.split('x')[1];
          if (height) {
            quality = `${height}p`;
          }
        } else if (variantUrl.toLowerCase().includes('1080p')) {
          quality = '1080p';
        } else if (variantUrl.toLowerCase().includes('720p')) {
          quality = '720p';
        } else if (variantUrl.toLowerCase().includes('480p')) {
          quality = '480p';
        } else if (variantUrl.toLowerCase().includes('360p')) {
          quality = '360p';
        }

        if (quality !== 'Auto' && !expanded.some(s => s.quality === quality)) {
          expanded.push({
            quality,
            label: quality,
            default: false,
            url: variantUrl
          });
        }

        currentResolution = '';
        currentBandwidth = '';
      }
    }

    if (expanded.length > 1) {
      console.log(`[PlaylistResolver] Successfully expanded master playlist into ${expanded.length} streams:`, expanded.map(e => e.quality));
      return expanded;
    }
  } catch (err) {
    console.warn('[PlaylistResolver] Failed to expand master playlist qualities:', err.message);
  }

  return streams;
}

module.exports = {
  hasValidToken,
  isValidPlaylistData,
  resolvePlaylistWithFallbacks,
  expandMasterPlaylist
};