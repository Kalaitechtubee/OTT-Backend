const axios = require('axios');
const { TMDB_BASE_URL, TMDB_API_KEY } = require('../config/tmdb');

// ─── Circuit Breaker ────────────────────────────────────────────────────────
// If TMDB keeps timing out (e.g. network blocks api.themoviedb.org),
// the circuit opens so searches return immediately instead of hanging 4s per item.
const CIRCUIT = {
  failures: 0,
  openedAt: 0,
  FAILURE_THRESHOLD: 2,       // open after 2 consecutive failures (fast-fail when TMDB is blocked)
  RECOVERY_MS: 5 * 60 * 1000 // retry after 5 minutes
};

function isCircuitOpen() {
  if (CIRCUIT.failures < CIRCUIT.FAILURE_THRESHOLD) return false;
  const elapsed = Date.now() - CIRCUIT.openedAt;
  if (elapsed > CIRCUIT.RECOVERY_MS) {
    // Half-open: allow one probe request
    console.log('[TMDB Circuit] ♻️  Recovery window reached — allowing probe request');
    CIRCUIT.failures = CIRCUIT.FAILURE_THRESHOLD - 1; // allow exactly one attempt
    return false;
  }
  return true;
}

function recordSuccess() {
  if (CIRCUIT.failures > 0) {
    console.log('[TMDB Circuit] ✅ TMDB recovered — resetting circuit breaker');
  }
  CIRCUIT.failures = 0;
}

function recordFailure(reason) {
  CIRCUIT.failures += 1;
  if (CIRCUIT.failures === CIRCUIT.FAILURE_THRESHOLD) {
    CIRCUIT.openedAt = Date.now();
    console.error(
      `[TMDB Circuit] ⚡ Circuit OPENED after ${CIRCUIT.FAILURE_THRESHOLD} failures (${reason}). ` +
      `TMDB enrichment paused for 5 min. Searches will return provider-only data.\n` +
      `  → If api.themoviedb.org is blocked, set TMDB_PROXY=http://your-proxy:port in .env`
    );
  }
}

// ─── Axios Client ────────────────────────────────────────────────────────────
function buildClient() {
  const config = {
    baseURL: TMDB_BASE_URL,
    timeout: parseInt(process.env.TMDB_TIMEOUT_MS || '3000', 10),
    params: { api_key: TMDB_API_KEY }
  };

  // Optional HTTP proxy support: set TMDB_PROXY=http://host:port in .env
  const proxyUrl = process.env.TMDB_PROXY || '';
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      config.proxy = {
        protocol: u.protocol.replace(':', ''),
        host: u.hostname,
        port: parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 8080)
      };
      console.log(`[TMDB Config] 🔀 Routing TMDB via proxy: ${u.hostname}:${u.port}`);
    } catch (_) {
      console.warn('[TMDB Config] Invalid TMDB_PROXY value — ignoring');
    }
  }

  return axios.create(config);
}

const client = buildClient();

const { stripLangSuffix, cleanTitle } = require('../utils/titleHelper');

function logTmdbError(label, err) {
  if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
    console.warn(`[TMDB Service] ⏱️  Timeout for ${label} — api.themoviedb.org may be blocked on this network`);
  } else if (err.response) {
    const { status, data } = err.response;
    const msg = data?.status_message || err.message;
    if (status === 401) {
      console.error(`[TMDB Service] ❌ 401 Unauthorized for ${label} — check TMDB_API_KEY in .env`);
    } else if (status === 429) {
      console.warn(`[TMDB Service] ⚠️  429 Rate Limited for ${label}`);
    } else {
      console.error(`[TMDB Service] HTTP ${status} for ${label}: ${msg}`);
    }
  } else if (err.code) {
    console.error(`[TMDB Service] Network ${err.code} for ${label}: ${err.message}`);
  } else {
    console.error(`[TMDB Service] Error for ${label}:`, err.message);
  }
}

/**
 * Searches TMDB and returns the best matching movie or show.
 * Returns null immediately if the circuit breaker is open (TMDB is unreachable).
 */
async function findMatch(title, year = '') {
  if (!TMDB_API_KEY) return null;
  if (!title?.trim()) return null;

  // Fast-fail when circuit is open (TMDB unreachable)
  if (isCircuitOpen()) return null;

  const stripped = stripLangSuffix(title);
  const titlesToTry = stripped && stripped !== title ? [title, stripped] : [title];

  for (const searchTitle of titlesToTry) {
    let lastErr = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 500));

        const res = await client.get('/search/multi', { params: { query: searchTitle } });

        const results = res.data?.results || [];
        const mediaResults = results.filter(
          item => item.media_type === 'movie' || item.media_type === 'tv'
        );

        recordSuccess(); // TMDB responded — reset circuit

        if (mediaResults.length === 0) break;

        const cleanedSearch = cleanTitle(searchTitle);
        const searchYear = String(year || '').substring(0, 4);

        let bestMatch = null;
        let highestScore = -1;

        for (const item of mediaResults) {
          const itemTitle = item.title || item.name || '';
          const cleanedItem = cleanTitle(itemTitle);
          const itemYear = (item.release_date || item.first_air_date || '').substring(0, 4);

          let score = 0;

          // Title scoring
          if (cleanedSearch === cleanedItem) {
            score += 100;
          } else if (cleanedItem.includes(cleanedSearch) || cleanedSearch.includes(cleanedItem)) {
            score += 50;
          } else {
            const searchWords = cleanedSearch.split(/\s+/);
            const itemWords = cleanedItem.split(/\s+/);
            const overlap = searchWords.filter(w => w.length > 2 && itemWords.includes(w)).length;
            if (overlap > 0) score += Math.round((overlap / searchWords.length) * 30);
          }

          // Year scoring (only when year available)
          if (searchYear && itemYear) {
            if (itemYear === searchYear) score += 80;
            else if (Math.abs(parseInt(itemYear) - parseInt(searchYear)) <= 1) score += 30;
          }

          // Popularity tiebreaker
          score += (item.popularity || 0) / 100;

          if (score > highestScore) {
            highestScore = score;
            bestMatch = item;
          }
        }

        // Threshold: 10 covers title-only matches (no year from provider search payloads)
        if (highestScore > 10 && bestMatch) {
          return {
            tmdbId: bestMatch.id,
            mediaType: bestMatch.media_type,
            title: bestMatch.title || bestMatch.name,
            overview: bestMatch.overview,
            posterPath: bestMatch.poster_path
              ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}`
              : null,
            backdropPath: bestMatch.backdrop_path
              ? `https://image.tmdb.org/t/p/original${bestMatch.backdrop_path}`
              : null,
            rating: bestMatch.vote_average
              ? `TMDB ${bestMatch.vote_average.toFixed(1)}`
              : null,
            year: (bestMatch.release_date || bestMatch.first_air_date || '').substring(0, 4)
          };
        }

        break; // valid response but no strong match — try next title variant
      } catch (err) {
        lastErr = err;
        // Only retry on transient errors — NOT on timeouts/ECONNABORTED.
        // Retrying a timeout doubles the wait time and delays circuit breaker opening.
        const isTransientErr =
          err.code && ['ECONNRESET', 'ENOTFOUND'].includes(err.code);

        if (!isTransientErr) break; // timeout, 4xx, 5xx — don't retry
      }
    }

    if (lastErr) {
      logTmdbError(`"${searchTitle}"`, lastErr);
      recordFailure(lastErr.code || lastErr.message);
    }
  }

  return null;
}

/**
 * Retrieves trailers, cast, recommendations, genres, languages, and director for a TMDB ID.
 */
async function getAssets(tmdbId, mediaType) {
  if (!TMDB_API_KEY || !tmdbId) return null;
  if (isCircuitOpen()) return null;

  const typePath = mediaType === 'tv' ? 'tv' : 'movie';
  const assets = {
    trailer: null,
    cast: [],
    recommendations: [],
    genres: '',
    languages: [],
    director: '',
    title: '',
    originalTitle: '',
    overview: '',
    posterPath: null,
    backdropPath: null,
    rating: null,
    year: '',
    seasons: []
  };

  try {
    const [videoRes, creditsRes, recsRes, detailRes] = await Promise.all([
      client.get(`/${typePath}/${tmdbId}/videos`).catch(err => { logTmdbError(`videos/${tmdbId}`, err); return null; }),
      client.get(`/${typePath}/${tmdbId}/credits`).catch(err => { logTmdbError(`credits/${tmdbId}`, err); return null; }),
      client.get(`/${typePath}/${tmdbId}/recommendations`).catch(err => { logTmdbError(`recs/${tmdbId}`, err); return null; }),
      client.get(`/${typePath}/${tmdbId}`).catch(err => { logTmdbError(`details/${tmdbId}`, err); return null; })
    ]);

    // Any successful response resets the circuit
    if (videoRes || creditsRes || recsRes || detailRes) recordSuccess();

    if (videoRes?.data?.results) {
      const videos = videoRes.data.results;
      const trailer =
        videos.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
        videos.find(v => v.site === 'YouTube' && v.type === 'Teaser') ||
        videos.find(v => v.site === 'YouTube');
      if (trailer?.key) assets.trailer = `https://www.youtube.com/watch?v=${trailer.key}`;
    }

    if (creditsRes?.data?.cast) {
      assets.cast = creditsRes.data.cast.slice(0, 10).map(c => ({
        name: c.name,
        character: c.character,
        profilePath: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
      }));
    }

    if (recsRes?.data?.results) {
      assets.recommendations = recsRes.data.results.slice(0, 6).map(r => ({
        id: r.id,
        title: r.title || r.name || 'Untitled',
        posterPath: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
        mediaType: r.media_type || (mediaType === 'tv' ? 'tv' : 'movie')
      }));
    }

    // Full movie details: genres, spoken languages
    if (detailRes?.data) {
      const d = detailRes.data;
      assets.title = d.title || d.name || '';
      assets.originalTitle = d.original_title || d.original_name || '';
      assets.overview = d.overview || '';
      assets.posterPath = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null;
      assets.backdropPath = d.backdrop_path ? `https://image.tmdb.org/t/p/original${d.backdrop_path}` : null;
      assets.rating = d.vote_average ? `TMDB ${d.vote_average.toFixed(1)}` : null;
      assets.year = (d.release_date || d.first_air_date || '').substring(0, 4) || '';

      if (d.genres && d.genres.length > 0) {
        assets.genres = d.genres.map(g => g.name).join(', ');
      }
      if (d.spoken_languages && d.spoken_languages.length > 0) {
        assets.languages = d.spoken_languages.map(l => ({
          l: l.english_name || l.name || '',
          s: l.iso_639_1 || ''
        }));
      }
      if (d.seasons) {
        assets.seasons = d.seasons.map(s => ({
          season_number: s.season_number,
          episode_count: s.episode_count,
          name: s.name || `Season ${s.season_number}`
        }));
      }
    }

    // Director from credits crew
    if (creditsRes?.data?.crew) {
      const director = creditsRes.data.crew.find(c => c.job === 'Director');
      if (director) assets.director = director.name || '';
    }

    return assets;
  } catch (err) {
    logTmdbError(`getAssets/${tmdbId}`, err);
    return assets;
  }
}

async function fetchTmdbList(endpoint, params = {}) {
  if (!TMDB_API_KEY) return [];
  if (isCircuitOpen()) return [];

  try {
    const res = await client.get(endpoint, { params });
    recordSuccess();

    const results = res.data?.results || [];
    return results.map(item => {
      let mediaType = item.media_type;
      if (!mediaType) {
        if (endpoint.includes('/tv/') || item.first_air_date || item.name) {
          mediaType = 'tv';
        } else {
          mediaType = 'movie';
        }
      }

      return {
        id: String(item.id),
        tmdbId: item.id,
        title: item.title || item.name || 'Untitled',
        year: (item.release_date || item.first_air_date || '').substring(0, 4) || 'N/A',
        mediaType,
        poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : null,
        backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
        rating: item.vote_average ? `TMDB ${item.vote_average.toFixed(1)}` : null,
        overview: item.overview || ''
      };
    });
  } catch (err) {
    logTmdbError(`fetchTmdbList/${endpoint}`, err);
    recordFailure(err.code || err.message);
    return [];
  }
}

async function searchTmdb(query, page = 1) {
  if (!TMDB_API_KEY || !query?.trim()) return [];
  if (isCircuitOpen()) return [];

  try {
    const res = await client.get('/search/multi', {
      params: { query: query.trim(), page }
    });
    recordSuccess();

    const results = res.data?.results || [];
    return results
      .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
      .map(item => {
        let mediaType = item.media_type;
        return {
          id: String(item.id),
          tmdbId: item.id,
          title: item.title || item.name || 'Untitled',
          year: (item.release_date || item.first_air_date || '').substring(0, 4) || 'N/A',
          mediaType,
          poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : null,
          backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
          rating: item.vote_average ? `TMDB ${item.vote_average.toFixed(1)}` : null,
          overview: item.overview || '',
          provider: 'tmdb',
          sources: []
        };
      });
  } catch (err) {
    logTmdbError(`searchTmdb/${query}`, err);
    recordFailure(err.code || err.message);
    return [];
  }
}

async function getSeasonEpisodes(tmdbId, seasonNumber) {
  if (!TMDB_API_KEY || !tmdbId) return [];
  if (isCircuitOpen()) return [];

  const typePath = 'tv';
  try {
    const res = await client.get(`/${typePath}/${tmdbId}/season/${seasonNumber}`);
    recordSuccess();
    const episodes = res.data?.episodes || [];
    return episodes.map(ep => ({
      episode_number: ep.episode_number,
      name: ep.name || `Episode ${ep.episode_number}`,
      overview: ep.overview || '',
      still_path: ep.still_path ? `https://image.tmdb.org/t/p/w342${ep.still_path}` : null,
      runtime: ep.runtime || 0,
      air_date: ep.air_date || ''
    }));
  } catch (err) {
    logTmdbError(`season/${tmdbId}/${seasonNumber}`, err);
    recordFailure(err.code || err.message);
    return [];
  }
}

module.exports = { findMatch, getAssets, fetchTmdbList, searchTmdb, getSeasonEpisodes };
