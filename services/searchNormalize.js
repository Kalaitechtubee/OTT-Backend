/**
 * Normalize Net27 search-hybrid responses for MovieZon clients.
 *
 * Net27 returns duplicate rows (TMDB hit + aoneroom-direct variant).
 * We dedupe, preserve streamable/subjectId, and sort playable titles first.
 */

function cleanTitle(title) {
  if (!title || typeof title !== 'string') return 'Untitled';
  return title.replace(/\s*\[[^\]]+\]\s*$/g, '').trim() || title;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const tmdbId = raw.tmdbId != null ? Number(raw.tmdbId) : null;
  const subjectId = raw.subjectId != null ? String(raw.subjectId) : null;

  if (!tmdbId && !subjectId) return null;

  const type = raw.type === 'tv' ? 'tv' : 'movie';
  const variants = Array.isArray(raw.variants)
    ? raw.variants.map((v) => ({
        subjectId: v.subjectId != null ? String(v.subjectId) : subjectId,
        title: v.title || raw.title,
        corner: v.corner || '',
        watchUrl: v.watchUrl || null,
      }))
    : [];

  return {
    tmdbId: tmdbId || 0,
    type,
    title: cleanTitle(raw.title),
    year: raw.year != null ? String(raw.year) : '',
    poster: raw.poster || raw.poster_path || '',
    backdrop: raw.backdrop || raw.backdrop_path || '',
    rating: Number(raw.rating ?? raw.vote_average ?? 0),
    overview: raw.overview || '',
    popularity: Number(raw.popularity ?? 0),
    streamable: raw.streamable === true,
    subjectId,
    detailPath: raw.detailPath || null,
    variants,
    cta: raw.streamable ? 'Watch Now' : 'Coming Soon',
    source: raw.source || 'net27-search-hybrid',
  };
}

/**
 * @param {object} raw - Raw Net27 search-hybrid payload
 * @param {string} query - Original search query
 */
function normalizeSearchResponse(raw, query) {
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const byTmdb = new Map();
  const bySubject = new Map();

  for (const row of rawItems) {
    const item = normalizeItem(row);
    if (!item) continue;

    if (item.tmdbId > 0) {
      const existing = byTmdb.get(item.tmdbId);
      if (!existing) {
        byTmdb.set(item.tmdbId, item);
      } else {
        // Prefer streamable + richer metadata
        const score = (i) =>
          (i.streamable ? 4 : 0) +
          (i.overview ? 2 : 0) +
          (i.variants?.length ? 1 : 0) +
          (i.poster?.includes('tmdb') ? 1 : 0);
        if (score(item) > score(existing)) {
          byTmdb.set(item.tmdbId, { ...existing, ...item, variants: item.variants.length ? item.variants : existing.variants });
        }
      }
      if (item.subjectId) bySubject.set(item.subjectId, item.tmdbId);
      continue;
    }

    // No tmdbId — only keep if we have not seen this subject on a TMDB row
    if (item.subjectId && !bySubject.has(item.subjectId)) {
      bySubject.set(item.subjectId, item);
    }
  }

  const items = [
    ...byTmdb.values(),
    ...[...bySubject.values()].filter((i) => typeof i === 'object' && !(i.tmdbId > 0)),
  ];

  items.sort((a, b) => {
    if (a.streamable !== b.streamable) return a.streamable ? -1 : 1;
    return (b.popularity || b.rating || 0) - (a.popularity || a.rating || 0);
  });

  const streamableCount = items.filter((i) => i.streamable).length;

  return {
    ok: raw?.ok !== false,
    query: query || raw?.query || '',
    page: raw?.page || 1,
    totalPages: raw?.totalPages || 1,
    items,
    streamableCount,
    catalogEnabled: raw?.catalogEnabled !== false,
    source: 'net27-search-hybrid',
  };
}

module.exports = { normalizeSearchResponse, normalizeItem, cleanTitle };
