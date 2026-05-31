const net27 = require('./net27');

/**
 * Unified Source Manager for catalog and stream queries.
 * Frontend or other backend routing logic calls this interface, 
 * abstracting provider-specific details (Net27, SourceB, SourceC).
 */
class SourceManager {
  constructor() {
    this.activeSource = 'net27'; // Default active source
  }

  /**
   * Search titles (movies & TV shows)
   * @param {string} query 
   * @param {number} page 
   */
  async search(query, page = 1) {
    if (this.activeSource === 'net27') {
      return net27.searchTitles(query, page);
    }
    throw new Error(`Source ${this.activeSource} search not implemented`);
  }

  /**
   * Get title details (metadata, seasons, cast, recommendations)
   * @param {string} type - 'movie' or 'tv'
   * @param {number} tmdbId 
   */
  async details(type, tmdbId) {
    if (this.activeSource === 'net27') {
      return net27.getTitleDetails(type, tmdbId);
    }
    throw new Error(`Source ${this.activeSource} details not implemented`);
  }

  /**
   * Get language variants (dubs & subs)
   * @param {string} type - 'movie' or 'tv'
   * @param {number} tmdbId 
   * @param {object} opts - { se, ep, sid, dp }
   */
  async languages(type, tmdbId, opts = {}) {
    if (this.activeSource === 'net27') {
      return net27.getLanguages(type, tmdbId, opts);
    }
    throw new Error(`Source ${this.activeSource} languages not implemented`);
  }

  /**
   * Get fresh signed streaming URLs
   * @param {number} tmdbId 
   * @param {object} opts - { type, se, ep, dub, sid, dp }
   */
  async play(tmdbId, opts = {}) {
    if (this.activeSource === 'net27') {
      return net27.getStreams(tmdbId, opts);
    }
    throw new Error(`Source ${this.activeSource} play not implemented`);
  }
}

module.exports = new SourceManager();
