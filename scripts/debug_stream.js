require('dotenv').config();
const axios = require('axios');
const { getNet11Domain, getNet52Domain } = require('../src/v2/utils/axiosClient');

async function testNet52MasterPlaylistAndCDN() {
  const net11Domain = await getNet11Domain();
  const net52Domain = await getNet52Domain();
  const id = '70041963'; // Superman Returns

  console.log('[1] Get backend IP hash from Net11 play.php...');
  let playRes;
  try {
    playRes = await axios.post(`${net11Domain}/play.php`, `id=${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${net11Domain}/search`,
        'Origin': net11Domain
      }
    });
  } catch (err) {
    console.error('play.php failed:', err.message);
    return;
  }

  const playToken = playRes.data?.h;
  if (!playToken) return;
  const ipHash = playToken.replace(/^in=/, '').split('::')[0];
  console.log('Backend IP Hash:', ipHash);

  console.log('\n[2] GET playlist.php (Net52 direct stream flow)...');
  const now = Math.floor(Date.now() / 1000);
  let playlistRes;
  try {
    playlistRes = await axios.get(`${net52Domain}/pv/playlist.php`, {
      params: { id, t: now, tm: now },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `${net52Domain}/search`,
        'Origin': net52Domain
      }
    });
  } catch (err) {
    console.error('playlist.php failed:', err.message);
    return;
  }

  const entry = Array.isArray(playlistRes.data) ? playlistRes.data[0] : playlistRes.data;
  const playlistFile = entry?.sources?.[0]?.file;
  if (!playlistFile) {
    console.error('No sources in playlist:', playlistRes.data);
    return;
  }
  console.log('Playlist file URL returned:', playlistFile);

  const returnedToken = new URL(playlistFile, net52Domain).searchParams.get('in');
  console.log('Returned Token (stripped):', returnedToken);

  const reconstructedToken = `${ipHash}${returnedToken}`;
  console.log('Reconstructed Token for Net52:', reconstructedToken);

  // Construct master playlist path (removing domain if relative)
  const masterPath = new URL(playlistFile, net52Domain).pathname;
  const masterUrl = `${net52Domain}${masterPath}?in=${reconstructedToken}`;
  console.log('\n[3] Fetching Master Playlist directly from Net52...');
  console.log('Master URL:', masterUrl);

  let masterBody = '';
  try {
    const res = await axios.get(masterUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `${net52Domain}/search`,
        'Origin': net52Domain
      },
      timeout: 10000
    });
    masterBody = res.data;
    console.log('Master Playlist fetched successfully.');
  } catch (err) {
    console.error('Master Playlist fetch failed:', err.message);
    return;
  }

  // Parse CDN URL
  const cdnUrls = [];
  const lines = masterBody.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('http') && trimmed.includes('/files/')) {
      cdnUrls.push(trimmed);
    }
  }

  if (cdnUrls.length === 0) {
    console.error('Could not find any CDN URLs in master playlist:', masterBody);
    return;
  }

  const cdnUrl = cdnUrls[0];
  console.log('\n[4] Found CDN URL with preserved token:', cdnUrl);

  console.log('\n[5] Fetching CDN segment playlist from server...');
  const cdnHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': `${net52Domain}/play.php?id=${id}&in=${reconstructedToken}`,
    'Origin': net52Domain,
    'Accept': '*/*'
  };

  try {
    const res = await axios.get(cdnUrl, { headers: cdnHeaders, timeout: 10000 });
    console.log('CDN Response Status:', res.status);
    console.log('CDN Response Length:', res.data?.length);
    if (res.data && res.data.includes('#EXTINF')) {
      console.log('✅ SUCCESS! Net52 stream successfully fetched from server!');
    } else {
      console.log('❌ FAILED! CDN returned invalid contents.');
    }
  } catch (err) {
    console.error('CDN fetch failed:', err.message);
  }
}

testNet52MasterPlaylistAndCDN().catch(console.error);
