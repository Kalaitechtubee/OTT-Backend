const axios = require('axios');
const {
  USER_AGENT,
  buildHeaders,
  getNet11Domain,
  getNet52Domain
} = require('../utils/axiosClient');

const playlistCache = new Map();
const PLAYLIST_CACHE_TTL = 60 * 1000; // 60 seconds

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

  // The known CDN hostname that serves /files/ segments
  const CDN_HOSTS = ['s21.freecdn4.top', 's20.freecdn1.top', 'nm-cdn4.top', 'nfmirrorcdn.top', 'freecdn4.top', 'freecdn1.top'];

  const normalizeToken = (absoluteUrl) => {
    if (!sourceToken) return absoluteUrl;
    try {
      const u = new URL(absoluteUrl);
      const current = u.searchParams.get('in'); // .get() decodes %3A â†’ :: automatically
      if (!current || current === 'unknown::ni') {
        // CRITICAL: Do NOT use u.searchParams.set() â€” it percent-encodes :: â†’ %3A%3A
        // which then gets double-encoded by encodeURIComponent later.
        // Instead: delete 'in', reconstruct base URL, append raw token as plain string.
        u.searchParams.delete('in');
        const base = u.toString(); // other params (if any) are fine to encode normally
        const sep = base.includes('?') ? '&' : '?';
        return `${base}${sep}in=${sourceToken.replace(/^in=/, '')}`; // raw :: colons preserved
      }
      // Has a valid token â€” still reconstruct with raw token to avoid stale encoding
      u.searchParams.delete('in');
      const base = u.toString();
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}in=${current.replace(/^in=/, '')}`; // current is already decoded by .get()
    } catch (_err) {
      return absoluteUrl;
    }
  };


  // Determine the CDN base from the source playlist URL's CDN lines
  // We scan the raw playlist for the first freecdn4.top host to use as CDN base
  const cdnBase = (() => {
    const m = playlistBody.match(/https:\/\/(s\d+\.freecdn[14]\.top|s\d+\.nm-cdn4\.top|[^/]+\.nfmirrorcdn\.top)/);
    return m ? `https://${m[1]}` : 'https://s21.freecdn4.top';
  })();

  // Propagate the play token into every rewritten sub-URL (variant playlists,
  // segment URLs) so the token is available at every proxy hop.
  const tkParam = playToken ? `&tk=${encodeURIComponent(playToken)}` : '';

  const toProxy = (rawUrl) => {
    try {
      let normalizedUrl = rawUrl;

      // Fix: triple-slash audio track URLs â†’ use CDN host (not provider domain)
      // https:///files/81728596/a/0/0.m3u8 â†’ https://s21.freecdn4.top/files/81728596/a/0/0.m3u8
      if (normalizedUrl.startsWith('https:///files/')) {
        normalizedUrl = `${cdnBase}${normalizedUrl.replace('https://', '')}`;
      } else if (normalizedUrl.startsWith('https:///')) {
        normalizedUrl = normalizedUrl.replace('https:///', '/');
      }

      // Fix: "files" placeholder hostname â†’ CDN host
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

      // Fix: if absolute still resolved to provider domain (net52.cc/net11.cc) for a /files/ path
      // redirect it to the CDN host since /files/ are served there, not on the provider
      try {
        const absParsed = new URL(absolute);
        const isProviderHost = ['net52.cc', 'net11.cc', 'net22.cc'].includes(absParsed.hostname);
        const isFilesPath = absParsed.pathname.startsWith('/files/');
        if (isProviderHost && isFilesPath) {
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
      if (/^#EXT-X-MEDIA.*TYPE=AUDIO/i.test(trimmed)) {
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
    });

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
  // Play token forwarded from stream.controller via &tk= — used to fix in=unknown::ni
  const proxyPlayToken = String(req.query.tk || '');

  // Reconstruct flattened query parameters if 'in' token parsed as first-level query param
  if (req.query.in && !targetUrl.includes('in=')) {
    const separator = targetUrl.includes('?') ? '&' : '?';
    targetUrl = `${targetUrl}${separator}in=${req.query.in}`;
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

    // ── Normalize triple-slash URLs ────────────────────────────────────────────
    // net52 PV playlists sometimes emit https:///files/... (no CDN hostname).
    // Resolve them against the provider domain so URL parsing and host-validation work.
    let normalizedSource = source;
    if (/^https?:\/\/\//.test(normalizedSource)) {
      normalizedSource = normalizedSource.replace(/^https?:\/\/\//, `${domain}/`);
      console.log(`[Stream Proxy] Normalized triple-slash URL: ${normalizedSource.split('?')[0]}`);
    }

    const parsed = new URL(normalizedSource);
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
    const response = await axios({
      method: 'GET',
      url: parsed.toString(),
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

    const contentType = response.headers['content-type'] || '';
    const backendBase = process.env.BACKEND_URL
      ? process.env.BACKEND_URL.replace(/\/$/, '')
      : `${req.protocol}://${req.get('host')}`;
    const proxyBase = `${backendBase}/api/v2/stream/proxy`;

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
