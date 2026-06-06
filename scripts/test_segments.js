const axios = require('axios');

async function testSegments() {
  const base = 'http://localhost:8080';
  const id = '81728596';
  const provider = 'net11';

  console.log('--- Fetching stream details ---');
  const streamRes = await axios.get(`${base}/api/v2/stream/${provider}/${id}`);
  const masterUrl = streamRes.data.streams[0].url;

  console.log('--- Fetching Master Playlist ---');
  const masterRes = await axios.get(masterUrl);

  const lines = masterRes.data.split('\n');
  const variantUrl = lines.find(l => l.startsWith('http') && l.includes('1080p'));
  const audioLine = lines.find(l => l.includes('TYPE=AUDIO') && l.includes('tam'));
  const audioUrl = audioLine ? audioLine.match(/URI="([^"]+)"/)[1] : null;

  console.log('Variant URL:', variantUrl);
  console.log('Audio URL:', audioUrl);

  if (variantUrl) {
    console.log('\n--- Fetching Variant Playlist ---');
    const variantRes = await axios.get(variantUrl);
    const varLines = variantRes.data.split('\n');
    const firstVideoSegment = varLines.find(l => l.startsWith('http'));
    console.log('First Video Segment URL:', firstVideoSegment);
    
    if (firstVideoSegment) {
      try {
        const segRes = await axios.get(firstVideoSegment, { responseType: 'arraybuffer' });
        console.log(`  ✅ Video Segment Fetch Success: ${segRes.status}, length: ${segRes.data.length} bytes`);
      } catch (err) {
        console.error(`  ❌ Video Segment Fetch Failed: ${err.message}`);
        if (err.response) {
          console.error(Buffer.from(err.response.data).toString('utf8').slice(0, 200));
        }
      }
    }
  }

  if (audioUrl) {
    console.log('\n--- Fetching Audio Playlist ---');
    const audioRes = await axios.get(audioUrl);
    const audioLines = audioRes.data.split('\n');
    const firstAudioSegment = audioLines.find(l => l.startsWith('http'));
    console.log('First Audio Segment URL:', firstAudioSegment);

    if (firstAudioSegment) {
      try {
        const segRes = await axios.get(firstAudioSegment, { responseType: 'arraybuffer' });
        console.log(`  ✅ Audio Segment Fetch Success: ${segRes.status}, length: ${segRes.data.length} bytes`);
      } catch (err) {
        console.error(`  ❌ Audio Segment Fetch Failed: ${err.message}`);
        if (err.response) {
          console.error(Buffer.from(err.response.data).toString('utf8').slice(0, 200));
        }
      }
    }
  }
}

testSegments().catch(console.error);
