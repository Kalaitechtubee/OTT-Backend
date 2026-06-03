const axios = require('axios');

async function verifyPlaybackChain() {
  console.log('=== RUNNING PLAYBACK CHAIN VERIFICATION ===');
  const base = 'http://localhost:5000';
  
  // Test 1: Query stream API
  console.log('\n[Test 1] Querying GET /api/v2/stream/net11/70041963...');
  let streamRes;
  try {
    streamRes = await axios.get(`${base}/api/v2/stream/net11/70041963`);
    console.log('  Status:', streamRes.status);
    console.log('  Response Data:', JSON.stringify(streamRes.data, null, 2));
  } catch (err) {
    console.error('  Failed Test 1:', err.message);
    return;
  }

  const streams = streamRes.data?.streams || [];
  if (streams.length === 0) {
    console.error('  No streams returned in Test 1.');
    return;
  }

  const masterProxyUrl = streams[0].url;
  console.log('  Extracted Master Proxy URL:', masterProxyUrl);
  if (masterProxyUrl.includes('in=::') || masterProxyUrl.includes('in=unknown::ni')) {
    console.error('  ❌ FAILED Test 1: Empty or unknown IP token found in master URL.');
    return;
  }
  console.log('  ✅ PASSED Test 1: Master URL contains non-empty IP token.');

  // Test 2: Open returned proxy URL
  console.log('\n[Test 2] Requesting Master Playlist through Proxy...');
  console.log('  URL:', masterProxyUrl);
  let masterBody = '';
  try {
    const res = await axios.get(masterProxyUrl);
    masterBody = res.data;
    console.log('  Status:', res.status);
    console.log('  Content-Type:', res.headers['content-type']);
    console.log('  Preview:');
    console.log(masterBody.slice(0, 300));
  } catch (err) {
    console.error('  Failed Test 2:', err.message);
    if (err.response) {
      console.error('  Status:', err.response.status);
      console.error('  Headers:', err.response.headers);
      console.error('  Data:', err.response.data?.toString());
    }
    return;
  }

  if (!masterBody.includes('#EXTM3U') || !masterBody.includes('#EXT-X-STREAM-INF')) {
    console.error('  ❌ FAILED Test 2: Master playlist does not contain standard HLS headers.');
    return;
  }
  console.log('  ✅ PASSED Test 2: Master playlist contains EXTM3U and EXT-X-STREAM-INF.');

  // Extract first variant playlist URL from the master body
  // The master playlist body has rewritten variant URLs pointing to our proxy
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
    console.error('  Could not parse variant proxy URL from master playlist body.');
    return;
  }

  // Test 3: Open one variant playlist
  console.log('\n[Test 3] Requesting Variant Playlist through Proxy...');
  console.log('  URL:', variantProxyUrl);
  let variantBody = '';
  try {
    const res = await axios.get(variantProxyUrl);
    variantBody = res.data;
    console.log('  Status:', res.status);
    console.log('  Content-Type:', res.headers['content-type']);
    console.log('  Preview:');
    console.log(variantBody.slice(0, 300));
  } catch (err) {
    console.error('  Failed Test 3:', err.message);
    if (err.response) {
      console.error('  Status:', err.response.status);
      console.error('  Headers:', err.response.headers);
      console.error('  Data:', err.response.data?.toString());
    }
    return;
  }

  if (!variantBody.includes('#EXTM3U') || !variantBody.includes('#EXTINF')) {
    console.error('  ❌ FAILED Test 3: Variant playlist does not contain standard HLS segment listings.');
    return;
  }
  console.log('  ✅ PASSED Test 3: Variant playlist contains EXTM3U and EXTINF segments.');

  // Extract first segment URL from the variant body
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
    console.error('  Could not parse segment proxy URL from variant playlist body.');
    return;
  }

  // Test 4: Open one actual segment
  console.log('\n[Test 4] Requesting Video Segment through Proxy...');
  console.log('  URL:', segmentProxyUrl);
  try {
    const res = await axios.get(segmentProxyUrl, {
      responseType: 'arraybuffer'
    });
    console.log('  Status:', res.status);
    console.log('  Content-Type:', res.headers['content-type']);
    console.log('  Content Length:', res.data?.length, 'bytes');
    
    // Check if body is "Only Valid Users Allowed"
    const textPreview = Buffer.from(res.data).toString('utf8', 0, 100);
    if (textPreview.includes('Only Valid Users Allowed')) {
      console.error('  ❌ FAILED Test 4: CDN returned "Only Valid Users Allowed" instead of video bytes!');
      return;
    }
    
    console.log('  ✅ PASSED Test 4: Video segment fetched successfully!');
    console.log('\n═══════════════════════════════════════════');
    console.log('🎉 ALL PLAYBACK CHAIN TESTS PASSED!');
    console.log('═══════════════════════════════════════════');
  } catch (err) {
    console.error('  Failed Test 4:', err.message);
    if (err.response) {
      console.error('  Status:', err.response.status);
      console.error('  Data:', Buffer.from(err.response.data).toString('utf8'));
    }
  }
}

verifyPlaybackChain().catch(console.error);
