const axios = require('axios');
const {
  USER_AGENT,
  buildHeaders,
  getNet11Domain,
  getNet52Domain
} = require('../utils/axiosClient');

const playlistCache = new Map();
const PLAYLIST_CACHE_TTL = 60 * 1000; // 60 seconds

const resolvedCdnHostsCache = global.resolvedCdnHostsCache || new Map();
global.resolvedCdnHostsCache = resolvedCdnHostsCache;

const CDN_CANDIDATES = [
  's13.freecdn2.top',
  's14.freecdn2.top',
  's21.freecdn4.top',
  's20.freecdn1.top',
  's25.freecdn4.top',
  's12.freecdn2.top',
  's23.freecdn4.top',
  's15.freecdn2.top',
  's22.freecdn4.top',
  's24.freecdn4.top',
  's16.freecdn2.top',
  's17.freecdn2.top',
  's18.freecdn2.top',
  's19.freecdn2.top'
];

function extractMovieId(urlStr) {
  if (!urlStr) return null;
  const match = urlStr.match(/\/files\/([^/]+)/i) || urlStr.match(/\/hls\/([^/.]+)/i);
  return match ? match[1] : null;
}

function replaceHost(urlStr, newHost) {
  try {
    const u = new URL(urlStr);
    u.hostname = newHost;
    u.port = '';
    return u.toString();
  } catch (_e) {
    return urlStr.replace(/(https?:\/\/)[^/]+/, `$1${newHost}`);
  }
}

function srtToVtt(srtString) {
  let vtt = srtString.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  vtt = vtt.trim();
  if (!vtt.startsWith('WEBVTT')) {
    vtt = 'WEBVTT\n\n' + vtt;
  }
  return vtt;
}


function getCachedPlaylist(key) {
  const entry = playlistCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    playlistCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedPlaylist(key, data) {
  playlistCache.set(key, {
    data,
    expiry: Date.now() + PLAYLIST_CACHE_TTL
  });
}

function isAllowedProvider(provider) {
  return provider === 'net11' || provider === 'net52';
}

function isAllowedSourceHost(provider, host, primaryHost) {
  const normalized = String(host || '').toLowerCase();
  const allowedPrimaryHosts = new Set([
    String(primaryHost || '').toLowerCase(),
    'net11.cc',
    'net52.cc',
    'net22.cc'
  ]);

  if (allowedPrimaryHosts.has(normalized)) return true;

  // Provider/CDN hosts observed in HLS playlists and tracks.
  const sharedSuffixes = [
    'nm-cdn4.top',
    'nfmirrorcdn.top',
    'subscdn.top',
    'imgcdn.kim',
    'freecdn4.top',
    'freecdn1.top'
  ];

  if (sharedSuffixes.some((suffix) => normalized.endsWith(suffix))) return true;

  // Match any *.freecdn<digits>.top or *.nm-cdn<digits>.top dynamically
  if (/(?:freecdn|nm-cdn)\d+\.top$/i.test(normalized)) return true;

  // Keep provider-specific expansion easy if new mirror families appear.
  if (provider === 'net11' || provider === 'net52') {
    return false;
  }

  return false;
}

function isM3u8Content(contentType = '', url = '') {
  const ct = String(contentType).toLowerCase();
  return ct.includes('application/vnd.apple.mpegurl') ||
    ct.includes('application/x-mpegurl') ||
    /\.m3u8($|\?)/i.test(url);
}

function looksLikeMpegTs(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  // MPEG-TS sync byte is 0x47 every 188 bytes.
  if (buffer.length < 188 * 5) return false;
  if (buffer[0] !== 0x47) return false;
  // Sample a few sync positions for low false-positive rate.
  const syncs = [0, 188, 376, 564, 752];
  return syncs.every((i) => i < buffer.length && buffer[i] === 0x47);
}

function rewritePlaylistBody(playlistBody, provider, sourceUrl, proxyBase, originalRequestedUrl, playToken = '') {
  const sourceToken = (() => {
    try {
      const u1 = new URL(sourceUrl);
      let token = u1.searchParams.get('in') || '';
      if (token && token !== 'unknown::ni') return token.replace(/^in=/, '');

      if (originalRequestedUrl) {
        const u2 = new URL(originalRequestedUrl);
        token = u2.searchParams.get('in') || '';
        if (token && token !== 'unknown::ni') return token.replace(/^in=/, '');
      }

      // Fallback: use the play token forwarded from the stream API.
      // This is the key fix for in=unknown::ni in master â†’ variant playlists.
      const stripped = String(playToken || '').replace(/^in=/, '');
      if (stripped && stripped !== 'unknown::ni') return stripped.replace(/^in=/, '');

      return '';
    } catch (_err) {
      return '';
    }
  })();

  // Extract the canonical movie ID from the source playlist URL
  // e.g. https://net52.cc/pv/hls/81728596.m3u8 â†’ "81728596"
  const correctMovieId = (() => {
    try {
      const m = new URL(sourceUrl).pathname.match(/\/(\d+)\.m3u8/);
      return m ? m[1] : null;
    } catch (_e) {
      return null;
    }
  })();

  // Extract the CDN content ID from variant stream URLs in the playlist body.
  // The CDN uses its own internal ID (e.g. 220884) which is DIFFERENT from the
  // provider movie ID (e.g. 81726031) used in the raw audio track placeholder URL.
  // e.g. https://s21.freecdn4.top/files/220884/1080p/1080p.m3u8 â†’ "220884"
  const cdnContentId = (() => {
    const m = playlistBody.match(/\/files\/([^/]+)\/(?:1080p|720p|480p|\d+p)\//i) ||
              playlistBody.match(/freecdn4\.top\/files\/([^/]+)\//i) ||
              playlistBody.match(/nm-cdn4\.top\/files\/([^/]+)\//i);
    return m ? m[1] : null;
  })();

  // Detect if source URL is from a provider domain (net52.cc / net11.cc)
  // Used to route hostless variant URLs through the provider's quality endpoint
  const PROVIDER_DOMAINS = ['net52.cc', 'net11.cc', 'net22.cc'];
  const isProviderSource = (() => {
    try { return PROVIDER_DOMAINS.includes(new URL(sourceUrl).hostname.toLowerCase()); }
    catch (_e) { return false; }
  })();

  // Extract movie ID from provider source URL — e.g. /pv/hls/0KRGHGZCHKS920ZQGY5LBRF7MA.m3u8 → "0KRGHGZCHKS920ZQGY5LBRF7MA"
  const providerMovieId = (() => {
    try {
      const m = new URL(sourceUrl).pathname.match(/\/(?:pv\/)?hls\/([^/?]+)\.m3u8/i);
      return m ? m[1] : null;
    } catch (_e) { return null; }
  })();

  // Provider base URL (protocol + hostname) — e.g. "https://net52.cc"
  const providerBase = (() => {
    try {
      const u = new URL(sourceUrl);
      return `${u.protocol}//${u.hostname}`;
    } catch (_e) { return null; }
  })();

  // Whether the provider uses the /pv/ path prefix (net52 /pv/hls/) vs root (/hls/)
  const providerHlsPrefix = (() => {
    try {
      return new URL(sourceUrl).pathname.startsWith('/pv/') ? '/pv' : '';
    } catch (_e) { return ''; }
  })();

  // Detect if this proxy hop is ALREADY at a quality endpoint (?q=720p etc.)
  // If so, skip hostless→quality routing to avoid infinite loop:
  // net52.cc/pv/hls/ID.m3u8?q=720p also returns a master playlist with hostless
  // variant URLs — re-routing them back to ?q=720p would loop forever.
  const sourceAlreadyHasQuality = (() => {
    try { return !!new URL(sourceUrl).searchParams.get('q'); }
    catch (_e) { return false; }
  })();

  // When source is a provider quality endpoint, determine if ALL non-comment
  // variant URLs in the playlist body are hostless. Used to suppress unresolvable audio tracks.
  const allVariantsHostless = (() => {
    const variantLines = String(playlistBody).split(/\r?\n/)
      .filter(l => { const t = l.trim(); return t && !t.startsWith('#'); });
    if (!variantLines.length) return false;
    return variantLines.every(l => /^https?:\/\/\//.test(l) || (/\/files\//.test(l) && !/^https?:\/\/[^/]+\//.test(l)));
  })();


  const normalizeToken = (absoluteUrl) => {
    try {
      const u = new URL(absoluteUrl);
      const existingToken = u.searchParams.get('in');
      if (existingToken && existingToken !== 'unknown' && existingToken !== 'unknown::ni') {
        return absoluteUrl;
      }
      if (!sourceToken) return absoluteUrl;
      u.searchParams.delete('in');
      const base = u.toString();
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}in=${sourceToken.replace(/^in=/, '')}`;
    } catch (_err) {
      return absoluteUrl;
    }
  };


  // Determine the CDN base from the source playlist URL's CDN lines
  // We scan the raw playlist for the first freecdn host to use as CDN base
  const cdnBase = (() => {
    const m = playlistBody.match(/https:\/\/(s\d+\.freecdn\d+\.top|s\d+\.nm-cdn\d+\.top|[^/]+\.nfmirrorcdn\.top|[^/]+\.freecdn\d+\.top)/i);
    if (m) return `https://${m[1]}`;
    try {
      const u = new URL(sourceUrl);
      if (u.hostname && u.hostname !== 'files' && !['net52.cc', 'net11.cc', 'net22.cc'].includes(u.hostname.toLowerCase())) {
        return `https://${u.hostname}`;
      }
    } catch (_e) {}
    // Check global cache as fallback
    try {
      const movieId = extractMovieId(sourceUrl);
      if (movieId && resolvedCdnHostsCache.has(movieId)) {
        return `https://${resolvedCdnHostsCache.get(movieId)}`;
      }
    } catch (_e) {}
    return 'https://s21.freecdn4.top';
  })();

  // Propagate the play token into every rewritten sub-URL (variant playlists,
  // segment URLs) so the token is available at every proxy hop.
  const tkParam = playToken ? `&tk=${encodeURIComponent(playToken)}` : '';

  const toProxy = (rawUrl) => {
    try {
      let normalizedUrl = rawUrl;

      // ── EARLY INTERCEPT: hostless/triple-slash variant URLs from provider master playlists ──
      // When net52.cc returns `https:///files/MOVIEID/720p/720p.m3u8` (no CDN host),
      // instead of guessing a CDN hostname (which may 404), route the request back through
      // the provider's own quality endpoint: /pv/hls/MOVIEID.m3u8?q=720p&in=TOKEN
      // GUARD: Only do this if we are NOT already at a quality endpoint — otherwise we
      // loop (the quality endpoint itself returns a master playlist with hostless URLs).
      if (isProviderSource && providerMovieId && providerBase && sourceToken && !sourceAlreadyHasQuality) {
        const isHostless = /^https?:\/\/\//.test(normalizedUrl) ||
                           (/\/files\//.test(normalizedUrl) && !/^https?:\/\/[^/]+\//.test(normalizedUrl));
        if (isHostless) {
          const qualityMatch = normalizedUrl.match(/\/(1080p|720p|480p|360p|240p)(?:\/|\.m3u8)/i);
          if (qualityMatch) {
            const quality = qualityMatch[1].toLowerCase();
            const qualityUrl = `${providerBase}${providerHlsPrefix}/hls/${providerMovieId}.m3u8?q=${quality}&in=${sourceToken}`;
            console.log(`[Stream Proxy] Hostless variant → provider quality endpoint: ${qualityUrl.split('?')[0]}?q=${quality}`);
            return `${proxyBase}?provider=${encodeURIComponent(provider)}&u=${encodeURIComponent(qualityUrl)}${tkParam}`;
          }
        }
      }

      // Fix: triple-slash audio track URLs → use CDN host (not provider domain)
      // https:///files/81728596/a/0/0.m3u8 → https://s21.freecdn4.top/files/81728596/a/0/0.m3u8
      if (/^https:\/+\/?files\//i.test(normalizedUrl)) {
        normalizedUrl = normalizedUrl.replace(/^https:\/+\/?files\//i, `${cdnBase}/files/`);
      } else if (normalizedUrl.startsWith('https:///')) {
        normalizedUrl = normalizedUrl.replace('https:///', '/');
      }

      // Fix: "files" placeholder hostname → CDN host
      try {
        const testUrl = new URL(normalizedUrl);
        if (testUrl.hostname === 'files' || testUrl.hostname === '') {
          const cdnParsed = new URL(cdnBase);
          testUrl.protocol = cdnParsed.protocol;
          testUrl.hostname = cdnParsed.hostname;
          testUrl.port = '';
          normalizedUrl = testUrl.toString();
        }
      } catch (_e) { }

      let absolute = new URL(normalizedUrl, sourceUrl).toString();

      // Fix: if absolute still resolved to provider domain (net52.cc/net11.cc) or the placeholder "files" hostname for a /files/ path
      // redirect it to the CDN host since /files/ are served there, not on the provider
      try {
        const absParsed = new URL(absolute);
        const isProviderHost = ['net52.cc', 'net11.cc', 'net22.cc'].includes(absParsed.hostname);
        const isFilesHost = absParsed.hostname === 'files' || absParsed.hostname === '';
        const isFilesPath = absParsed.pathname.startsWith('/files/');
        if (isFilesHost || (isProviderHost && isFilesPath)) {
          const cdnParsed = new URL(cdnBase);
          absParsed.protocol = cdnParsed.protocol;
          absParsed.hostname = cdnParsed.hostname;
          absParsed.port = '';
          absolute = absParsed.toString();
        }

        // Fix audio track URLs: the provider embeds its own movie ID (e.g. /files/81726031/a/)
        // but the CDN serves content under the CDN content ID (e.g. /files/220884/a/).
        // Replace the provider ID in audio paths with the actual CDN content ID.
        if (cdnContentId && correctMovieId && cdnContentId !== correctMovieId) {
          const absParsed2 = new URL(absolute);
          const isAudioPath = absParsed2.pathname.includes(`/files/${correctMovieId}/a/`) ||
                              absParsed2.pathname.includes(`/files/${correctMovieId}/audio/`);
          if (isAudioPath) {
            absParsed2.pathname = absParsed2.pathname.replace(
              `/files/${correctMovieId}/`,
              `/files/${cdnContentId}/`
            );
            absolute = absParsed2.toString();
          }
        }
      } catch (_e) { }

      const tokenized = normalizeToken(absolute);

      // Only proxy playlists (.m3u8). Video segments (.ts, .jpg), keys, maps, subtitles, etc.
      // can be requested by the browser directly from the CDN to avoid rate limits on the backend server IP.
      const isPlaylist = /\.m3u8($|\?)/i.test(tokenized);
      if (!isPlaylist) {
        return tokenized;
      }

      return `${proxyBase}?provider=${encodeURIComponent(provider)}&u=${encodeURIComponent(tokenized)}${tkParam}`;
    } catch (_err) {
      return rawUrl;
    }
  };

  const lines = String(playlistBody).split(/\r?\n/);

  // ── AUDIO TRACK DEFAULT SELECTION ──────────────────────────────────────────
  // Find all #EXT-X-MEDIA TYPE=AUDIO lines so we can pick a default.
  // Preference order: Tamil (tam) > Hindi (hin) > first track found.
  const audioMediaLines = lines.filter(l => /^#EXT-X-MEDIA.*TYPE=AUDIO/i.test(l.trim()));
  let defaultAudioLang = null;
  if (audioMediaLines.length > 0) {
    const preferredLangs = ['tam', 'hin', 'tel', 'mal', 'kan', 'eng'];
    for (const lang of preferredLangs) {
      const match = audioMediaLines.find(l => new RegExp(`LANGUAGE="${lang}"`, 'i').test(l));
      if (match) {
        // Extract the LANGUAGE value from the matched line
        const langMatch = match.match(/LANGUAGE="([^"]+)"/i);
        if (langMatch) { defaultAudioLang = langMatch[1]; break; }
      }
    }
    // Fallback: pick the first audio track's language
    if (!defaultAudioLang) {
      const firstLang = audioMediaLines[0].match(/LANGUAGE="([^"]+)"/i);
      if (firstLang) defaultAudioLang = firstLang[1];
    }
  }
  console.log(`[Stream Proxy] Audio tracks found: ${audioMediaLines.length}, defaulting to LANGUAGE="${defaultAudioLang || 'none'}".`);

  const rewritten = lines
    .filter(() => true) // keep all lines — audio tracks are now proxied, not dropped
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // ── Rewrite #EXT-X-MEDIA TYPE=AUDIO lines ──────────────────────────────
      // 1. Proxy the URI so audio playlists go through our proxy.
      // 2. Set DEFAULT=YES / AUTOSELECT=YES on the preferred language track;
      //    all others get DEFAULT=NO / AUTOSELECT=NO.
      // 3. If all variants in the playlist are hostless/unresolvable (e.g. content
      //    with no CDN hostname in the master), DROP audio tracks entirely to prevent
      //    a 502 storm from HLS.js audio track retry loops.
      if (/^#EXT-X-MEDIA.*TYPE=AUDIO/i.test(trimmed)) {
        if (sourceAlreadyHasQuality && allVariantsHostless) {
          // Suppress audio track — URI would resolve to a wrong CDN (404/502) and
          // cause HLS.js to enter a fatal audioTrackLoadError retry loop.
          return null;
        }
        const langMatch = trimmed.match(/LANGUAGE="([^"]+)"/i);
        const thisLang = langMatch ? langMatch[1] : null;
        const isDefault = defaultAudioLang && thisLang &&
          thisLang.toLowerCase() === defaultAudioLang.toLowerCase();

        // Rewrite URI through proxy
        let rewrittenLine = line.replace(/URI="([^"]+)"/g, (_m, uriValue) => `URI="${toProxy(uriValue)}"`);

        // Set DEFAULT / AUTOSELECT flags
        rewrittenLine = rewrittenLine
          .replace(/\bDEFAULT=(?:YES|NO)/gi, isDefault ? 'DEFAULT=YES' : 'DEFAULT=NO')
          .replace(/\bAUTOSELECT=(?:YES|NO)/gi, isDefault ? 'AUTOSELECT=YES' : 'AUTOSELECT=NO');

        // If the line doesn't have AUTOSELECT at all, add it
        if (!/AUTOSELECT=/i.test(rewrittenLine)) {
          rewrittenLine = rewrittenLine.replace(/(#EXT-X-MEDIA:[^\n]*)/, `$1,AUTOSELECT=${isDefault ? 'YES' : 'NO'}`);
        }

        return rewrittenLine;
      }

      // Rewrite URI="..." attributes inside other HLS tags (#EXT-X-KEY, #EXT-X-MAP)
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uriValue) => `URI="${toProxy(uriValue)}"`);
      }

      // Rewrite plain segment/playlist URLs.
      return toProxy(trimmed);
    })
    .filter(line => line !== null); // remove suppressed audio track lines

  const finalBody = rewritten.join('\n');

  // ── POST-REWRITE DIAGNOSTIC ─────────────────────────────────────────────────
  if (audioMediaLines.length > 0) {
    const rewrittenAudioLines = finalBody.split(/\r?\n/).filter(l => /^#EXT-X-MEDIA.*TYPE=AUDIO/i.test(l));
    console.log('[Stream Proxy] AFTER REWRITE - Audio track lines sent to client:');
    rewrittenAudioLines.forEach(l => console.log(`  ${l}`));
  }

  return finalBody;
}

exports.proxyStream = async (req, res) => {
  let targetUrl = String(req.query.u || '');
  // Play token forwarded from stream.controller via &tk= â€” used to fix in=unknown::ni
  const proxyPlayToken = String(req.query.tk || '');

  // Reconstruct flattened query parameters if 'in' token parsed as first-level query param
  if (req.query.in && !targetUrl.includes('in=')) {
    const separator = targetUrl.includes('?') ? '&' : '?';
    targetUrl = `${targetUrl}${separator}in=${req.query.in}`;
  }

  // Sanitization fallback: If target URL has a triple-slash files path or hostname "files"
  if (/^https:\/+\/?files\//i.test(targetUrl)) {
    targetUrl = targetUrl.replace(/^https:\/+\/?files\//i, 'https://s21.freecdn4.top/files/');
  } else if (targetUrl.includes('://files/')) {
    targetUrl = targetUrl.replace('://files/', '://s21.freecdn4.top/files/');
  }

  try {
    const provider = String(req.query.provider || '').toLowerCase();
    const source = targetUrl;

    if (!isAllowedProvider(provider)) {
      return res.status(400).json({ success: false, error: 'Invalid provider' });
    }
    if (!source) {
      return res.status(400).json({ success: false, error: 'Missing source URL' });
    }

    const cacheKey = `${provider}::${source}::${proxyPlayToken}`;
    const cachedBody = getCachedPlaylist(cacheKey);
    if (cachedBody) {
      console.log(`[Stream Proxy] [CACHE HIT] Playlist: ${source.split('?')[0]}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(cachedBody);
    }

    const domain = provider === 'net52' ? await getNet52Domain() : await getNet11Domain();
    const parsed = new URL(source);
    const allowedHost = new URL(domain).host;
    if (!isAllowedSourceHost(provider, parsed.host, allowedHost)) {
      return res.status(403).json({ success: false, error: 'Blocked host' });
    }

    const upstreamHeaders = buildHeaders(provider, req.headers);
    
    // Forward client IP headers to allow correct dynamic IP-locked token validation on upstream mirrors
    const ipHeaders = {};
    const ipHeaderNames = [
      'x-forwarded-for',
      'X-Forwarded-For',
      'cf-connecting-ip',
      'CF-Connecting-IP',
      'true-client-ip',
      'True-Client-IP',
      'x-real-ip',
      'X-Real-IP'
    ];
    for (const h of ipHeaderNames) {
      const val = upstreamHeaders[h] || upstreamHeaders[h.toLowerCase()];
      if (val) {
        ipHeaders[h] = val;
      }
    }

    const rangeHeader = req.headers.range || req.headers.Range;

    const doFetch = async (urlObj) => {
      return await axios({
        method: 'GET',
        url: urlObj.toString(),
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': '*/*',
          'Referer': `${domain}/`,
          'Origin': domain,
          // Browser-like headers to avoid anti-scraper detection
          'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
          ...(rangeHeader ? { Range: rangeHeader } : {}),
          ...(upstreamHeaders.Cookie ? { Cookie: upstreamHeaders.Cookie } : {}),
          ...ipHeaders
        },
        timeout: 15000
      });
    };

    let response;
    let success = false;
    const isCdnRequest = source.includes('/files/');
    const movieId = isCdnRequest ? extractMovieId(source) : null;
    const originalHost = parsed.hostname;

    if (movieId && resolvedCdnHostsCache.has(movieId)) {
      const cachedHost = resolvedCdnHostsCache.get(movieId);
      parsed.hostname = cachedHost;
      parsed.port = '';
      console.log(`[Stream Proxy] Using cached CDN host ${cachedHost} for movie ${movieId}`);
    }

    try {
      response = await doFetch(parsed);
      if (response && response.status === 200) {
        const bodyStr = Buffer.from(response.data).toString('utf8');
        if (!bodyStr.includes('Video File Not Found.')) {
          success = true;
        } else {
          console.warn(`[Stream Proxy] Target ${parsed.toString()} returned 200 but body contains "Video File Not Found."`);
        }
      }
    } catch (err) {
      console.log(`[Stream Proxy] Initial fetch failed for ${parsed.toString()}: ${err.message}`);
    }

    if (!success && isCdnRequest) {
      console.log(`[Stream Proxy] Initiating CDN retry loop for ${source}`);
      for (const candidate of CDN_CANDIDATES) {
        if (candidate === originalHost) continue;

        parsed.hostname = candidate;
        parsed.port = '';
        try {
          console.log(`[Stream Proxy] Probing candidate CDN: ${candidate}`);
          const probeResponse = await doFetch(parsed);
          if (probeResponse && probeResponse.status === 200) {
            const bodyStr = Buffer.from(probeResponse.data).toString('utf8');
            if (!bodyStr.includes('Video File Not Found.')) {
              response = probeResponse;
              success = true;
              if (movieId) {
                resolvedCdnHostsCache.set(movieId, candidate);
                console.log(`[Stream Proxy] Resolved and cached CDN host ${candidate} for movie ${movieId}`);
              }
              break;
            }
          }
        } catch (probeErr) {
          console.log(`[Stream Proxy] Probe failed for candidate ${candidate}: ${probeErr.message}`, probeErr.response?.status);
          // Reset hostname back to original host if this candidate fails
          parsed.hostname = originalHost;
        }
      }
    }

    if (!success || !response) {
      throw new Error(response ? `Upstream returned error status ${response.status}` : 'All CDN candidates failed');
    }

    const contentType = response.headers['content-type'] || '';
    const proxyBase = `${req.protocol}://${req.get('host')}/api/v2/stream/proxy`;

    const isSubtitle = /\.srt($|\?)/i.test(parsed.toString()) || parsed.toString().includes('/subs/');
    if (isSubtitle) {
      const originalSrt = Buffer.from(response.data).toString('utf8');
      const vttContent = srtToVtt(originalSrt);
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(vttContent);
    }

    if (isM3u8Content(contentType, parsed.toString())) {
      const originalBody = Buffer.from(response.data).toString('utf8');
      // Some upstreams return an HTML "valid users" page with 200.
      // Guard so clients don't treat it as an HLS playlist.
      if (!originalBody.trimStart().startsWith('#EXTM3U')) {
        const isDev = process.env.NODE_ENV !== 'production';
        return res.status(502).json({
          success: false,
          error: 'Upstream did not return a valid HLS playlist',
          ...(isDev
            ? {
              upstreamStatus: response.status,
              upstreamContentType: contentType,
              upstreamPreview: originalBody.slice(0, 200)
            }
            : {})
        });
      }
      const finalSourceUrl = response.request?.res?.responseUrl || parsed.toString();

      // â”€â”€â”€ DIAGNOSTIC: Raw upstream playlist content â”€â”€â”€
      const playlistLines = originalBody.split(/\r?\n/);
      const variantLines = playlistLines.filter(l =>
        l.includes('#EXT-X-STREAM-INF') || l.includes('freecdn') || l.includes('220884') || l.includes('/files/')
      );
      if (originalBody.includes('220884')) {
        console.warn(`[Stream Proxy DIAG] âš ï¸ Upstream playlist contains files/220884 (anti-abuse)!`);
        console.log(`[Stream Proxy DIAG] Source: ${parsed.toString()}`);
        console.log(`[Stream Proxy DIAG] Video variant lines:`);
        variantLines.forEach(l => console.log(`  ${l}`));
      } else {
        console.log(`[Stream Proxy DIAG] âœ… Upstream playlist looks clean (no 220884)`);
        console.log(`[Stream Proxy DIAG] Video variant lines:`);
        variantLines.forEach(l => console.log(`  ${l}`));
      }

      const rewrittenBody = rewritePlaylistBody(originalBody, provider, finalSourceUrl, proxyBase, parsed.toString(), proxyPlayToken);

      // Cache the REWRITTEN body (not the original) so cache hits also return audio-rewritten playlists
      const cacheKey2 = `${provider}::${source}::${proxyPlayToken}`;
      setCachedPlaylist(cacheKey2, rewrittenBody);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(rewrittenBody);
    }

    const bodyBuffer = Buffer.from(response.data);
    const effectiveContentType = looksLikeMpegTs(bodyBuffer)
      ? 'video/mp2t'
      : (contentType || 'application/octet-stream');
    res.setHeader('Content-Type', effectiveContentType);
    // Preserve common streaming headers for segment and subtitle assets.
    const passthroughHeaders = [
      'accept-ranges',
      'content-length',
      'content-range',
      'last-modified',
      'etag'
    ];
    for (const h of passthroughHeaders) {
      const v = response.headers?.[h];
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(response.status || 200).send(bodyBuffer);
  } catch (error) {
    console.error(
      '[Stream Proxy]',
      targetUrl,
      error.response?.status,
      error.response?.data
    );

    return res.status(502).json({
      success: false,
      error: error.message,
      upstreamStatus: error.response?.status,
      targetUrl
    });
  }
};
