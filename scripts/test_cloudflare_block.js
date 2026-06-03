const axios = require('axios');

async function checkCloudflare() {
  const url = 'https://net11.cc/search.php';
  console.log(`Requesting ${url} to check for Cloudflare blocks...`);
  try {
    const res = await axios.get(url, {
      params: { s: 'superman' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 10000
    });
    console.log('Status:', res.status);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Preview of response:');
    console.log(res.data ? JSON.stringify(res.data).slice(0, 500) : 'No data');
  } catch (err) {
    console.error('Request failed!');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Headers:', err.response.headers);
      const body = err.response.data?.toString();
      console.error('Body preview:', body ? body.slice(0, 1000) : 'No body');
    } else {
      console.error('Error:', err.message);
    }
  }
}

checkCloudflare().catch(console.error);
