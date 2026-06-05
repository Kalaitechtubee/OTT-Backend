const sourceManager = require('../services/sourceManager');

exports.getTrending = async (req, res) => {
  try {
    const timeWindow = req.query.time || 'week'; // week or day
    const mediaType = req.query.media || 'all'; // all, movie, tv
    const list = await sourceManager.getTmdbList(`/trending/${mediaType}/${timeWindow}`, {}, req.headers);
    res.json({ success: true, results: list });
  } catch (err) {
    console.error('[TMDB Controller] Trending Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getPopular = async (req, res) => {
  try {
    const list = await sourceManager.getTmdbList('/movie/popular', {}, req.headers);
    res.json({ success: true, results: list });
  } catch (err) {
    console.error('[TMDB Controller] Popular Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getTopRated = async (req, res) => {
  try {
    const list = await sourceManager.getTmdbList('/movie/top_rated', {}, req.headers);
    res.json({ success: true, results: list });
  } catch (err) {
    console.error('[TMDB Controller] Top Rated Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getUpcoming = async (req, res) => {
  try {
    const list = await sourceManager.getTmdbList('/movie/upcoming', {}, req.headers);
    res.json({ success: true, results: list });
  } catch (err) {
    console.error('[TMDB Controller] Upcoming Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getPopularTv = async (req, res) => {
  try {
    const list = await sourceManager.getTmdbList('/tv/popular', {}, req.headers);
    res.json({ success: true, results: list });
  } catch (err) {
    console.error('[TMDB Controller] Popular TV Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.discover = async (req, res) => {
  try {
    const type = req.query.type || 'movie'; // movie or tv
    const params = { ...req.query };
    delete params.type; // strip type query helper

    const list = await sourceManager.getTmdbList(
      type === 'tv' ? '/discover/tv' : '/discover/movie',
      params,
      req.headers
    );
    res.json({ success: true, results: list });
  } catch (err) {
    console.error('[TMDB Controller] Discover Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getDetailsByTmdbId = async (req, res) => {
  try {
    const { tmdbId } = req.params;
    const mediaType = req.query.type || 'movie';
    const titleFallback = req.query.title || '';
    const yearFallback = req.query.year || '';

    if (!tmdbId) {
      return res.status(400).json({ success: false, error: 'Missing tmdbId parameter' });
    }

    const details = await sourceManager.detailsByTmdbId(
      tmdbId,
      mediaType,
      req.headers,
      { titleFallback, yearFallback }
    );

    if (!details) {
      return res.status(404).json({ success: false, error: 'Details not found for TMDB ID' });
    }

    res.json({ success: true, results: details });
  } catch (err) {
    console.error('[TMDB Controller] Details By TMDB ID Error:', err.message);
    res.status(500).json({ success: false, error: 'An error occurred while fetching details.' });
  }
};
