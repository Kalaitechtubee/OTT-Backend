/**
 * Net11 source adapter (stub — implement when Net11 API is ready).
 *
 * Convert play.php / m3u8 / alternate JSON to unified shapes here.
 * Routes never import this file directly.
 */

module.exports = {
  provider: 'net11',
  enabled: false,

  async search(_query, _page = 1) {
    return { ok: true, items: [], provider: 'net11' };
  },

  async details(_type, _tmdbId) {
    return null;
  },

  async languages(_type, _tmdbId, _opts = {}) {
    return { ok: false, variants: [], provider: 'net11' };
  },

  async streams(_tmdbId, _opts = {}) {
    return { ok: false, provider: 'net11' };
  },
};
