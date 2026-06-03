const axios = require('axios');

async function testNet11Details() {
  console.log('--- Testing Net11 Details & Play ---');
  try {
    const id = '70041963'; // Superman Returns
    const detailsRes = await axios.get(`https://net11.cc/post.php?id=${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 10000
    });
    console.log('Net11 Details Success! Status:', detailsRes.status);
    console.log('Net11 Details Result Preview:', JSON.stringify(detailsRes.data).substring(0, 300));

    // Test Play
    const playRes = await axios.post(`https://net11.cc/play.php`, `id=${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 10000
    });
    console.log('Net11 Play Token Success! Status:', playRes.status);
    console.log('Net11 Play Token Response:', JSON.stringify(playRes.data));

    if (playRes.data && playRes.data.h) {
      const playToken = playRes.data.h;
      console.log('Testing Net11 m3u8 playlist fetch with token:', playToken);
      const playlistRes = await axios.get(`https://net11.cc/hls/${id}.m3u8?${playToken}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000
      });
      console.log('Net11 m3u8 Playlist Success! Status:', playlistRes.status);
      console.log('Net11 Playlist Content Preview:\n', playlistRes.data.substring(0, 500));
    }
  } catch (err) {
    console.error('Net11 Details/Play Failed:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', typeof err.response.data === 'string' ? err.response.data.substring(0, 300) : err.response.data);
    }
  }
}

async function testNet52Details() {
  console.log('\n--- Testing Net52 Details & Playlist ---');
  try {
    const id = '70041963'; // Superman Returns
    const detailsRes = await axios.get(`https://net52.cc/pv/post.php?id=${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 10000
    });
    console.log('Net52 Details Success! Status:', detailsRes.status);
    console.log('Net52 Details Result Preview:', JSON.stringify(detailsRes.data).substring(0, 300));

    // Test Playlist
    const playlistRes = await axios.get(`https://net52.cc/pv/playlist.php?id=${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 10000
    });
    console.log('Net52 Playlist Success! Status:', playlistRes.status);
    console.log('Net52 Playlist Response:', JSON.stringify(playlistRes.data).substring(0, 500));
  } catch (err) {
    console.error('Net52 Details/Playlist Failed:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', typeof err.response.data === 'string' ? err.response.data.substring(0, 300) : err.response.data);
    }
  }
}

async function run() {
  await testNet11Details();
  await testNet52Details();
}

run();
