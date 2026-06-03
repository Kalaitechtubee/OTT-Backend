require('dotenv').config();
const sourceManager = require('./services/sourceManager');

async function testSearch() {
  console.log('\n--- 1. Testing Parallel Search (Net11 + Net52 + TMDB) ---');
  try {
    const results = await sourceManager.search('Superman Returns');
    console.log('Search returned', results.length, 'results');
    if (results.length > 0) {
      console.log('First result preview:', JSON.stringify(results[0], null, 2));
      return results;
    }
  } catch (err) {
    console.error('Search failed:', err);
  }
  return [];
}

async function testDetails(provider, id, title) {
  console.log(`\n--- 2. Testing Details (${provider} / ${id}) ---`);
  try {
    const details = await sourceManager.details(provider, id, {}, title);
    console.log('Details response preview:', JSON.stringify(details, null, 2));
  } catch (err) {
    console.error('Details failed:', err);
  }
}

async function testStream(provider, id) {
  console.log(`\n--- 3. Testing Stream Link Resolution (${provider} / ${id}) ---`);
  try {
    const streamInfo = await sourceManager.stream(provider, id);
    console.log('Stream result preview:', JSON.stringify(streamInfo, null, 2));
  } catch (err) {
    console.error('Stream failed:', err);
  }
}

async function run() {
  const searchResults = await testSearch();

  // Pick first net11 and net52 item for details and stream tests
  const net11Item = searchResults.find(r => r.provider === 'net11');
  const net52Item = searchResults.find(r => r.provider === 'net52');

  if (net11Item) {
    await testDetails('net11', net11Item.id, net11Item.title);
    await testStream('net11', net11Item.id);
  } else {
    console.log('\nNo Net11 search result found to test Details/Stream');
  }

  if (net52Item) {
    await testDetails('net52', net52Item.id, net52Item.title);
    await testStream('net52', net52Item.id);
  } else {
    console.log('\nNo Net52 search result found to test Details/Stream');
  }
}

run();
