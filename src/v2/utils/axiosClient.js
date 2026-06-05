const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Mirror list fallbacks
const NET11_DOMAINS = [
  'https://net11.cc',
  'https://net52.cc',
  'https://net22.cc'
];

const NET52_DOMAINS = [
  'https://net52.cc',
  'https://net11.cc',
  'https://net22.cc'
];

let cachedNet11Domain = 'https://net11.cc';
let cachedNet52Domain = 'https://net52.cc';
let lastProbeNet11 = 0;
let lastProbeNet52 = 0;
const PROBE_TTL = 10 * 60 * 1000; // 10 minutes

async function probeDomain(url, path = '/search.php') {
  try {
    const res = await axios.get(`${url}${path}`, {
      params: { s: 'superman' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 3000
    });
    return res.status === 200 && res.data && (res.data.searchResult || res.data.head);
  } catch (err) {
    return false;
  }
}

async function getNet11Domain() {
  const now = Date.now();
  if (now - lastProbeNet11 < PROBE_TTL) {
    return cachedNet11Domain;
  }
  for (const domain of NET11_DOMAINS) {
    if (await probeDomain(domain, '/search.php')) {
      cachedNet11Domain = domain;
      lastProbeNet11 = now;
      return domain;
    }
  }
  return cachedNet11Domain; // fallback to last known
}

async function getNet52Domain() {
  const now = Date.now();
  if (now - lastProbeNet52 < PROBE_TTL) {
    return cachedNet52Domain;
  }
  for (const domain of NET52_DOMAINS) {
    if (await probeDomain(domain, '/pv/search.php') || await probeDomain(domain, '/search.php')) {
      cachedNet52Domain = domain;
      lastProbeNet52 = now;
      return domain;
    }
  }
  return cachedNet52Domain; // fallback to last known
}

/**
 * Build request headers merging static env cookies and dynamically passed client cookies.
 */
function buildHeaders(provider, clientHeaders = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json, text/plain, */*'
  };

  // 1. Get cookies from request headers (x-net11-cookie or x-net52-cookie)
  let dynamicCookie = '';
  if (provider === 'net11') {
    dynamicCookie = clientHeaders['x-net11-cookie'] || clientHeaders['X-Net11-Cookie'] || '';
  } else if (provider === 'net52') {
    dynamicCookie = clientHeaders['x-net52-cookie'] || clientHeaders['X-Net52-Cookie'] || '';
  }

  // 2. Get static cookies from env
  const envCookie = provider === 'net11' 
    ? process.env.NET11_COOKIE 
    : process.env.NET52_COOKIE;

  // Combine cookies (dynamic takes priority)
  let finalCookie = dynamicCookie || envCookie || '';

  const USE_NET52_COOKIE = process.env.USE_NET52_COOKIE === 'true';
  if (!USE_NET52_COOKIE) {
    finalCookie = '';
  }

  if (finalCookie) {
    headers['Cookie'] = finalCookie;
  }

  // 3. Forward Client IP headers to allow correct dynamic IP-locked token binding
  const ipHeaders = [
    'x-forwarded-for',
    'X-Forwarded-For',
    'cf-connecting-ip',
    'CF-Connecting-IP',
    'true-client-ip',
    'True-Client-IP',
    'x-real-ip',
    'X-Real-IP'
  ];
  for (const h of ipHeaders) {
    const val = clientHeaders[h] || clientHeaders[h.toLowerCase()];
    if (val) {
      headers[h] = val;
    }
  }

  return headers;
}

module.exports = {
  USER_AGENT,
  buildHeaders,
  getNet11Domain,
  getNet52Domain,

  async net11Request(config, clientHeaders = {}) {
    const domain = await getNet11Domain();
    const url = `${domain}${config.url}`;
    const headers = {
      ...buildHeaders('net11', clientHeaders),
      ...(config.headers || {})
    };

    console.log(`[Net11 Client] ${config.method || 'GET'} ${url}`);
    return axios({
      ...config,
      url,
      headers,
      timeout: 12000
    });
  },

  async net52Request(config, clientHeaders = {}) {
    const domain = await getNet52Domain();
    const url = `${domain}${config.url}`;
    const headers = {
      ...buildHeaders('net52', clientHeaders),
      ...(config.headers || {})
    };

    console.log(`[Net52 Client] ${config.method || 'GET'} ${url}`);
    return axios({
      ...config,
      url,
      headers,
      timeout: 12000
    });
  }
};
