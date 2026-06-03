const sourceManager = require('../services/sourceManager');

exports.getDetails = async (req, res) => {
  try {
    const { provider, id } = req.params;
    const titleFallback = req.query.title || '';
    const yearFallback = req.query.year || '';

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

    const details = await sourceManager.details(provider.toLowerCase(), id, req.headers, {
      titleFallback,
      yearFallback
    });

    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Details not found'
      });
    }

    res.json({
      success: true,
      results: details // Wrapped in results for matching V2 spec
    });
  } catch (err) {
    console.error('[Details Controller] Error:', err.message);
    res.status(500).json({
      success: false,
      error: 'An error occurred while fetching details.'
    });
  }
};
