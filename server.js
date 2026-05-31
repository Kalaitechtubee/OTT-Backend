require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const catalogRouter = require('./src/routes/catalog');
const streamRouter = require('./src/routes/stream');
const searchCache = require('./src/utils/searchCache');
const net27 = require('./src/providers/net27');

const app = express();
const PORT = process.env.PORT || 5000;

// Trust reverse proxy headers (Render, Heroku, Cloudflare, etc.)
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// API Routes
app.use('/api/catalog', catalogRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: 'v1.0', timestamp: new Date() });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieZon Backend v1.0 listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Catalog: http://localhost:${PORT}/api/catalog/trending`);
  console.log(`Stream:  http://localhost:${PORT}/api/stream/play/:tmdbId`);
  console.log(`Search:  Net27 search-hybrid via /api/catalog/search`);

  // Warm popular Tamil searches into file cache (non-blocking)
  searchCache.warmFromFetcher((q, page) => net27.searchTitles(q, page));
});
