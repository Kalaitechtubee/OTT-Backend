const axios = require('axios');

async function dumpRawAudio() {
  const base = 'http://localhost:8080';
  const id = '81728596';
  const provider = 'net11';

  console.log('--- Fetching stream details ---');
  const streamRes = await axios.get(`${base}/api/v2/stream/${provider}/${id}`);
  const masterUrl = streamRes.data.streams[0].url;

  console.log('--- Fetching Master Playlist ---');
  const masterRes = await axios.get(masterUrl);
  
  const lines = masterRes.data.split('\n');
  const audioLine = lines.find(l => l.includes('TYPE=AUDIO') && l.includes('tam'));
  const audioProxyUrl = audioLine ? audioLine.match(/URI="([^"]+)"/)[1] : null;

  if (audioProxyUrl) {
    // Extract the raw 'u' parameter from the proxy URL to call the CDN directly
    const uParam = new URL(audioProxyUrl).searchParams.get('u');
    console.log('Raw Audio Playlist URL:', uParam);

    try {
      const rawRes = await axios.get(uParam);
      console.log('\n--- RAW UPSTREAM AUDIO PLAYLIST CONTENT ---');
      console.log(rawRes.data);
    } catch (err) {
      console.error('Failed to fetch raw audio playlist:', err.message);
    }
  } else {
    console.log('No Tamil audio track found in master playlist.');
  }
}

dumpRawAudio().catch(console.error);
