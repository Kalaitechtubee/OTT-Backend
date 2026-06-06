const sourceManager = require('../services/sourceManager');

exports.getStream = async (req, res) => {
  try {
    const { provider, id } = req.params;

    if (!provider || !id) {
      return res.status(400).json({
        success: false,
        error: 'Missing provider or id parameter'
      });
    }

    if (!['net11', 'net52'].includes(provider.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid provider. Supported: net11, net52'
      });
    }

    // Find all alternative sources for parallel stream resolution
    let sources = [{ provider: provider.toLowerCase(), id }];
    const sourcesParam = req.query.sources || '';
    
    if (sourcesParam) {
      sources = sourcesParam.split(',').map((s) => {
        const [p, i] = s.split(':');
        return { provider: p.toLowerCase(), id: i };
      });
    } else {
      // Fallback: lookup using details endpoint
      try {
        const detailResult = await sourceManager.details(provider.toLowerCase(), id, req.headers);
        if (detailResult && Array.isArray(detailResult.sources)) {
          sources = detailResult.sources;
        }
      } catch (err) {
        console.warn('[Stream Controller] Alternate sources lookup failed, using request parameters only:', err.message);
      }
    }

    // Resolve streams sequentially to avoid provider rate limiting.
    // Try the best match (sources[0]) first, and only fall back to others if it fails.
    const validResults = [];
    for (const src of sources) {
      try {
        const resObj = await sourceManager.stream(src.provider, src.id, req.headers);
        if (resObj && resObj.success) {
          validResults.push({ provider: src.provider, id: src.id, data: resObj });
          // Found a working stream! Stop resolving further sources to save provider bandwidth/rate limits.
          break;
        }
      } catch (err) {
        console.error(`[Stream Controller] Failed to resolve stream for ${src.provider}:${src.id}:`, err.message);
      }
    }

    if (validResults.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No streams found'
      });
    }

    const proxyBase = `${req.protocol}://${req.get('host')}/api/v2/stream/proxy`;
    const mergedStreams = [];
    const mergedSubtitles = [];
    let title = '';
    let poster = null;
    let thumbnails = null;

    validResults.forEach((sRes, idx) => {
      const { provider: srcProvider, data: streamResult } = sRes;
      
      if (!title) title = streamResult.title;
      if (!poster) poster = streamResult.poster;
      if (!thumbnails) thumbnails = streamResult.thumbnails;

      const playToken = streamResult.playToken || '';
      const tkParam = playToken ? `&tk=${encodeURIComponent(playToken)}` : '';

      const inferProxyProvider = (rawUrl) => {
        try {
          const host = new URL(rawUrl).host.toLowerCase();
          if (host.includes('net52.cc') || host.includes('net22.cc')) return 'net52';
          if (host.includes('net11.cc')) return 'net11';
        } catch (_err) {}
        return srcProvider;
      };

      const toProxy = (url) => {
        const p = inferProxyProvider(url);
        return `${proxyBase}?provider=${p}&u=${encodeURIComponent(url)}${tkParam}`;
      };

      // Add a distinct source label index (Source 1, Source 2, etc.)
      const sourceLabel = `Source ${idx + 1}`;

      if (Array.isArray(streamResult.streams)) {
        streamResult.streams.forEach((s) => {
          mergedStreams.push({
            quality: s.quality,
            label: `${s.quality} (${sourceLabel})`,
            default: s.default && mergedStreams.length === 0, // only first default
            url: toProxy(s.url)
          });
        });
      }

      if (Array.isArray(streamResult.subtitles)) {
        streamResult.subtitles.forEach((t) => {
          mergedSubtitles.push({
            ...t,
            url: toProxy(t.url)
          });
        });
      }
    });

    if (mergedStreams.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No streams found after merging'
      });
    }

    const normalizedProvider = provider.toLowerCase();
    const wantDebug =
      process.env.NODE_ENV !== 'production' &&
      (req.query?.debug === '1' || req.query?.debug === 'true');

    res.json({
      success: true,
      provider: normalizedProvider,
      title: title || '',
      poster: poster || null,
      thumbnails: thumbnails || null,
      streams: mergedStreams,
      subtitles: mergedSubtitles,
      ...(wantDebug ? { debug: validResults.map(r => r.data.debug) } : {})
    });
  } catch (err) {
    console.error('[Stream Controller] Error:', err.message);
    res.status(500).json({
      success: false,
      error: 'An error occurred while fetching streams.'
    });
  }
};