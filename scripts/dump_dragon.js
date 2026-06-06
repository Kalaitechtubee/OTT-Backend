const axios = require('axios');

async function dump() {
  const base = 'http://localhost:8080';
  const id = '81762715';
  const provider = 'net11';

  console.log('--- Fetching stream details ---');
  const streamRes = await axios.get(`${base}/api/v2/stream/${provider}/${id}`);
  const masterUrl = streamRes.data.streams[0].url;
  console.log('Master Proxy URL:', masterUrl);

  console.log('\n--- Fetching Master Playlist ---');
  const masterRes = await axios.get(masterUrl);
  console.log(masterRes.data);

  // Extract first variant URL and audio URL
  const lines = masterRes.data.split('\n');
  const variantUrl = lines.find(l => l.startsWith('http') && l.includes('1080p'));
  const audioLine = lines.find(l => l.includes('TYPE=AUDIO') && l.includes('tam'));
  const audioUrl = audioLine ? audioLine.match(/URI="([^"]+)"/)[1] : null;

  console.log('\n--- Variant URL found:', variantUrl);
  console.log('--- Audio URL found:', audioUrl);

  if (variantUrl) {
    console.log('\n--- Fetching Variant Playlist ---');
    const variantRes = await axios.get(variantUrl);
    console.log(variantRes.data.slice(0, 1000));
  }

  if (audioUrl) {
    console.log('\n--- Fetching Audio Playlist ---');
    const audioRes = await axios.get(audioUrl);
    console.log(audioRes.data.slice(0, 1000));
  }
}

dump().catch(err => {
  console.error('Error:', err.message);
  if (err.response) {
    console.error(err.response.data);
  }
});
