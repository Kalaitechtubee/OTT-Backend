const net27 = require('./net27');

function getItemsFromOriginalMatches(rails, keywords) {
  const items = [];
  const seen = new Set();
  if (rails) {
    rails.forEach((rail) => {
      const title = rail.title.toLowerCase();
      if (keywords.some((kw) => title.includes(kw))) {
        if (rail.items) {
          rail.items.forEach((item) => {
            const key = `${item.type}_${item.tmdbId}`;
            if (!seen.has(key)) {
              seen.add(key);
              items.push(item);
            }
          });
        }
      }
    });
  }
  return items;
}

/**
 * Build language-filtered catalog rails from raw Net27 trending data.
 */
async function buildFilteredCatalog(rawData, language) {
  const activeLang = language || 'All Languages';
  const langLower = activeLang.toLowerCase().trim();
  const isLangSelected = activeLang && activeLang !== 'All Languages';

  const itemsMap = new Map();
  if (rawData.rails) {
    rawData.rails.forEach((rail) => {
      if (rail.items) {
        rail.items.forEach((item) => {
          const key = `${item.type}_${item.tmdbId}`;
          if (!itemsMap.has(key)) {
            itemsMap.set(key, item);
          }
        });
      }
    });
  }
  if (rawData.hero) {
    rawData.hero.forEach((h) => {
      const key = `${h.type}_${h.tmdbId}`;
      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          tmdbId: h.tmdbId,
          type: h.type,
          title: h.title,
          rating: h.rating,
          poster: h.poster || '',
          backdrop: h.backdropUrl || h.backdrop,
        });
      } else {
        const existing = itemsMap.get(key);
        if (!existing.backdrop && (h.backdropUrl || h.backdrop)) {
          existing.backdrop = h.backdropUrl || h.backdrop;
        }
      }
    });
  }
  const itemsList = Array.from(itemsMap.values());

  const langResults = await Promise.all(
    itemsList.map(async (item) => {
      try {
        const variantsData = await net27.getLanguages(item.type, item.tmdbId, {
          sid: item.subjectId,
          dp: item.detailPath,
        });
        return { item, variantsData };
      } catch (_) {
        return { item, variantsData: null };
      }
    }),
  );

  const itemLanguages = new Map();
  langResults.forEach(({ item, variantsData }) => {
    const originalLangs = [];
    const dubLangs = [];
    if (variantsData && variantsData.variants) {
      variantsData.variants.forEach((v) => {
        if (v.isOriginal) {
          originalLangs.push(v.language.toLowerCase());
        } else {
          dubLangs.push(v.language.toLowerCase());
        }
      });
    }
    itemLanguages.set(`${item.type}_${item.tmdbId}`, { originalLangs, dubLangs });
  });

  const isNativeLang = (item) => {
    if (!isLangSelected) return true;
    const langs = itemLanguages.get(`${item.type}_${item.tmdbId}`);
    if (!langs) return false;
    return langs.originalLangs.some((l) => l.includes(langLower));
  };

  const isDubbedLang = (item) => {
    if (!isLangSelected) return false;
    const langs = itemLanguages.get(`${item.type}_${item.tmdbId}`);
    if (!langs) return false;
    return langs.dubLangs.some((l) => l.includes(langLower));
  };

  const supportsLang = (item) => {
    if (!isLangSelected) return true;
    return isNativeLang(item) || isDubbedLang(item);
  };

  const sortPreferredFirst = (items) => {
    if (!isLangSelected) return items;
    const sorted = [...items];
    sorted.sort((a, b) => {
      const aSupports = supportsLang(a);
      const bSupports = supportsLang(b);
      if (aSupports && !bSupports) return -1;
      if (!aSupports && bSupports) return 1;
      return 0;
    });
    return sorted;
  };

  const filterByLang = (items) => {
    if (!isLangSelected) return items;
    return items.filter((item) => supportsLang(item));
  };

  const filteredRails = [];

  const rawTrending = getItemsFromOriginalMatches(rawData.rails, ['trending', 'top 10', 'popular']);
  const trendingItems = sortPreferredFirst(
    filterByLang(rawTrending.length > 0 ? rawTrending : itemsList),
  ).slice(0, 30);
  filteredRails.push({
    key: 'trending',
    title: isLangSelected ? `Trending ${activeLang}` : 'Trending Now',
    ranked: true,
    items: trendingItems,
  });

  const rawNew = getItemsFromOriginalMatches(rawData.rails, ['newest', 'latest', 'hot new', 'fresh']);
  const newItems = sortPreferredFirst(
    filterByLang(rawNew.length > 0 ? rawNew : itemsList),
  ).slice(0, 30);
  filteredRails.push({
    key: 'new_releases',
    title: isLangSelected ? `New ${activeLang} Releases` : 'New Releases',
    ranked: false,
    items: newItems,
  });

  if (isLangSelected) {
    const nativeMovies = itemsList
      .filter((item) => item.type === 'movie' && isNativeLang(item))
      .slice(0, 30);
    if (nativeMovies.length > 0) {
      filteredRails.push({
        key: 'native_movies_lang',
        title: `${activeLang} Movies`,
        ranked: false,
        items: nativeMovies,
      });
    }

    const dubbedMovies = itemsList
      .filter((item) => item.type === 'movie' && isDubbedLang(item))
      .slice(0, 30);
    if (dubbedMovies.length > 0) {
      filteredRails.push({
        key: 'dubbed_movies_lang',
        title: `${activeLang} Dubbed Movies`,
        ranked: false,
        items: dubbedMovies,
      });
    }

    const langTV = itemsList
      .filter((item) => item.type === 'tv' && supportsLang(item))
      .slice(0, 30);
    if (langTV.length > 0) {
      filteredRails.push({
        key: 'tv_shows_lang',
        title: `${activeLang} Series`,
        ranked: false,
        items: langTV,
      });
    }
  }

  const popularMovies = filterByLang(itemsList.filter((item) => item.type === 'movie')).slice(0, 30);
  filteredRails.push({
    key: 'popular_movies',
    title: isLangSelected ? `Popular in ${activeLang}` : 'Popular Movies',
    ranked: false,
    items: popularMovies,
  });

  const actionMovies = filterByLang(
    getItemsFromOriginalMatches(rawData.rails, ['action', 'thriller']).filter((item) => item.type === 'movie'),
  ).slice(0, 30);
  filteredRails.push({
    key: 'action_movies',
    title: isLangSelected ? `${activeLang} Action` : 'Action Movies',
    ranked: false,
    items: actionMovies.length > 0 ? actionMovies : popularMovies.slice(0, 15),
  });

  const comedyMovies = filterByLang(
    getItemsFromOriginalMatches(rawData.rails, ['comedy']).filter((item) => item.type === 'movie'),
  ).slice(0, 30);
  filteredRails.push({
    key: 'comedy_movies',
    title: isLangSelected ? `${activeLang} Comedy` : 'Comedy Movies',
    ranked: false,
    items: comedyMovies.length > 0 ? comedyMovies : popularMovies.slice(5, 20),
  });

  const horrorMovies = filterByLang(
    getItemsFromOriginalMatches(rawData.rails, ['horror', 'thriller', 'scary']).filter(
      (item) => item.type === 'movie',
    ),
  ).slice(0, 30);
  filteredRails.push({
    key: 'horror_movies',
    title: isLangSelected ? `${activeLang} Horror` : 'Horror Movies',
    ranked: false,
    items: horrorMovies.length > 0 ? horrorMovies : popularMovies.slice(3, 18),
  });

  const romanceMovies = filterByLang(
    getItemsFromOriginalMatches(rawData.rails, ['romance', 'love', 'drama']).filter(
      (item) => item.type === 'movie',
    ),
  ).slice(0, 30);
  filteredRails.push({
    key: 'romance_movies',
    title: isLangSelected ? `${activeLang} Romance` : 'Romance Movies',
    ranked: false,
    items: romanceMovies.length > 0 ? romanceMovies : popularMovies.slice(8, 23),
  });

  const popularTV = filterByLang(itemsList.filter((item) => item.type === 'tv')).slice(0, 30);
  filteredRails.push({
    key: 'popular_tv',
    title: isLangSelected ? `${activeLang} TV Shows` : 'Popular TV Shows',
    ranked: false,
    items: popularTV,
  });

  return {
    tab: rawData.tab,
    hero: sortPreferredFirst(filterByLang(rawData.hero || [])).slice(0, 5),
    rails: filteredRails,
    itemsList,
    supportsLang,
    isNativeLang,
    isDubbedLang,
    sortPreferredFirst,
    filterByLang,
    activeLang,
    isLangSelected,
  };
}

function getRailItems(catalog, key) {
  const rail = catalog.rails.find((r) => r.key === key);
  return rail?.items || [];
}

function getCategoryItems(catalog, category) {
  const { itemsList, supportsLang, isNativeLang, isDubbedLang, filterByLang, sortPreferredFirst, isLangSelected } =
    catalog;

  switch (category) {
    case 'movies':
      return isLangSelected
        ? itemsList.filter((item) => item.type === 'movie' && isNativeLang(item))
        : itemsList.filter((item) => item.type === 'movie');
    case 'dubbed':
      return itemsList.filter((item) => item.type === 'movie' && isDubbedLang(item));
    case 'series':
      return isLangSelected
        ? itemsList.filter((item) => item.type === 'tv' && supportsLang(item))
        : itemsList.filter((item) => item.type === 'tv');
    case 'trending':
      return getRailItems(catalog, 'trending');
    case 'new_releases':
      return getRailItems(catalog, 'new_releases');
    case 'action':
      return getRailItems(catalog, 'action_movies');
    case 'comedy':
      return getRailItems(catalog, 'comedy_movies');
    case 'horror':
      return getRailItems(catalog, 'horror_movies');
    case 'romance':
      return getRailItems(catalog, 'romance_movies');
    default:
      return sortPreferredFirst(filterByLang(itemsList)).slice(0, 30);
  }
}

module.exports = {
  buildFilteredCatalog,
  getCategoryItems,
  getItemsFromOriginalMatches,
};
