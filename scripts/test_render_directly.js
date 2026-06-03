const axios = require('axios');

const RENDER_BASE = 'https://ott-backend-eg8y.onrender.com';

async function testRender() {
  console.log('=== TESTING RENDER SERVER V2 ENDPOINTS ===');

  console.log('\n[1] GET /api/v2/search?q=Superman...');
  try {
    const res = await axios.get(`${RENDER_BASE}/api/v2/search`, {
      params: { q: 'Superman' },
      timeout: 15000
    });
    console.log('  Status:', res.status);
    console.log('  Results Count:', res.data?.results?.length);
    if (res.data?.results?.length > 0) {
      console.log('  First Result Title:', res.data.results[0].title);
      console.log('  First Result Provider:', res.data.results[0].provider);
    } else {
      console.log('  Response Body:', res.data);
    }
  } catch (err) {
    console.error('  Failed Search:', err.message);
  }

  console.log('\n[2] GET /api/v2/stream/net52/81639323 (Leo - correct provider net52)...');
  try {
    const res = await axios.get(`${RENDER_BASE}/api/v2/stream/net52/81639323`, {
      timeout: 15000
    });
    console.log('  Status:', res.status);
    console.log('  Response Data:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('  Failed Stream:', err.message);
    if (err.response) {
      console.error('  Status:', err.response.status);
      console.error('  Headers:', err.response.headers);
      console.error('  Data:', err.response.data?.toString());
    }
  }
}

testRender().catch(console.error);
