const axios = require('axios');

const RENDER_BASE = 'https://ott-backend-eg8y.onrender.com';
const MOVIE_ID = '81639323'; // Leo

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollHealth() {
  console.log(`Polling health endpoint: ${RENDER_BASE}/health`);
  const maxAttempts = 30; // 5 minutes max
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.get(`${RENDER_BASE}/health`, { timeout: 8000 });
      if (res.status === 200) {
        console.log(`\n🎉 Render server is UP and healthy! (Attempt ${attempt})`);
        console.log('Response:', res.data);
        return true;
      }
    } catch (err) {
      process.stdout.write('.');
    }
    await sleep(10000); // 10 seconds
  }
  console.error('\n❌ Timeout waiting for Render server to deploy.');
  return false;
}

async function runRenderTests() {
  const ok = await pollHealth();
  if (!ok) return;

  console.log('\n=== RUNNING PRODUCTION VERIFICATION ON RENDER ===');

  // Test 1: V2 Search
  console.log('\n[Test 1] Testing Search API on Render...');
  const searchUrl = `${RENDER_BASE}/api/v2/search?q=Leo`;
  try {
    const res = await axios.get(searchUrl, { timeout: 15000 });
    console.log('  Status:', res.status);
    console.log('  Results Count:', res.data?.results?.length);
    if (res.data?.results?.length > 0) {
      console.log('  First Result:', JSON.stringify(res.data.results[0], null, 2));
    }
  } catch (err) {
    console.error('  ❌ Search API Failed:', err.message);
    return;
  }

  // Test 2: V2 Details
  console.log(`\n[Test 2] Testing Details API on Render for ID ${MOVIE_ID}...`);
  const detailsUrl = `${RENDER_BASE}/api/v2/details/net52/${MOVIE_ID}`;
  try {
    const res = await axios.get(detailsUrl, { timeout: 15000 });
    console.log('  Status:', res.status);
    console.log('  Title:', res.data?.results?.title);
  } catch (err) {
    console.error('  ❌ Details API Failed:', err.message);
    return;
  }

  // Test 3: V2 Stream Link Resolution
  console.log(`\n[Test 3] Testing Stream Resolution on Render for ID ${MOVIE_ID}...`);
  const streamUrl = `${RENDER_BASE}/api/v2/stream/net52/${MOVIE_ID}`;
  let streamInfo;
  try {
    const res = await axios.get(streamUrl, { timeout: 15000 });
    streamInfo = res.data;
    console.log('  Status:', res.status);
    console.log('  Streams:', JSON.stringify(streamInfo.streams, null, 2));
  } catch (err) {
    console.error('  ❌ Stream Resolution Failed:', err.message);
    return;
  }

  const streams = streamInfo?.streams || [];
  if (streams.length === 0) {
    console.error('  No streams returned.');
    return;
  }

  const masterProxyUrl = streams[0].url;
  console.log('  Extracted Master Proxy URL:', masterProxyUrl);
  if (masterProxyUrl.includes('in=::') || masterProxyUrl.includes('in=unknown::ni')) {
    console.error('  ❌ FAILED Test 3: Empty/invalid token returned by Render!');
    return;
  }
  console.log('  ✅ PASSED Test 3: Token is valid and non-empty!');

  // Test 4: Master Playlist Proxy
  console.log('\n[Test 4] Requesting Master Playlist through Render Proxy...');
  let masterBody = '';
  try {
    const res = await axios.get(masterProxyUrl, { timeout: 15000 });
    masterBody = res.data;
    console.log('  Status:', res.status);
    console.log('  Content-Type:', res.headers['content-type']);
    console.log('  Preview:');
    console.log(masterBody.slice(0, 300));
  } catch (err) {
    console.error('  ❌ FAILED Test 4 Master Playlist proxy:', err.message);
    return;
  }

  if (!masterBody.includes('#EXTM3U') || !masterBody.includes('#EXT-X-STREAM-INF')) {
    console.error('  ❌ FAILED Test 4: Response does not look like HLS playlist.');
    return;
  }
  console.log('  ✅ PASSED Test 4: Master playlist proxy works!');

  // Extract variant URL from master playlist body
  const lines = masterBody.split(/\r?\n/);
  let variantProxyUrl = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('http') && trimmed.includes('/stream/proxy')) {
      variantProxyUrl = trimmed;
      break;
    }
  }

  if (!variantProxyUrl) {
    console.error('  Could not find variant proxy URL.');
    return;
  }

  // Test 5: Variant Playlist Proxy
  console.log('\n[Test 5] Requesting Variant Playlist through Render Proxy...');
  console.log('  URL:', variantProxyUrl);
  let variantBody = '';
  try {
    const res = await axios.get(variantProxyUrl, { timeout: 15000 });
    variantBody = res.data;
    console.log('  Status:', res.status);
    console.log('  Preview:');
    console.log(variantBody.slice(0, 300));
  } catch (err) {
    console.error('  ❌ FAILED Test 5 Variant Playlist proxy:', err.message);
    return;
  }

  if (!variantBody.includes('#EXTM3U') || !variantBody.includes('#EXTINF')) {
    console.error('  ❌ FAILED Test 5: Response does not look like HLS segments.');
    return;
  }
  console.log('  ✅ PASSED Test 5: Variant playlist proxy works!');

  // Extract segment URL
  const variantLines = variantBody.split(/\r?\n/);
  let segmentProxyUrl = '';
  for (const line of variantLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('http') && trimmed.includes('/stream/proxy')) {
      segmentProxyUrl = trimmed;
      break;
    }
  }

  if (!segmentProxyUrl) {
    console.error('  Could not find segment proxy URL.');
    return;
  }

  // Test 6: Segment Delivery
  console.log('\n[Test 6] Requesting Segment through Render Proxy...');
  console.log('  URL:', segmentProxyUrl);
  try {
    const res = await axios.get(segmentProxyUrl, {
      responseType: 'arraybuffer',
      timeout: 20000
    });
    console.log('  Status:', res.status);
    console.log('  Content-Type:', res.headers['content-type']);
    console.log('  Content Length:', res.data?.length, 'bytes');

    const textPreview = Buffer.from(res.data).toString('utf8', 0, 100);
    if (textPreview.includes('Only Valid Users Allowed')) {
      console.error('  ❌ FAILED Test 6: CDN blocked Render server with "Only Valid Users Allowed"!');
      return;
    }

    console.log('  ✅ PASSED Test 6: Segment delivery works successfully on Render!');
    console.log('\n════════════════════════════════════════════════════');
    console.log('🎉 RENDER PRODUCTION VERIFICATION COMPLETE: ALL PASSED!');
    console.log('════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('  ❌ FAILED Test 6 Segment Delivery:', err.message);
  }
}

runRenderTests().catch(console.error);
