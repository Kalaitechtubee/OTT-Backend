const net11 = require('../providers/net11');
const net52 = require('../providers/net52');
const tmdbService = require('./tmdbService');

module.exports = {
  isMeaningfulText(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return !['untitled', 'unknown', 'n/a', 'na', 'null', 'undefined'].includes(normalized);
  },

  async search(query, clientHeaders = {}) {
    console.log(`[SourceManager] Initiating search for: "${query}"`);
    
    // 1. Fetch search results from both providers in parallel
    const [n11Results, n52Results] = await Promise.all([
      net11.search(query, clientHeaders).catch(err => {
        console.error('[SourceManager] Net11 search failed:', err.message);
        return [];
      }),
      net52.search(query, clientHeaders).catch(err => {
        console.error('[SourceManager] Net52 search failed:', err.message);
        return [];
      })
    ]);

    // 2. Merge results
    const mergedResults = [...n11Results, ...n52Results];
    console.log(`[SourceManager] Found ${mergedResults.length} raw results. Fetching TMDB details...`);

    // 3. Find TMDB matches in parallel to add posters & backdrops
    const enrichedResults = await Promise.all(
      mergedResults.map(async (item) => {
        const match = await tmdbService.findMatch(item.title, item.year);
        if (match) {
          return {
            ...item,
            title: match.title, // Standardized title
            tmdbId: match.tmdbId,
            mediaType: match.mediaType,
            poster: match.posterPath,
            backdrop: match.backdropPath,
            rating: match.rating,
            year: match.year || item.year
          };
        }
        return {
          ...item,
          tmdbId: null,
          mediaType: 'movie', // Default
          poster: null,
          backdrop: null,
          rating: null
        };
      })
    );

    return enrichedResults;
  },

  async details(provider, id, clientHeaders = {}, fallback = {}) {
    console.log(`[SourceManager] Fetching details for provider: ${provider}, ID: ${id}`);
    let providerDetails = null;

    // 1. Fetch details from the correct provider
    if (provider === 'net11') {
      providerDetails = await net11.details(id, clientHeaders);
    } else if (provider === 'net52') {
      providerDetails = await net52.details(id, clientHeaders);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    // Determine the title & year to match TMDB
    const fallbackTitle = fallback.titleFallback || '';
    const fallbackYear = fallback.yearFallback || '';
    const providerTitle = this.isMeaningfulText(providerDetails?.title) ? providerDetails.title.trim() : '';
    const providerYear = this.isMeaningfulText(providerDetails?.year) ? providerDetails.year.trim() : '';
    const title = providerTitle || fallbackTitle;
    const year = providerYear || fallbackYear;

    let tmdbDetails = null;
    let tmdbAssets = null;

    // 2. If we have a title, match with TMDB for premium metadata
    if (title) {
      console.log(`[SourceManager] TMDB matching for title: "${title}" (${year})`);
      tmdbDetails = await tmdbService.findMatch(title, year);
      if (tmdbDetails) {
        tmdbAssets = await tmdbService.getAssets(tmdbDetails.tmdbId, tmdbDetails.mediaType);
      }
    }

    // 3. Construct unified normalized response
    const finalDetails = {
      id,
      provider,
      title: tmdbDetails?.title || providerTitle || fallbackTitle || 'Untitled',
      year: tmdbDetails?.year || providerYear || fallbackYear || 'N/A',
      description: tmdbDetails?.overview || providerDetails?.description || 'No description available.',
      // Keep provider metadata as primary (TMDB usually doesn't have these fields in our service).
      director: providerDetails?.director || '',
      genre: providerDetails?.genre || '',
      languages: providerDetails?.languages || [],
      // Prefer TMDB cast, otherwise fall back to provider cast string.
      cast: tmdbAssets?.cast || (providerDetails?.cast ? providerDetails.cast.split(',').map(name => ({ name: name.trim() })) : []),
      poster: tmdbDetails?.posterPath || null,
      backdrop: tmdbDetails?.backdropPath || null,
      rating: tmdbDetails?.rating || providerDetails?.rating || null,
      trailer: tmdbAssets?.trailer || null,
      recommendations: tmdbAssets?.recommendations || [],
      tmdbId: tmdbDetails?.tmdbId || null,
      mediaType: tmdbDetails?.mediaType || 'movie'
    };

    return finalDetails;
  },

  async stream(provider, id, clientHeaders = {}) {
    console.log(`[SourceManager] Resolving stream for provider: ${provider}, ID: ${id}`);
    
    if (provider === 'net11') {
      return net11.stream(id, clientHeaders);
    } else if (provider === 'net52') {
      return net52.stream(id, clientHeaders);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }
};
