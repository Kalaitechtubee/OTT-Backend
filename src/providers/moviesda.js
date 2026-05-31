/**
 * Moviesda source adapter (stub — implement when Moviesda API is ready).
 *
 * Routes never import this file directly.
 */

module.exports = {
  provider: 'moviesda',
  enabled: false,

  async search(_query, _page = 1) {
    return { ok: true, items: [], provider: 'moviesda' };
  },

  async details(_type, _tmdbId) {
    return null;
  },

  async languages(_type, _tmdbId, _opts = {}) {
    return { ok: false, variants: [], provider: 'moviesda' };
  },

  async streams(_tmdbId, _opts = {}) {
    return { ok: false, provider: 'moviesda' };
  },
};
