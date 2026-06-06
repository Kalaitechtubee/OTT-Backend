const axios = require('axios');

async function testProdApi() {
  const base = 'http://54.84.77.220:8080';
  console.log(`=== RUNNING PRODUCTION API VERIFICATION FOR: ${base} ===\n`);

  const results = {
    health: { success: false, data: null, error: null },
    trending: { success: false, count: 0, error: null },
    search: { success: false, count: 0, error: null },
    details: { success: false, data: null, error: null },
    stream: { success: false, resolvedSources: [], errors: [] },
    proxy: { success: false, details: null, error: null }
  };

  // 1. Health check
  console.log('[Test 1/6] Checking GET /health...');
  try {
    const res = await axios.get(`${base}/health`);
    results.health.success = res.status === 200;
    results.health.data = res.data;
    console.log(`  ✅ Health check PASSED: Status ${res.status}, version ${res.data.version}\n`);
  } catch (err) {
    results.health.error = err.message;
    console.error(`  ❌ Health check FAILED: ${err.message}\n`);
  }

  // 2. Trending Catalog
  console.log('[Test 2/6] Checking GET /api/v2/tmdb/trending?time=week...');
  try {
    const res = await axios.get(`${base}/api/v2/tmdb/trending?time=week`);
    results.trending.success = res.data?.success === true;
    results.trending.count = res.data?.results?.length || 0;
    console.log(`  ✅ Trending catalog PASSED: Found ${results.trending.count} items\n`);
  } catch (err) {
    results.trending.error = err.message;
    console.error(`  ❌ Trending catalog FAILED: ${err.message}\n`);
  }

  // 3. Search
  console.log('[Test 3/6] Checking GET /api/v2/search?q=Leo...');
  try {
    const res = await axios.get(`${base}/api/v2/search?q=Leo`);
    results.search.success = res.data?.success === true;
    results.search.count = res.data?.results?.length || 0;
    console.log(`  ✅ Search PASSED: Found ${results.search.count} results for "Leo"\n`);
  } catch (err) {
    results.search.error = err.message;
    console.error(`  ❌ Search FAILED: ${err.message}\n`);
  }

  // 4. Details by TMDB ID (Leo: 1075794)
  let tmdbId = '1075794';
  let sources = [];
  console.log(`[Test 4/6] Checking GET /api/v2/details/tmdb/${tmdbId}?type=movie...`);
  try {
    const res = await axios.get(`${base}/api/v2/details/tmdb/${tmdbId}?type=movie`);
    results.details.success = res.data?.success === true;
    results.details.data = res.data?.results;
    sources = res.data?.results?.sources || [];
    console.log(`  ✅ Details PASSED: Title: "${res.data?.results?.title}", Sources Found: ${sources.length}`);
    console.log(`  Audio Languages: [${(res.data?.results?.audioLanguages || []).join(', ')}]\n`);
  } catch (err) {
    results.details.error = err.message;
    console.error(`  ❌ Details FAILED: ${err.message}\n`);
  }

  // 5. Stream resolution
  if (sources.length === 0) {
    console.log('[Test 5/6] Skipping stream resolution (no sources found in details)\n');
  } else {
    console.log(`[Test 5/6] Checking stream resolution for ${sources.length} sources...`);
    let workingStreamUrl = null;
    let workingProvider = null;
    let workingId = null;

    for (const src of sources) {
      console.log(`  Attempting GET /api/v2/stream/${src.provider}/${src.id}...`);
      try {
        const res = await axios.get(`${base}/api/v2/stream/${src.provider}/${src.id}`, { timeout: 10000 });
        if (res.data?.success && res.data?.streams?.length > 0) {
          results.stream.success = true;
          results.stream.resolvedSources.push({
            provider: src.provider,
            id: src.id,
            streamsCount: res.data.streams.length
          });
          workingStreamUrl = res.data.streams[0].url;
          workingProvider = src.provider;
          workingId = src.id;
          console.log(`    ✅ SUCCESS: Resolved ${res.data.streams.length} stream qualities.`);
        } else {
          results.stream.errors.push({ provider: src.provider, id: src.id, error: 'Empty streams array' });
          console.log(`    ❌ FAILED: Succeeded but returned empty stream array.`);
        }
      } catch (err) {
        const errorMsg = err.response?.data?.error || err.message;
        results.stream.errors.push({ provider: src.provider, id: src.id, error: errorMsg });
        console.log(`    ❌ FAILED for ${src.provider}/${src.id}: ${errorMsg}`);
      }
    }

    console.log();

    // 6. Proxy test
    if (workingStreamUrl) {
      console.log('[Test 6/6] Checking proxy HLS playlist fetch...');
      console.log(`  URL: ${workingStreamUrl}`);
      try {
        const res = await axios.get(workingStreamUrl);
        results.proxy.success = res.status === 200;
        results.proxy.details = {
          status: res.status,
          contentType: res.headers['content-type'],
          preview: res.data?.slice(0, 250)
        };
        if (res.data?.includes('#EXTM3U')) {
          console.log('  ✅ Proxy fetch PASSED: Valid HLS master playlist returned.');
        } else {
          results.proxy.success = false;
          results.proxy.error = 'Response does not contain #EXTM3U header';
          console.error('  ❌ Proxy fetch FAILED: Playlist body lacks #EXTM3U.');
        }
      } catch (err) {
        results.proxy.error = err.message;
        console.error(`  ❌ Proxy fetch FAILED: ${err.message}`);
      }
    } else {
      console.log('[Test 6/6] Skipping proxy test (no streams resolved successfully)\n');
    }
  }

  console.log('\n=== VERIFICATION SUMMARY ===');
  console.log(`1. Health Check:      ${results.health.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`2. Trending Catalog:  ${results.trending.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`3. Search API:        ${results.search.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`4. Title Details:     ${results.details.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`5. Stream Resolution: ${results.stream.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`6. Stream Proxy:      ${results.proxy.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('============================\n');

  if (!results.stream.success) {
    console.error('⚠️ FAILURE DIAGNOSIS:');
    console.error('  Stream resolution failed on the production server.');
    console.error('  Local stream resolution is working. This indicates that:');
    console.error('    1. The production server cookies (NET11_COOKIE and NET52_COOKIE) in its .env file are expired or missing.');
    console.error('    2. Fresh cookies must be extracted from the browser network tab and updated in the production .env file.');
  }
}

testProdApi().catch(console.error);
