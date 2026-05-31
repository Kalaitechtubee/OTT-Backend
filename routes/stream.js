const express = require('express');
const router = express.Router();
const axios = require('axios');
const net27 = require('../services/net27');
const sourceManager = require('../services/sourceManager');

const handleRouteError = (res, error, defaultMessage, statusCode = 502) => {
  console.error(`${defaultMessage}:`, error.message);
  if (error.response?.status === 429) {
    return res.status(429).json({ ok: false, error: 'Rate limited by upstream provider' });
  }
  return res.status(statusCode).json({ ok: false, error: defaultMessage });
};

/**
 * GET /api/stream/languages/:type/:tmdbId
 *
 * Get available language variants (dubs/subs) for a movie or TV episode.
 *
 * For TV shows, pass query params:
 *   ?se=1&ep=1&sid=<subjectId>&dp=<detailPath>
 *
 * Returns:
 * {
 *   "ok": true,
 *   "variants": [
 *     { "dubSubjectId": "...", "language": "Tamil dub", "isOriginal": false },
 *     { "dubSubjectId": "...", "language": "Hindi dub", "isOriginal": false },
 *     ...
 *   ]
 * }
 */
router.get('/languages/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Type must be "movie" or "tv"' });
    }

    const opts = {};
    if (req.query.se) opts.se = req.query.se;
    if (req.query.ep) opts.ep = req.query.ep;
    if (req.query.sid) opts.sid = req.query.sid;
    if (req.query.dp) opts.dp = req.query.dp;

    const data = await sourceManager.languages(type, parseInt(tmdbId), opts);
    if (data && data.variants) {
      const parentSid = data.defaultSubjectId || opts.sid || '';
      data.variants = data.variants.map(v => ({
        ...v,
        sid: v.sid || parentSid
      }));
    }
    res.json(data);
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch language variants');
  }
});

/**
 * GET /api/stream/play/:tmdbId
 *
 * Get fresh MP4 stream URLs for a title. Returns multiple quality tiers.
 *
 * ⚠️ IMPORTANT: The returned URLs contain signed tokens (sign= & t=) that EXPIRE.
 *    The client must call this endpoint every time the user clicks Play or Download.
 *    NEVER cache these URLs.
 *
 * For movies:
 *   GET /api/stream/play/550
 *
 * For TV episodes:
 *   GET /api/stream/play/76479?type=tv&se=1&ep=1&sid=<subjectId>&dp=<detailPath>
 *
 * For a specific language dub:
 *   Add &sid=<dubSubjectId> from the /languages endpoint
 *
 * Returns:
 * {
 *   "ok": true,
 *   "mp4": "https://...mp4?sign=...&t=...",
 *   "resolution": "1080",
 *   "streams": [
 *     { "url": "https://...mp4", "resolution": 360, "size": 210144117 },
 *     { "url": "https://...mp4", "resolution": 480, "size": 222382021 },
 *     { "url": "https://...mp4", "resolution": 720, "size": 406800865 },
 *     { "url": "https://...mp4", "resolution": 1080, "size": 646186864 }
 *   ]
 * }
 */
router.get('/play/:tmdbId', async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId);

    const opts = {};
    if (req.query.type) opts.type = req.query.type;
    if (req.query.se) opts.se = req.query.se;
    if (req.query.ep) opts.ep = req.query.ep;
    if (req.query.dub) opts.dub = req.query.dub;
    if (req.query.sid) opts.sid = req.query.sid;
    if (req.query.dp) opts.dp = req.query.dp;

    const data = await sourceManager.play(tmdbId, opts);

    console.log({
      dub: req.query.dub || null,
      sid: req.query.sid || null,
      returnedSubjectId: data?.subjectId || null,
    });

    if (!data || !data.ok) {
      return res.status(404).json({
        ok: false,
        error: data?.error || 'No streams found for this title',
      });
    }

    const domain = await net27.getWorkingDomain();

    // Construct exact embed referer URL (what Net27 embed page uses as Referer)
    const refererParams = [];
    if (opts.type) refererParams.push(`type=${opts.type}`);
    if (opts.se) refererParams.push(`se=${opts.se}`);
    if (opts.ep) refererParams.push(`ep=${opts.ep}`);
    if (opts.dub) refererParams.push(`dub=${opts.dub}`);
    if (opts.sid) refererParams.push(`sid=${opts.sid}`);
    if (opts.dp) refererParams.push(`dp=${opts.dp}`);
    const refererQuery = refererParams.length > 0 ? `?${refererParams.join('&')}` : '';
    const refererUrl = `${domain}/api/embed-tmdb/${tmdbId}${refererQuery}`;

    // ─── URL Strategy ───────────────────────────────────────────────────────
    //
    // The CDN (bcdnxw.hakunaymatata.com) blocks all server/datacenter IPs (403).
    // Net27's own website proxies via Cloudflare Worker for browser playback.
    // Flutter (mobile consumer IPs) can also hit the CF Worker directly.
    //
    // Architecture: Flutter → CF Worker → CDN   ✅ (no Render proxy involved)
    //
    // ?proxy=true  → Render server proxy (only works locally, 403 on Render)
    // ?proxy=false → Raw CDN URLs (for clients that set headers manually)
    // default      → CF Worker URLs (Flutter plays these directly ✅)
    //
    const CF_WORKER = 'https://streamhub-proxy.1545zoya.workers.dev';

    const buildCfWorkerUrl = (cdnUrl) => {
      if (!cdnUrl) return '';
      return `${CF_WORKER}/?url=${encodeURIComponent(cdnUrl)}&referer=${encodeURIComponent(refererUrl)}&origin=${encodeURIComponent(domain)}`;
    };

    const host = req.get('host');
    const isLocal = host.includes('localhost') || host.includes('127.0.0.1') || host.includes('10.0.2.2');
    const protocol = isLocal ? req.protocol : 'https';
    const backendBaseUrl = process.env.BACKEND_URL || `${protocol}://${host}`;

    const buildRenderProxyUrl = (cdnUrl) => {
      if (!cdnUrl) return '';
      return `${backendBaseUrl}/api/stream/proxy?url=${encodeURIComponent(cdnUrl)}&referer=${encodeURIComponent(refererUrl)}&origin=${encodeURIComponent(domain)}`;
    };

    // Determine URL mode
    const proxyMode = req.query.proxy; // 'true' | 'false' | undefined
    const transformUrl = (cdnUrl) => {
      if (proxyMode === 'true') return buildRenderProxyUrl(cdnUrl);   // Render server proxy
      if (proxyMode === 'false') return cdnUrl;                        // Raw CDN URL (mobile sets headers)
      return buildCfWorkerUrl(cdnUrl);                                 // Default: CF Worker (Flutter plays directly)
    };

    const finalMp4 = transformUrl(data.mp4);
    const finalStreams = (data.streams || []).map(stream => ({
      ...stream,
      url: transformUrl(stream.url)
    }));

    // Set cache busting headers to prevent caching of signed CDN/worker URLs
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    let poster = '';
    let languages = [];
    try {
      const details = await sourceManager.details(opts.type || 'movie', tmdbId);
      poster = details?.poster || details?.poster_path || '';
    } catch (err) {
      console.warn('[PlayRoute] Failed to load details for poster:', err.message);
    }

    try {
      const langData = await sourceManager.languages(opts.type || 'movie', tmdbId, opts);
      if (langData && langData.variants) {
        const parentSid = langData.defaultSubjectId || opts.sid || '';
        languages = langData.variants.map(v => ({
          id: v.dubSubjectId || v.sid || parentSid || 'original',
          language: v.language || 'Original'
        }));
      }
    } catch (err) {
      console.warn('[PlayRoute] Failed to load languages:', err.message);
    }

    // Return clean response with stream URLs
    res.json({
      ok: true,
      title: data.title || '',
      poster: poster,
      streams: finalStreams,
      languages: languages,
      workerUrl: CF_WORKER,
      // Keep backward compatibility fields for existing clients
      tmdbId: data.tmdbId,
      type: data.type,
      year: data.year,
      currentSeason: data.currentSeason,
      currentEpisode: data.currentEpisode,
      mp4: finalMp4,
      resolution: data.resolution,
      subjectId: data.subjectId,
      fallbackHls: data.fallbackHls,
      // Headers needed when playing raw CDN URLs (?proxy=false mode)
      // In default CF Worker mode, the worker handles CORS — no custom headers needed.
      headers: {
        "Referer": refererUrl,
        "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
        "Origin": domain
      }
    });
  } catch (e) {
    handleRouteError(res, e, 'Failed to fetch stream URLs');
  }
});

/**
 * GET /api/stream/proxy
 *
 * Proxies video stream requests from the Flutter client to the Net27 CDN,
 * forwarding proper headers and supporting Range requests for seeking/buffering.
 */
router.get('/proxy', async (req, res) => {
  try {
    const { url, referer, origin } = req.query;
    if (!url) {
      return res.status(400).json({ ok: false, error: 'Missing url query parameter' });
    }

    const targetUrl = url;
    const workerProxyUrl = `https://streamhub-proxy.1545zoya.workers.dev/?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer || '')}&origin=${encodeURIComponent(origin || '')}`;

    // Prepare headers to match worker proxy requirements
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    };

    // Forward the client's Range header if it exists
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    // Make streaming request to Worker Proxy (which in turn queries CDN)
    const response = await axios({
      method: 'get',
      url: workerProxyUrl,
      headers: headers,
      responseType: 'stream',
      validateStatus: () => true // Allow non-200 (e.g. 206 Partial Content) to be processed
    });

    // Forward specific headers back to client
    const headersToForward = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'expires'
    ];

    headersToForward.forEach(header => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });

    // Send backend-to-client status code and pipe the stream
    res.status(response.status);
    response.data.pipe(res);

    // Error handling on data stream
    response.data.on('error', (err) => {
      console.error('[Proxy] Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).send('Stream error');
      }
    });

    // Clean up connections if client aborts
    req.on('close', () => {
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }
    });

  } catch (error) {
    console.error('[Proxy] Connection error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: 'Failed to connect to stream source' });
    }
  }
});

module.exports = router;
