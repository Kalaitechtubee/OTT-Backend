const axios = require('axios');
const providerConfig = require('../config/provider');

// Read base URL from env or from provider.js config
const BASE_URL = process.env.NET52_BASE_URL || providerConfig.NET52_BASE_URL || 'https://net52.cc';

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept: 'application/json',
  },
});

class Net52Provider {
  constructor() {
    this.provider = 'net52';
    this.enabled = true;
  }

  async search(query, page = 1) {
    try {
      const res = await client.get(`/pv/search.php`, { params: { s: query, page } });
      return res.data;
    } catch (err) {
      console.error(`[Net52] Search failed:`, err.message);
      throw err;
    }
  }

  async details(type, tmdbId) {
    try {
      // Maps tmdbId to Net52 post ID or details
      const res = await client.get(`/pv/post.php`, { params: { id: tmdbId } });
      return res.data;
    } catch (err) {
      console.error(`[Net52] Details failed:`, err.message);
      throw err;
    }
  }

  async streams(tmdbId, opts = {}) {
    try {
      // Opts might contain specific ID mapping
      const id = opts.sid || tmdbId;
      const res = await client.get(`/pv/playlist.php`, { params: { id } });
      return res.data;
    } catch (err) {
      console.error(`[Net52] Streams failed:`, err.message);
      throw err;
    }
  }

  async homepage() {
    try {
      const res = await client.get(`/pv/homepage.php`);
      return res.data;
    } catch (err) {
      console.error(`[Net52] Homepage failed:`, err.message);
      throw err;
    }
  }

  // Unified alias methods for interface compatibility
  async searchTitles(query, page) {
    return this.search(query, page);
  }

  async getTitleDetails(type, tmdbId) {
    return this.details(type, tmdbId);
  }

  async getLanguages(type, tmdbId, opts = {}) {
    // Net52 languages might be inside details or a dedicated list.
    // For compatibility with catalogFilter/languages routes:
    try {
      const detailData = await this.details(type, tmdbId);
      const languagesList = detailData?.languages || [];
      const variants = languagesList.map(lang => ({
        dubSubjectId: String(tmdbId),
        language: lang,
        isOriginal: lang.toLowerCase().includes('english') || lang.toLowerCase().includes('original')
      }));
      return { ok: true, variants };
    } catch (err) {
      return { ok: false, variants: [] };
    }
  }

  async getStreams(tmdbId, opts = {}) {
    return this.streams(tmdbId, opts);
  }
}

module.exports = new Net52Provider();
