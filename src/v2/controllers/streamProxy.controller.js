const axios = require('axios');
const {
  USER_AGENT,
  buildHeaders,
  getNet11Domain,
  getNet52Domain
} = require('../utils/axiosClient');

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
    'freecdn4.top'
  ];

  if (sharedSuffixes.some((suffix) => normalized.endsWith(suffix))) return true;

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

function rewritePlaylistBody(playlistBody, provider, sourceUrl, proxyBase, originalRequestedUrl) {
  const sourceToken = (() => {
    try {
      const u1 = new URL(sourceUrl);
      let token = u1.searchParams.get('in') || '';
      if (token && token !== 'unknown::ni') return token;

      if (originalRequestedUrl) {
        const u2 = new URL(originalRequestedUrl);
        token = u2.searchParams.get('in') || '';
        if (token && token !== 'unknown::ni') return token;
      }
      return '';
    } catch (_err) {
      return '';
    }
  })();

  // Extract the canonical movie ID from the source playlist URL
  // e.g. https://net52.cc/pv/hls/81728596.m3u8 → "81728596"
  const correctMovieId = (() => {
    try {
      const m = new URL(sourceUrl).pathname.match(/\/(\d+)\.m3u8/);
      return m ? m[1] : null;
    } catch (_e) {
      return null;
    }
  })();

  // The known CDN hostname that serves /files/ segments
  const CDN_HOSTS = ['s21.freecdn4.top', 'nm-cdn4.top', 'nfmirrorcdn.top', 'freecdn4.top'];

  console.log('\n--- [HLS REWRITE] PLAYLIST PARSING ---');
  console.log('SOURCE URL:', sourceUrl);
  console.log('CORRECT MOVIE ID:', correctMovieId);
  console.log('EXTRACTED TOKEN:', sourceToken);
  console.log('\nRAW PLAYLIST BODY:\n' + playlistBody);

  const normalizeToken = (absoluteUrl) => {
    if (!sourceToken) return absoluteUrl;
    try {
      const u = new URL(absoluteUrl);
      const current = u.searchParams.get('in'); // .get() decodes %3A → :: automatically
      if (!current || current === 'unknown::ni') {
        // CRITICAL: Do NOT use u.searchParams.set() — it percent-encodes :: → %3A%3A
        // which then gets double-encoded by encodeURIComponent later.
        // Instead: delete 'in', reconstruct base URL, append raw token as plain string.
        u.searchParams.delete('in');
        const base = u.toString(); // other params (if any) are fine to encode normally
        const sep = base.includes('?') ? '&' : '?';
        return `${base}${sep}in=${sourceToken}`; // raw :: colons preserved
      }
      // Has a valid token — still reconstruct with raw token to avoid stale encoding
      u.searchParams.delete('in');
      const base = u.toString();
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}in=${current}`; // current is already decoded by .get()
    } catch (_err) {
      return absoluteUrl;
    }
  };


  // Determine the CDN base from the source playlist URL's CDN lines
  // We scan the raw playlist for the first freecdn4.top host to use as CDN base
  const cdnBase = (() => {
    const m = playlistBody.match(/https:\/\/(s\d+\.freecdn4\.top|s\d+\.nm-cdn4\.top|[^/]+\.nfmirrorcdn\.top)/);
    return m ? `https://${m[1]}` : 'https://s21.freecdn4.top';
  })();

  const toProxy = (rawUrl) => {
    try {
      let normalizedUrl = rawUrl;

      // Fix: triple-slash audio track URLs → use CDN host (not provider domain)
      // https:///files/81728596/a/0/0.m3u8 → https://s21.freecdn4.top/files/81728596/a/0/0.m3u8
      if (normalizedUrl.startsWith('https:///files/')) {
        normalizedUrl = `${cdnBase}${normalizedUrl.replace('https://', '')}`;
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
      } catch (_e) {}

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

        // Disabling incorrect ID replacement which breaks the CDN URL path
        // if (correctMovieId) {
        //   const wrongIdMatch = absolute.match(/\/files\/(\d+)\//);
        //   if (wrongIdMatch && wrongIdMatch[1] !== correctMovieId) {
        //     console.log(`  [ID FIX] Replacing /files/${wrongIdMatch[1]}/ → /files/${correctMovieId}/`);
        //     absolute = absolute.replace(`/files/${wrongIdMatch[1]}/`, `/files/${correctMovieId}/`);
        //   }
        // }
      } catch (_e) {}

      const tokenized = normalizeToken(absolute);

      console.log('  LINE:', rawUrl);
      console.log('  RESOLVED URL:', absolute);
      console.log('  REWRITTEN URL:', tokenized);

      return `${proxyBase}?provider=${encodeURIComponent(provider)}&u=${encodeURIComponent(tokenized)}`;
    } catch (_err) {
      return rawUrl;
    }
  };

  const lines = String(playlistBody).split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." attributes inside HLS tags such as:
    // #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_m, uriValue) => `URI="${toProxy(uriValue)}"`);
    }

    // Rewrite plain segment/playlist URLs.
    return toProxy(trimmed);
  });
  console.log('--- [HLS REWRITE] PLAYLIST PARSING COMPLETE ---\n');
  return rewritten.join('\n');
}

exports.proxyStream = async (req, res) => {
  let targetUrl = String(req.query.u || '');

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

    const domain = provider === 'net52' ? await getNet52Domain() : await getNet11Domain();
    const parsed = new URL(source);
    const allowedHost = new URL(domain).host;
    if (!isAllowedSourceHost(provider, parsed.host, allowedHost)) {
      return res.status(403).json({ success: false, error: 'Blocked host' });
    }

    const upstreamHeaders = buildHeaders(provider, req.headers);
    const rangeHeader = req.headers.range || req.headers.Range;
    const response = await axios({
      method: 'GET',
      url: parsed.toString(),
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Referer': `${domain}/search`,
        'Origin': domain,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
        ...(upstreamHeaders.Cookie ? { Cookie: upstreamHeaders.Cookie } : {})
      },
      timeout: 15000
    });

    const contentType = response.headers['content-type'] || '';
    const proxyBase = `${req.protocol}://${req.get('host')}/api/v2/stream/proxy`;

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
      const rewrittenBody = rewritePlaylistBody(originalBody, provider, finalSourceUrl, proxyBase, parsed.toString());
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
