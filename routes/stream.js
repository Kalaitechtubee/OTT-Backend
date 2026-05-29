const express = require('express');
const router = express.Router();
const axios = require('axios');
const net27 = require('../services/net27');

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

    const data = await net27.getLanguages(type, parseInt(tmdbId), opts);
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
    if (req.query.sid) opts.sid = req.query.sid;
    if (req.query.dp) opts.dp = req.query.dp;

    const data = await net27.getStreams(tmdbId, opts);

    if (!data || !data.ok) {
      return res.status(404).json({
        ok: false,
        error: data?.error || 'No streams found for this title',
      });
    }

    const domain = await net27.getWorkingDomain();

    // Construct exact embed referer URL
    const refererParams = [];
    if (opts.type) refererParams.push(`type=${opts.type}`);
    if (opts.se) refererParams.push(`se=${opts.se}`);
    if (opts.ep) refererParams.push(`ep=${opts.ep}`);
    if (opts.sid) refererParams.push(`sid=${opts.sid}`);
    if (opts.dp) refererParams.push(`dp=${opts.dp}`);
    const refererQuery = refererParams.length > 0 ? `?${refererParams.join('&')}` : '';
    const refererUrl = `${domain}/api/embed-tmdb/${tmdbId}${refererQuery}`;

    // Rewriting URLs to route through the proxy endpoint
    const backendBaseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

    const getProxyUrl = (cdnUrl) => {
      if (!cdnUrl) return '';
      return `${backendBaseUrl}/api/stream/proxy?url=${encodeURIComponent(cdnUrl)}&referer=${encodeURIComponent(refererUrl)}&origin=${encodeURIComponent(domain)}`;
    };

    const proxyMp4 = getProxyUrl(data.mp4);
    const proxyStreams = (data.streams || []).map(stream => ({
      ...stream,
      url: getProxyUrl(stream.url)
    }));

    // Return clean response with proxy URLs
    res.json({
      ok: true,
      tmdbId: data.tmdbId,
      title: data.title,
      type: data.type,
      year: data.year,
      currentSeason: data.currentSeason,
      currentEpisode: data.currentEpisode,
      mp4: proxyMp4,
      resolution: data.resolution,
      streams: proxyStreams,
      subjectId: data.subjectId,
      fallbackHls: data.fallbackHls,
      headers: {
        "Referer": refererUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
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
