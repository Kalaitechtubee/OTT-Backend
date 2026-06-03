const express = require('express');
const router = express.Router();

const searchController = require('../controllers/search.controller');
const detailsController = require('../controllers/details.controller');
const streamController = require('../controllers/stream.controller');
const streamProxyController = require('../controllers/streamProxy.controller');

router.get('/search', searchController.search);
router.get('/details/:provider/:id', detailsController.getDetails);
router.get('/stream/:provider/:id', streamController.getStream);
router.get('/stream/proxy', streamProxyController.proxyStream);

module.exports = router;
