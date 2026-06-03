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

    const streamResult = await sourceManager.stream(provider.toLowerCase(), id, req.headers);

    if (!streamResult || !streamResult.success) {
      return res.status(404).json({
        success: false,
        error: 'No streams found'
      });
    }

    const normalizedProvider = provider.toLowerCase();
    const proxyBase = `${req.protocol}://${req.get('host')}/api/v2/stream/proxy`;

    const inferProxyProvider = (rawUrl) => {
      try {
        const host = new URL(rawUrl).host.toLowerCase();
        if (host.includes('net52.cc') || host.includes('net22.cc')) return 'net52';
        if (host.includes('net11.cc')) return 'net11';
      } catch (_err) {
        // Fallback to requested provider.
      }
      return normalizedProvider;
    };

    const toProxy = (url) => {
      const p = inferProxyProvider(url);
      return `${proxyBase}?provider=${p}&u=${encodeURIComponent(url)}`;
    };

    // Proxy all stream variant URLs through backend to avoid CORS/token/cookie issues.
    const streams = (streamResult.streams || []).map((s) => ({
      ...s,
      url: toProxy(s.url)
    }));

    // Proxy subtitle URLs too so browser can fetch cross-origin SRT/VTT.
    const subtitles = (streamResult.subtitles || []).map((t) => ({
      ...t,
      url: toProxy(t.url)
    }));

    const wantDebug =
      process.env.NODE_ENV !== 'production' &&
      (req.query?.debug === '1' || req.query?.debug === 'true');

    res.json({
      success: true,
      provider: normalizedProvider,
      title: streamResult.title || '',
      poster: streamResult.poster || null,
      thumbnails: streamResult.thumbnails || null,
      streams,
      subtitles,
      ...(wantDebug && streamResult.debug ? { debug: streamResult.debug } : {})
    });
  } catch (err) {
    console.error('[Stream Controller] Error:', err.message);
    res.status(500).json({
      success: false,
      error: 'An error occurred while fetching streams.'
    });
  }
};
