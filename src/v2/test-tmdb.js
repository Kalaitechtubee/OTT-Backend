const axios = require('axios');
require('dotenv').config();

async function testTMDB() {
  const apiKey = process.env.TMDB_API_KEY || '5bc6f3e00a5718a03b7bec56352790c6';
  const baseUrl = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
  console.log(`Using TMDB Base URL: ${baseUrl}`);
  console.log(`Using TMDB API Key: ${apiKey}`);

  try {
    const res = await axios.get(`${baseUrl}/search/multi`, {
      params: {
        api_key: apiKey,
        query: 'Superman'
      },
      timeout: 5000
    });
    console.log('TMDB Success! Status:', res.status);
    console.log('TMDB Results count:', res.data?.results?.length);
    if (res.data?.results?.length > 0) {
      console.log('First result title:', res.data.results[0].title || res.data.results[0].name);
    }
  } catch (err) {
    console.error('TMDB Failed:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
  }
}

testTMDB();
