/**
 * Pre-deploy API smoke test for MovieZon backend.
 * Usage: node scripts/predeploy-smoke.js [baseUrl]
 * Default baseUrl: http://localhost:5000
 */

const axios = require('axios');

const BASE = (process.argv[2] || process.env.API_BASE || 'http://localhost:5000').replace(/\/$/, '');
const LANGS = ['Tamil', 'Telugu', 'Malayalam', 'Kannada'];
const HUB_CATEGORIES = ['trending', 'movies', 'series', 'dubbed', 'new_releases'];

const results = [];
let failCount = 0;

function pass(name, detail = '') {
  results.push({ status: 'PASS', name, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  failCount += 1;
  results.push({ status: 'FAIL', name, detail });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function warn(name, detail = '') {
  results.push({ status: 'WARN', name, detail });
  console.log(`  WARN  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path, opts = {}) {
  const url = `${BASE}${path}`;
  const maxAttempts = opts.retries429 != null ? opts.retries429 + 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await axios.get(url, {
      timeout: opts.timeout || 120000,
      validateStatus: () => true,
      ...opts,
    });
    if (res.status !== 429 || attempt === maxAttempts - 1) {
      return res;
    }
    await new Promise((r) => setTimeout(r, 3500));
  }
}

async function testHealth() {
  const res = await get('/health', { timeout: 10000 });
  if (res.status === 200 && res.data?.status === 'healthy') {
    pass('GET /health');
  } else {
    fail('GET /health', `status ${res.status}`);
  }
}

async function testSearch() {
  const res = await get('/api/catalog/search?q=mersal', { timeout: 60000 });
  if (res.status !== 200 || res.data?.ok !== true) {
    fail('GET /api/catalog/search?q=mersal', `status ${res.status}, ok=${res.data?.ok}`);
    return null;
  }
  const count = res.data.items?.length || 0;
  if (count === 0) {
    fail('GET /api/catalog/search?q=mersal', '0 items');
    return null;
  }
  pass('GET /api/catalog/search?q=mersal', `${count} items`);
  return res.data.items[0];
}

async function testTrending(language) {
  const q = language ? `?language=${encodeURIComponent(language)}` : '';
  const label = language || 'All';
  const res = await get(`/api/catalog/trending${q}`);
  if (res.status === 429) {
    fail(`GET /api/catalog/trending (${label})`, '429 rate limited');
    return null;
  }
  if (res.status !== 200 || res.data?.ok !== true) {
    fail(`GET /api/catalog/trending (${label})`, `status ${res.status}`);
    return null;
  }
  const rails = res.data.rails || [];
  const hero = res.data.hero || [];
  const railKeys = rails.map((r) => r.key).join(', ');
  const itemCounts = rails.map((r) => `${r.key}:${r.items?.length || 0}`).join(', ');
  if (rails.length === 0) {
    fail(`GET /api/catalog/trending (${label})`, 'no rails');
    return res.data;
  }
  if (language && !rails.some((r) => (r.items?.length || 0) > 0)) {
    fail(`GET /api/catalog/trending (${label})`, 'all rails empty');
    return res.data;
  }
  pass(
    `GET /api/catalog/trending (${label})`,
    `hero=${hero.length}, rails=${rails.length} [${itemCounts.slice(0, 120)}]`,
  );
  return res.data;
}

async function testCategory(language, category) {
  const res = await get(
    `/api/catalog/category/${category}?language=${encodeURIComponent(language)}`,
    { timeout: 30000 },
  );
  const label = `${language}/${category}`;
  if (res.status === 429) {
    fail(`GET /api/catalog/category/${category} (${language})`, '429');
    return;
  }
  if (res.status !== 200 || res.data?.ok !== true) {
    fail(`GET /api/catalog/category/${category} (${language})`, `status ${res.status}`);
    return;
  }
  const count = res.data.items?.length || 0;
  if (count === 0) {
    warn(`GET /api/catalog/category/${category} (${language})`, '0 items (may be sparse catalog)');
  } else {
    pass(`GET /api/catalog/category/${category} (${language})`, `${count} items`);
  }
}

async function testMoviesSeries(language) {
  for (const ep of ['movies', 'series']) {
    const res = await get(`/api/catalog/${ep}?language=${encodeURIComponent(language)}`, {
      timeout: 30000,
    });
    if (res.status !== 200 || res.data?.ok !== true) {
      fail(`GET /api/catalog/${ep} (${language})`, `status ${res.status}`);
      continue;
    }
    const count = res.data.items?.length || 0;
    if (count === 0) {
      warn(`GET /api/catalog/${ep} (${language})`, '0 items');
    } else {
      pass(`GET /api/catalog/${ep} (${language})`, `${count} items`);
    }
  }
}

async function testTitleDetails(item) {
  if (!item?.type || !item?.tmdbId) {
    warn('GET /api/catalog/title/:type/:tmdbId', 'skipped — no search item');
    return null;
  }
  const res = await get(`/api/catalog/title/${item.type}/${item.tmdbId}`, { timeout: 60000 });
  if (res.status !== 200 || res.data?.ok !== true) {
    fail('GET /api/catalog/title/:type/:tmdbId', `status ${res.status}`);
    return null;
  }
  pass('GET /api/catalog/title/:type/:tmdbId', `${item.type}/${item.tmdbId} "${res.data.title || item.title}"`);
  return { ...item, detail: res.data };
}

async function testLanguages(item) {
  if (!item?.type || !item?.tmdbId) {
    warn('GET /api/stream/languages/:type/:tmdbId', 'skipped');
    return null;
  }
  const params = new URLSearchParams();
  if (item.subjectId) params.set('sid', item.subjectId);
  if (item.detailPath) params.set('dp', item.detailPath);
  const qs = params.toString() ? `?${params}` : '';
  const res = await get(`/api/stream/languages/${item.type}/${item.tmdbId}${qs}`, {
    timeout: 60000,
  });
  if (res.status !== 200 || res.data?.ok !== true) {
    fail('GET /api/stream/languages/:type/:tmdbId', `status ${res.status}`);
    return null;
  }
  const variants = res.data.variants?.length || 0;
  pass('GET /api/stream/languages/:type/:tmdbId', `${variants} variants`);
  return res.data;
}

async function testPlay(item, langData) {
  if (!item?.tmdbId) {
    warn('GET /api/stream/play/:tmdbId', 'skipped');
    return;
  }
  const params = new URLSearchParams();
  if (item.type === 'tv') params.set('type', 'tv');
  if (item.subjectId) params.set('sid', item.subjectId);
  if (item.detailPath) params.set('dp', item.detailPath);
  const tamil = langData?.variants?.find((v) =>
    (v.language || '').toLowerCase().includes('tamil'),
  );
  if (tamil?.dubSubjectId) params.set('sid', tamil.dubSubjectId);

  const res = await get(`/api/stream/play/${item.tmdbId}?${params}`, {
    timeout: 90000,
    retries429: 1,
  });
  if (res.status === 429) {
    fail('GET /api/stream/play/:tmdbId', '429 rate limited');
    return;
  }
  if (res.status === 502) {
    // Net27 embed can fail briefly after catalog language probes — retry once
    await new Promise((r) => setTimeout(r, 4000));
    const retry = await get(`/api/stream/play/${item.tmdbId}?${params}`, { timeout: 90000 });
    if (retry.status === 200 && retry.data?.ok === true) {
      const streams = retry.data.streams?.length || 0;
      pass('GET /api/stream/play/:tmdbId', `${streams} quality tiers (recovered after 502)`);
      return;
    }
    fail(
      'GET /api/stream/play/:tmdbId',
      `502 upstream — ${retry.data?.error || res.data?.error || 'Net27 embed unavailable'}`,
    );
    return;
  }
  if (res.status !== 200) {
    fail('GET /api/stream/play/:tmdbId', `status ${res.status} — ${res.data?.error || ''}`);
    return;
  }
  if (res.data?.ok !== true) {
    warn('GET /api/stream/play/:tmdbId', res.data?.error || 'ok=false (CF probe may block datacenter IP)');
    return;
  }
  const streams = res.data.streams?.length || 0;
  pass('GET /api/stream/play/:tmdbId', `${streams} quality tiers`);
}

async function main() {
  console.log(`\nMovieZon pre-deploy smoke test`);
  console.log(`Base URL: ${BASE}\n`);

  const start = Date.now();

  console.log('── Core ──');
  await testHealth();

  console.log('\n── Search ──');
  const searchItem = await testSearch();

  console.log('\n── Trending (all + South Indian languages) ──');
  await testTrending();
  for (const lang of LANGS) {
    await testTrending(lang);
  }

  console.log('\n── Language hub categories (Tamil sample) ──');
  for (const cat of HUB_CATEGORIES) {
    await testCategory('Tamil', cat);
  }

  console.log('\n── Movies & Series per language ──');
  for (const lang of LANGS) {
    await testMoviesSeries(lang);
  }

  console.log('\n── Details / Stream ──');
  const detailItem = await testTitleDetails(searchItem);
  const langData = await testLanguages(detailItem || searchItem);
  await testPlay(detailItem || searchItem, langData);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const passed = results.filter((r) => r.status === 'PASS').length;
  const warned = results.filter((r) => r.status === 'WARN').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log('\n══════════════════════════════════════');
  console.log(`Done in ${elapsed}s — PASS: ${passed}  WARN: ${warned}  FAIL: ${failed}`);
  console.log('══════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Blocking failures:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  • ${r.name}: ${r.detail}`));
    process.exit(1);
  }
  if (warned > 0) {
    console.log('Non-blocking warnings (review before deploy):');
    results.filter((r) => r.status === 'WARN').forEach((r) => console.log(`  • ${r.name}: ${r.detail}`));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  process.exit(1);
});
