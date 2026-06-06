const net11 = require('../providers/net11');
const net52 = require('../providers/net52');
const tmdbService = require('./tmdbService');
const { cleanTitle, getFuzzyScore, normalizeTitle, extractAudioLanguages } = require('../utils/titleHelper');
const fs = require('fs');
const path = require('path');

const CACHE_FILE_PATH = path.join(__dirname, '../../../data/details-cache.json');

const memoryCache = {
  store: new Map(),
  
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  },
  
  set(key, value, ttlMs) {
    this.store.set(key, {
      value,
      expiry: Date.now() + ttlMs
    });

    if (key.startsWith('details::')) {
      this.savePersistentCache();
    }
  },

  loadPersistentCache() {
    try {
      const dir = path.dirname(CACHE_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(CACHE_FILE_PATH)) {
        const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
        const data = JSON.parse(raw);
        const now = Date.now();
        let loaded = 0;
        for (const [key, entry] of Object.entries(data)) {
          if (entry.expiry > now) {
            this.store.set(key, entry);
            loaded++;
          }
        }
        console.log(`[SourceManager] Loaded ${loaded} active cached items from persistent store.`);
      }
    } catch (err) {
      console.warn('[SourceManager] Failed to load persistent cache:', err.message);
    }
  },

  savePersistentCache() {
    try {
      const data = {};
      const now = Date.now();
      for (const [key, entry] of this.store.entries()) {
        if (key.startsWith('details::') && entry.expiry > now) {
          data[key] = entry;
        }
      }
      fs.writeFile(CACHE_FILE_PATH, JSON.stringify(data, null, 2), 'utf8', (err) => {
        if (err) {
          console.error('[SourceManager] Failed to write persistent cache:', err.message);
        }
      });
    } catch (err) {
      console.error('[SourceManager] Failed to save persistent cache:', err.message);
    }
  }
};

// Load persistent cache on startup
memoryCache.loadPersistentCache();

module.exports = {
  isMeaningfulText(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return !['untitled', 'unknown', 'n/a', 'na', 'null', 'undefined'].includes(normalized);
  },

  async search(query, clientHeaders = {}) {
    const cacheKey = `search::${query.toLowerCase().trim()}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      console.log(`[SourceManager] [CACHE HIT] Search for: "${query}"`);
      return cached;
    }

    console.log(`[SourceManager] Initiating TMDB-only search for: "${query}"`);
    const results = await tmdbService.searchTmdb(query);

    memoryCache.set(cacheKey, results, 10 * 60 * 1000); // 10 minutes cache
    return results;
  },

  async details(provider, id, clientHeaders = {}, fallback = {}) {
    const cacheKey = `details::${provider}::${id}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      console.log(`[SourceManager] [CACHE HIT] Details for: ${provider}:${id}`);
      return cached;
    }

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

    // 2. Match with TMDB for full metadata (poster, backdrop, cast, genres, languages, director, trailer, recommendations)
    if (title) {
      console.log(`[SourceManager] TMDB matching for title: "${title}" (${year})`);
      tmdbDetails = await tmdbService.findMatch(title, year);
      if (tmdbDetails) {
        tmdbAssets = await tmdbService.getAssets(tmdbDetails.tmdbId, tmdbDetails.mediaType);
      } else {
        console.warn(`[SourceManager] TMDB ❌ No match for "${title}" — using raw provider data only`);
      }
    }

    // 3. Construct unified normalized response
    const finalDetails = {
      id,
      provider,
      title: tmdbDetails?.title || providerTitle || fallbackTitle || 'Untitled',
      originalTitle: tmdbDetails?.originalTitle || tmdbAssets?.originalTitle || '',
      year: tmdbDetails?.year || providerYear || fallbackYear || 'N/A',
      description: tmdbDetails?.overview || providerDetails?.description || 'No description available.',
      // Prefer TMDB assets (from full detail fetch) → provider data
      director: tmdbAssets?.director || providerDetails?.director || '',
      genre: tmdbAssets?.genres || providerDetails?.genre || '',
      languages: (tmdbAssets?.languages && tmdbAssets.languages.length > 0)
        ? tmdbAssets.languages
        : (providerDetails?.languages && providerDetails.languages.length > 0)
          ? providerDetails.languages
          : [],
      // Prefer TMDB cast (with profile photos), otherwise fall back to provider cast string
      cast: tmdbAssets?.cast || (providerDetails?.cast
        ? providerDetails.cast.split(',').map(name => ({ name: name.trim(), character: '', profilePath: null }))
        : []),
      poster: tmdbDetails?.posterPath || null,
      backdrop: tmdbDetails?.backdropPath || null,
      rating: tmdbDetails?.rating || providerDetails?.rating || null,
      trailer: tmdbAssets?.trailer || null,
      tmdbId: tmdbDetails?.tmdbId || null,
      mediaType: tmdbDetails?.mediaType || providerDetails?.mediaType || 'movie'
    };

    finalDetails.seasons = tmdbAssets?.seasons || [];
    const providerSeasons = providerDetails?.seasons || [];
    if (finalDetails.seasons.length > 0 && providerSeasons.length > 0) {
      finalDetails.seasons = finalDetails.seasons.map(s => {
        const match = providerSeasons.find(p => String(p.s) === String(s.season_number));
        if (match) {
          return {
            ...s,
            providerSeasonId: match.id
          };
        }
        return s;
      });
    }

    // 4. Find alternate sources across providers for the same title
    let sources = [{ provider, id }];
    let audioLanguages = [];
    if (finalDetails.title) {
      try {
        const [n11Results, n52Results] = await Promise.all([
          net11.search(finalDetails.title, clientHeaders).catch(() => []),
          net52.search(finalDetails.title, clientHeaders).catch(() => [])
        ]);
        
        const allResults = [...n11Results, ...n52Results];
        const targetTitle = finalDetails.title || '';
        const targetOriginalTitle = finalDetails.originalTitle || '';
        const targetYear = finalDetails.year || '';
        
        const candidates = [];
        for (const item of allResults) {
          const score = getFuzzyScore(item.title, targetTitle);
          const scoreOriginal = targetOriginalTitle ? getFuzzyScore(item.title, targetOriginalTitle) : 0;
          const bestScore = Math.max(score, scoreOriginal);
          
          const y1 = parseInt(targetYear, 10);
          const y2 = parseInt(item.year, 10);
          const yearMatches = !y1 || !y2 || Math.abs(y1 - y2) <= 1;
          
          if (bestScore >= 70 && yearMatches) {
            candidates.push({ item, score: bestScore });
          }
        }
        
        // Sort candidates by match accuracy descending (highest score first)
        candidates.sort((a, b) => b.score - a.score);
        
        const extractedLangs = [];
        if (providerDetails?.title) {
          extractedLangs.push(...extractAudioLanguages(providerDetails.title));
        }

        for (const cand of candidates) {
          const item = cand.item;
          if (!sources.some(s => s.provider === item.provider && s.id === item.id)) {
            sources.push({ provider: item.provider, id: item.id });
          }
          extractedLangs.push(...extractAudioLanguages(item.title));
        }
        
        audioLanguages = Array.from(new Set(extractedLangs));
      } catch (err) {
        console.error('[SourceManager] Failed to find alternate sources:', err.message);
      }
    }
    
    if (audioLanguages.length === 0) {
      audioLanguages = finalDetails.languages.map(l => l.l || l.name || l);
    }
    if (audioLanguages.length === 0) {
      audioLanguages = ['Original Audio'];
    }
    
    finalDetails.sources = sources;
    finalDetails.audioLanguages = audioLanguages;

    memoryCache.set(cacheKey, finalDetails, 24 * 60 * 60 * 1000); // 24 hours cache
    return finalDetails;
  },

  async mapTmdbResultsToProviders(tmdbResults, clientHeaders = {}) {
    // For each TMDB result, attempt to find a matching provider source
    const mapped = await Promise.all(
      tmdbResults.map(async (item) => {
        try {
          const searchCacheKey = `search::${item.title.toLowerCase().trim()}`;
          let searchResults = memoryCache.get(searchCacheKey);
          
          if (!searchResults) {
            // Search Net11 & Net52
            const [n11, n52] = await Promise.all([
              net11.search(item.title, clientHeaders).catch(() => []),
              net52.search(item.title, clientHeaders).catch(() => [])
            ]);
            
            const seen = new Set();
            searchResults = [...n11, ...n52].filter(r => {
              const k = `${r.provider}::${r.id}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            
            memoryCache.set(searchCacheKey, searchResults, 10 * 60 * 1000);
          }

          const cleanedSearch = cleanTitle(item.title);
          const searchYear = String(item.year || '').substring(0, 4);

          // Find matches
          const matches = [];
          for (const src of searchResults) {
            if (cleanTitle(src.title) === cleanedSearch) {
              matches.push(src);
            }
          }

          if (matches.length > 0) {
            return {
              ...item,
              provider: matches[0].provider,
              id: matches[0].id,
              sources: matches.map(m => ({ provider: m.provider, id: m.id }))
            };
          }

          return {
            ...item,
            provider: 'tmdb',
            sources: []
          };
        } catch (err) {
          return {
            ...item,
            provider: 'tmdb',
            sources: []
          };
        }
      })
    );

    return mapped;
  },

  async getTmdbList(endpoint, params = {}, clientHeaders = {}) {
    const cacheKey = `tmdb_list::${endpoint}::${JSON.stringify(params)}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      console.log(`[SourceManager] [CACHE HIT] TMDB List: ${endpoint}`);
      return cached;
    }

    console.log(`[SourceManager] Fetching TMDB List: ${endpoint}`);
    const rawList = await tmdbService.fetchTmdbList(endpoint, params);
    
    // Map list items with provider 'tmdb' and empty sources.
    // Provider search is resolved on-demand when opening title details.
    const mappedList = rawList.map(item => ({
      ...item,
      provider: 'tmdb',
      sources: []
    }));

    memoryCache.set(cacheKey, mappedList, 15 * 60 * 1000); // 15 minutes cache
    return mappedList;
  },

  async detailsByTmdbId(tmdbId, mediaType = 'movie', clientHeaders = {}, fallback = {}) {
    const cacheKey = `details::tmdb::${tmdbId}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      console.log(`[SourceManager] [CACHE HIT] Details for TMDB ID: ${tmdbId}`);
      return cached;
    }

    console.log(`[SourceManager] Fetching details by TMDB ID: ${tmdbId} (${mediaType})`);

    const tmdbAssets = await tmdbService.getAssets(tmdbId, mediaType);
    if (!tmdbAssets) {
      return null;
    }

    const title = tmdbAssets.title || fallback.titleFallback || '';
    const year = tmdbAssets.year || fallback.yearFallback || '';

    let sources = [];
    let provider = null;
    let id = null;

    const originalTitle = tmdbAssets.originalTitle || '';

    let audioLanguages = [];
    if (title) {
      try {
        console.log(`[SourceManager] TMDB details lookup resolved title: "${title}" (${year}). Searching providers for streams...`);
        const [n11Results, n52Results] = await Promise.all([
          net11.search(title, clientHeaders).catch(() => []),
          net52.search(title, clientHeaders).catch(() => [])
        ]);

        const allResults = [...n11Results, ...n52Results];
        
        const candidates = [];
        for (const item of allResults) {
          const score = getFuzzyScore(item.title, title);
          const scoreOriginal = originalTitle ? getFuzzyScore(item.title, originalTitle) : 0;
          const bestScore = Math.max(score, scoreOriginal);
          
          const y1 = parseInt(year, 10);
          const y2 = parseInt(item.year, 10);
          const yearMatches = !y1 || !y2 || Math.abs(y1 - y2) <= 1;
          
          if (bestScore >= 70 && yearMatches) {
            candidates.push({ item, score: bestScore });
          }
        }

        // Sort candidates by match accuracy descending (highest score first)
        candidates.sort((a, b) => b.score - a.score);

        const extractedLangs = [];
        for (const cand of candidates) {
          const item = cand.item;
          if (!sources.some(s => s.provider === item.provider && s.id === item.id)) {
            sources.push({ provider: item.provider, id: item.id });
          }
          extractedLangs.push(...extractAudioLanguages(item.title));
        }

        audioLanguages = Array.from(new Set(extractedLangs));
      } catch (err) {
        console.error('[SourceManager] Failed to find alternate sources by TMDB ID:', err.message);
      }
    }

    if (sources.length > 0) {
      provider = sources[0].provider;
      id = sources[0].id;
    }

    if (audioLanguages.length === 0) {
      audioLanguages = tmdbAssets.languages.map(l => l.l || l.name || l);
    }
    if (audioLanguages.length === 0) {
      audioLanguages = ['Original Audio'];
    }

    const finalDetails = {
      id,
      provider,
      title: tmdbAssets.title || 'Untitled',
      originalTitle,
      year: tmdbAssets.year || 'N/A',
      description: tmdbAssets.overview || 'No description available.',
      director: tmdbAssets.director || '',
      genre: tmdbAssets.genres || '',
      languages: tmdbAssets.languages || [],
      cast: tmdbAssets.cast || [],
      poster: tmdbAssets.posterPath || null,
      backdrop: tmdbAssets.backdropPath || null,
      rating: tmdbAssets.rating || null,
      trailer: tmdbAssets.trailer || null,
      recommendations: tmdbAssets.recommendations || [],
      tmdbId: parseInt(tmdbId, 10),
      mediaType,
      sources,
      audioLanguages,
      seasons: tmdbAssets.seasons || []
    };

    let providerSeasons = [];
    if (id && (provider === 'net52' || provider === 'net11')) {
      try {
        const provDetails = provider === 'net11'
          ? await net11.details(id, clientHeaders)
          : await net52.details(id, clientHeaders);
        if (provDetails && provDetails.seasons) {
          providerSeasons = provDetails.seasons;
        }
      } catch (err) {
        console.warn(`[SourceManager] Failed to fetch provider seasons for TMDB ID ${tmdbId}:`, err.message);
      }
    }

    if (finalDetails.seasons.length > 0 && providerSeasons.length > 0) {
      finalDetails.seasons = finalDetails.seasons.map(s => {
        const match = providerSeasons.find(p => String(p.s) === String(s.season_number));
        if (match) {
          return {
            ...s,
            providerSeasonId: match.id
          };
        }
        return s;
      });
    }

    memoryCache.set(cacheKey, finalDetails, 24 * 60 * 60 * 1000); // 24 hours cache
    return finalDetails;
  },

  async stream(provider, id, clientHeaders = {}) {
    const cacheKey = `stream::${provider}::${id}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      console.log(`[SourceManager] [CACHE HIT] Stream for: ${provider}:${id}`);
      return cached;
    }

    console.log(`[SourceManager] Resolving stream for provider: ${provider}, ID: ${id}`);
    
    let result = null;
    if (provider === 'net11') {
      result = await net11.stream(id, clientHeaders);
    } else if (provider === 'net52') {
      result = await net52.stream(id, clientHeaders);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    memoryCache.set(cacheKey, result, 5 * 60 * 1000); // 5 minutes cache
    return result;
  },

  async getSeasonEpisodes(tmdbId, seasonNumber, provider, seriesId, seasonId, clientHeaders = {}) {
    const tmdbEpisodes = await tmdbService.getSeasonEpisodes(tmdbId, seasonNumber);

    if ((provider === 'net52' || provider === 'net11') && seriesId && seasonId) {
      const providerEpisodes = provider === 'net11'
        ? await net11.getEpisodes(seasonId, seriesId, clientHeaders)
        : await net52.getEpisodes(seasonId, seriesId, clientHeaders);

      return tmdbEpisodes.map(ep => {
        const epNumStr = `E${ep.episode_number}`;
        const match = providerEpisodes.find(n => n.ep === epNumStr || parseInt(n.ep?.replace(/\D/g, ''), 10) === ep.episode_number);
        if (match) {
          return {
            ...ep,
            id: match.id,
            provider: provider,
            sources: [{ provider: provider, id: match.id }]
          };
        }
        return ep;
      });
    }

    return tmdbEpisodes;
  }
};
