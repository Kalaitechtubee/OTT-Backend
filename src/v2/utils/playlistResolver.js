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

        // Normalize triple-slash URLs: https:///files/... → /files/...
        // These appear in net52 PV playlists where the CDN host is omitted.
        // new URL('https:///files/...') has an empty host and breaks host-validation.
        if (/^https?:\/\/\//.test(variantUrl)) {
          variantUrl = variantUrl.replace(/^https?:\/\//, ''); // → /files/...
        }

        if (!/^https?:\/\//i.test(variantUrl)) {
          variantUrl = new URL(variantUrl, primaryStream.url).toString();
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
