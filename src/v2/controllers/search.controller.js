const sourceManager = require('../services/sourceManager');

exports.search = async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Query parameter "q" is required'
      });
    }

    const results = await sourceManager.search(query.trim(), req.headers);

    res.json({
      success: true,
      count: results.length,
      results
    });
  } catch (err) {
    console.error('[Search Controller] Error:', err.message);
    res.status(500).json({
      success: false,
      error: 'An error occurred while performing search.'
    });
  }
};
