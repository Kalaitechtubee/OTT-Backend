const axios = require('axios');

async function testCORS() {
  const segmentUrl = 'https://s21.freecdn4.top/files/81728596/1080p/2094_000.jpg?in=54f52f455249c58270103387b68fa968::752ca9b5c3d43a164aac0a76e1763971::1780722054::ni';
  try {
    console.log('Sending request to segment URL...');
    const res = await axios({
      method: 'GET',
      url: segmentUrl,
      headers: {
        'Origin': 'http://localhost:5173',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'http://localhost:5173/'
      }
    });
    console.log('Status:', res.status);
    console.log('Headers:', res.headers);
  } catch (err) {
    console.error('Error fetching segment:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response headers:', err.response.headers);
    }
  }
}

testCORS();
