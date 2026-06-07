require('dotenv').config();

console.log('NET11 COOKIE:', process.env.NET11_COOKIE ? process.env.NET11_COOKIE.length : 'undefined');
console.log('NET52_COOKIE:', process.env.NET52_COOKIE ? process.env.NET52_COOKIE.length : 'undefined');
console.log('USE_NET52_COOKIE:', process.env.USE_NET52_COOKIE || 'undefined');


const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const apiV2Router = require('./src/v2/routes/api.routes');

const app = express();
const PORT = process.env.PORT || 6000;

// Trust reverse proxy headers (Render, Heroku, Cloudflare, etc.)
app.set('trust proxy', true);

// Middleware
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Accept', 'Content-Type', 'Authorization', 'X-Requested-With', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type'],
  credentials: false,
}));
app.use(morgan('dev'));
app.use(express.json());

// API Routes
app.use('/api/v2', apiV2Router);

// Root route
app.get('/', (req, res) => {
  res.json({ name: 'MovieZon API', status: 'healthy', version: 'v2.0', timestamp: new Date() });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: 'v2.0', timestamp: new Date() });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieZon Backend v2.0 listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`V2 APIs:`);
  console.log(`  - Search:  http://localhost:${PORT}/api/v2/search?q=Leo`);
  console.log(`  - Details: http://localhost:${PORT}/api/v2/details/:provider/:id`);
  console.log(`  - Stream:  http://localhost:${PORT}/api/v2/stream/:provider/:id`);
});

// Reload trigger 5
