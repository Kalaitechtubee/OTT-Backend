const express = require('express');
const router = express.Router();

const searchController = require('../controllers/search.controller');
const detailsController = require('../controllers/details.controller');
const streamController = require('../controllers/stream.controller');
const streamProxyController = require('../controllers/streamProxy.controller');

const axios = require('axios');

router.get('/search', searchController.search);
router.get('/details/:provider/:id', detailsController.getDetails);
router.get('/stream/:provider/:id', streamController.getStream);
router.get('/stream/proxy', streamProxyController.proxyStream);

router.get('/probe', async (req, res) => {
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const results = {};

  const targets = [
    { name: 'net11_search', url: 'https://net11.cc/search.php?s=superman', method: 'GET' },
    { name: 'net52_search', url: 'https://net52.cc/search.php?s=superman', method: 'GET' },
    { name: 'net52_pv_search', url: 'https://net52.cc/pv/search.php?s=superman', method: 'GET' },
    { name: 'net11_play_post', url: 'https://net11.cc/play.php', method: 'POST', data: 'id=70041963' },
    { name: 'net52_api_search', url: 'https://net52.cc/api/catalog/search-hybrid?q=superman', method: 'GET' },
    { name: 'net52_api_embed', url: 'https://net52.cc/api/embed-tmdb/1452', method: 'GET' },
    { name: 'net27_api_search', url: 'https://net27.cc/api/catalog/search-hybrid?q=superman', method: 'GET' },
    { name: 'net27_api_embed', url: 'https://net27.cc/api/embed-tmdb/1452', method: 'GET' },
    { name: 'net27_leo_embed', url: 'https://net27.cc/api/embed-tmdb/949229', method: 'GET' },
    { name: 'net27_php_search', url: 'https://net27.cc/search.php?s=superman', method: 'GET' },
    { name: 'net27_php_play', url: 'https://net27.cc/play.php', method: 'POST', data: 'id=70041963' },
    { name: 'net22_search', url: 'https://net22.cc/search.php?s=superman', method: 'GET' },
    { name: 'net22_play', url: 'https://net22.cc/play.php', method: 'POST', data: 'id=70041963' },
    { name: 'net22_api_search', url: 'https://net22.cc/api/catalog/search-hybrid?q=superman', method: 'GET' },
    { name: 'net27_catalog_id_test', url: 'https://net27.cc/api/catalog/title/movie/81639323', method: 'GET' }
  ];

  for (const target of targets) {
    try {
      const config = {
        method: target.method,
        url: target.url,
        headers: {
          'User-Agent': USER_AGENT,
          ...(target.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } : {})
        },
        timeout: 8000
      };
      if (target.data) config.data = target.data;
      
      const response = await axios(config);
      results[target.name] = {
        success: true,
        status: response.status,
        headers: response.headers,
        dataPreview: typeof response.data === 'string' ? response.data.substring(0, 500) : response.data
      };
    } catch (err) {
      results[target.name] = {
        success: false,
        message: err.message,
        status: err.response?.status,
        headers: err.response?.headers,
        dataPreview: typeof err.response?.data === 'string' ? err.response.data.substring(0, 500) : err.response?.data
      };
    }
  }

  res.json(results);
});

module.exports = router;
