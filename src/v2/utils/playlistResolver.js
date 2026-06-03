const axios = require('axios');

function hasValidToken(fileUrl = '') {
  const value = String(fileUrl || '');
  return value.includes('in=') && !value.includes('in=unknown::ni');
}

function getEntry(data) {
  return Array.isArray(data) ? data[0] : data;
}

function isValidPlaylistData(data) {
  const entry = getEntry(data);
  if (!entry || !Array.isArray(entry.sources) || entry.sources.length === 0) {
    return false;
  }

  return entry.sources.some((source) => hasValidToken(source?.file || ''));
}

async function resolvePlaylistWithFallbacks({
  candidates = [],
  params = {},
  timeout = 12000
}) {
  for (const candidate of candidates) {
    try {
      const response = await axios({
        method: 'GET',
        url: candidate.url,
        params,
        headers: candidate.headers || {},
        timeout
      });

      if (isValidPlaylistData(response?.data)) {
        return {
          candidate,
          data: response.data,
          entry: getEntry(response.data)
        };
      }
    } catch (_err) {
      // Fallback to next candidate.
    }
  }

  return null;
}

module.exports = {
  hasValidToken,
  isValidPlaylistData,
  resolvePlaylistWithFallbacks
};
