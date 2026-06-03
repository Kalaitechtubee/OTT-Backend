const axios = require('axios');

async function testUrl(url) {
  console.log(`Testing: ${url}`);
  try {
    const res = await axios.get(url, {
      params: {
        api_key: '5bc6f3e00a5718a03b7bec56352790c6',
        query: 'Superman'
      },
      timeout: 5000
    });
    console.log(`Success! Status: ${res.status}, Count: ${res.data?.results?.length}`);
    return true;
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    return false;
  }
}

async function run() {
  const domains = [
    'https://api.tmdb.org/3/search/multi',
    'https://api.themoviedb.org/3/search/multi'
  ];

  for (const d of domains) {
    await testUrl(d);
  }
}

run();
