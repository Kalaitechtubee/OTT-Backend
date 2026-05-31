# 🎬 StreamVault Backend — Final Production Documentation

> **Node.js + Express API Gateway**  
> Production URL: `https://ott-backend-eg8y.onrender.com`  
> GitHub: `https://github.com/Kalaitechtubee/OTT-Backend`

---

## 📐 Final Architecture

```
Flutter App (Android/iOS)
        │
        │  GET /api/catalog/*        ← Browse, Search, Details
        │  GET /api/stream/play/:id  ← Get stream URLs (JSON only)
        ▼
  Render Backend (Node.js)
        │
        │  Proxies API calls → Net27 mirror (net27.cc / net52.cc / net22.cc)
        │  Builds CF Worker stream URLs and returns JSON
        ▼
  Net27 API  (net27.cc)
        │
        │  Returns: catalog data, embed URLs, signed CDN URLs
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  Backend returns CF Worker URLs to Flutter          │
  │  e.g. https://streamhub-proxy.1545zoya.workers.dev  │
  │       /?url=<encoded_cdn_url>&referer=...&origin=...│
  └─────────────────────────────────────────────────────┘
        │
        │  Flutter MediaKit plays this URL directly
        ▼
  Cloudflare Worker  (streamhub-proxy.1545zoya.workers.dev)
        │
        │  Trusted Cloudflare edge IPs — CDN accepts all requests
        ▼
  CDN  (bcdnxw.hakunaymatata.com)
        │
        │  HTTP 206 Partial Content — video bytes stream to Flutter
        ▼
  Flutter Video Player (MediaKit) 🎬 ✅
```

> **Key principle**: The Render server **never proxies video data**. It only serves JSON.  
> Video bytes flow: `Flutter → CF Worker → CDN` — Render is not in that path.

---

## 🗂️ Project Structure

```
backend/
├── server.js               # Express app entry point, middleware, health route
├── package.json
├── .env                    # PORT, BACKEND_URL (not committed)
├── .env.example
├── routes/
│   ├── catalog.js          # /api/catalog/* — browse, search, details
│   └── stream.js           # /api/stream/* — languages, play, proxy
└── services/
    └── net27.js            # Net27 mirror discovery + all API calls
```

---

## ⚙️ Environment Variables

| Variable       | Default                                  | Purpose                                      |
|----------------|------------------------------------------|----------------------------------------------|
| `PORT`         | `5000`                                   | HTTP server port                             |
| `BACKEND_URL`  | Auto-detected from `req.get('host')`     | Base URL used to build Render proxy URLs     |
| `NODE_ENV`     | —                                        | Set to `production` on Render automatically  |

---

## 🔌 API Reference

### Health Check
```
GET /health
→ { "ok": true, "uptime": 123.4, "mirror": "https://net27.cc" }
```

---

### Catalog Endpoints

#### Trending / Home Page
```
GET /api/catalog/trending
→ {
    "ok": true,
    "hero": [ { tmdbId, type, title, year, backdropUrl, rating } ],
    "rails": [ { key, title, ranked, items: [ Movie ] } ]
  }
```

#### Search (Net27 search-hybrid)
```
GET /api/catalog/search?q=mersal&page=1

Proxies Net27: GET /api/catalog/search-hybrid?q=mersal

→ {
    "ok": true,
    "query": "mersal",
    "source": "net27-search-hybrid",
    "streamableCount": 1,
    "items": [{
      "tmdbId": 456287,
      "title": "Mersal",
      "type": "movie",
      "streamable": true,
      "subjectId": "7305948787733053624",
      "detailPath": "mersal-hindi-...",
      "variants": [...]
    }]
  }
```

Results are deduped (TMDB + aoneroom-direct), sorted with `streamable: true` first,
and file-cached for 24h under `backend/data/search-cache.json`.

#### Title Details (Movie or TV)
```
GET /api/catalog/title/:type/:tmdbId
  type = "movie" | "tv"

→ {
    "ok": true,
    "tmdbId": 76479,
    "title": "The Boys",
    "type": "tv",
    "overview": "...",
    "poster": "https://...",
    "backdrop": "https://...",
    "rating": 8.4,
    "year": "2019",
    "seasons": [ { seasonNumber, episodeCount, name } ],
    "subjectId": "5139196938264400928",
    "detailPath": "the-boys-c8bx84KzD76"
  }
```
> ✅ Cached in memory for 10 minutes (catalog data is stable)

#### Season Episodes
```
GET /api/catalog/season/:tmdbId/:seasonNumber

→ {
    "ok": true,
    "initialEpisodes": [
      { episode, name, overview, still, runtime, airDate }
    ]
  }
```
> ✅ Cached in memory for 10 minutes

---

### Stream Endpoints

#### Get Available Languages / Dubs
```
GET /api/stream/languages/:type/:tmdbId
  For TV: ?se=1&ep=1&sid=<subjectId>&dp=<detailPath>

→ {
    "ok": true,
    "variants": [
      { "dubSubjectId": "4910882524659959568", "language": "Tamil dub", "isOriginal": false },
      { "dubSubjectId": "2319163628954659828", "language": "Hindi dub", "isOriginal": false },
      { "dubSubjectId": "5139196938264400928", "language": "English", "isOriginal": true }
    ]
  }
```
> ✅ Cached per (type, tmdbId, season, episode) — 10 minutes

---

#### ⭐ Get Stream URLs (Play)

```
GET /api/stream/play/:tmdbId

For movies:
  GET /api/stream/play/550

For TV episodes:
  GET /api/stream/play/76479?type=tv&se=1&ep=1&sid=<subjectId>&dp=<detailPath>

For specific language dub:
  Add &sid=<dubSubjectId> from the /languages endpoint
```

**Response:**
```json
{
  "ok": true,
  "tmdbId": 76479,
  "title": "The Boys",
  "type": "tv",
  "year": "2019",
  "currentSeason": 1,
  "currentEpisode": 1,
  "resolution": "1080",
  "mp4": "https://streamhub-proxy.1545zoya.workers.dev/?url=https%3A%2F%2Fbcdnxw...mp4%3Fsign%3D...%26t%3D...&referer=...&origin=...",
  "streams": [
    { "url": "https://streamhub-proxy.1545zoya.workers.dev/?url=...", "resolution": 360, "size": 210144117 },
    { "url": "https://streamhub-proxy.1545zoya.workers.dev/?url=...", "resolution": 480, "size": 222382021 },
    { "url": "https://streamhub-proxy.1545zoya.workers.dev/?url=...", "resolution": 720, "size": 406800865 },
    { "url": "https://streamhub-proxy.1545zoya.workers.dev/?url=...", "resolution": 1080, "size": 646186864 }
  ],
  "subjectId": "5139196938264400928",
  "fallbackHls": "/api/loffe/tt1190634",
  "headers": {
    "Referer": "https://net27.cc/api/embed-tmdb/76479?type=tv&se=1&ep=1",
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7)...",
    "Origin": "https://net27.cc"
  }
}
```

> ⚠️ **NEVER CACHE** stream URLs — they contain signed tokens that expire  
> ✅ `streams[].url` are **CF Worker URLs** — Flutter plays them directly with MediaKit  
> ✅ No custom HTTP headers needed in default mode (CF Worker handles CORS)

**URL Mode Query Param (`?proxy=`):**

| `?proxy=`   | URL type returned          | Use case                                        |
|-------------|----------------------------|-------------------------------------------------|
| *(omit)*    | CF Worker URL (default)    | Flutter / mobile apps ✅                        |
| `false`     | Raw CDN URL                | Clients that set Referer/Origin manually        |
| `true`      | Render server proxy URL    | Local testing only (403 on Render datacenter)   |

---

#### Stream Proxy (Fallback / Local Testing Only)
```
GET /api/stream/proxy?url=<encoded_url>&referer=<encoded_ref>&origin=<encoded_origin>
```
> ⚠️ This proxies through the Render server → CF Worker → CDN.  
> Returns 403 when called from Render (datacenter IP blocked by CDN).  
> Works only from local machine. Use CF Worker URLs directly instead.

---

## 🌐 Net27 Mirror Discovery (`services/net27.js`)

The service auto-discovers a working Net27 mirror at startup:

```
1. Try known mirrors in order: net27.cc → net52.cc → net22.cc
   └─ Probe each: GET / → check response HTML for "Search movies"
   
2. If all fail → DNS sweep net10.cc through net99.cc (parallel)
   └─ Resolve each, probe responding ones
   
3. Ultimate fallback → use net27.cc regardless
```

**Mirror cache TTL:** 10 minutes  
**API request timeout:** 10 seconds  
**Rate limit handling:** Auto-retry once after 3s on HTTP 429

---

## 📦 Caching Policy

| Data Type            | Cached? | TTL        | Reason                              |
|----------------------|---------|------------|-------------------------------------|
| Mirror domain        | ✅ Yes  | 10 minutes | Avoid probing on every request      |
| Catalog details      | ✅ Yes  | 10 minutes | Stable data (title, seasons, etc.)  |
| Season episodes      | ✅ Yes  | 10 minutes | Stable episode metadata             |
| Language variants    | ✅ Yes  | 10 minutes | Stable dub list per episode         |
| **Stream URLs**      | ❌ No   | Never      | Signed tokens expire — always fresh |

---

## 🔑 CDN Access & Security Deep Dive

### How CDN Signing Works
The CDN (`bcdnxw.hakunaymatata.com`) issues **HMAC-signed URLs**:
```
https://bcdnxw.hakunaymatata.com/resource/<hash>.mp4?sign=<hmac>&t=<unix_expiry>
```
- `sign` = HMAC-SHA1 of the path + secret key
- `t` = expiry unix timestamp (typically issued for ~30-60 minutes)

### Why Server Proxy Gets 403
```
❌ Render server (datacenter IP)  → direct CDN   = 403 ACCESS DENIED
❌ Render server → CF Worker      → CDN           = 403 ACCESS DENIED
   (CF Worker exposes Render's IP via X-Forwarded-For or by egress region)

✅ Local machine (consumer IP)    → CF Worker → CDN = 206 Partial Content
✅ Flutter mobile (consumer IP)   → CF Worker → CDN = 206 Partial Content
✅ Browser (consumer IP)          → CF Worker → CDN = 206 Partial Content
```

### Token "Expiry" Discovery
Net27's embed API sometimes returns tokens where `t` timestamp appears expired.
However, the CDN validates by **IP/region, not by timestamp** when accessed via CF Worker.
This is consistent with how Net27's own website works (confirmed via network capture).

### CF Worker Role
`streamhub-proxy.1545zoya.workers.dev` is Net27's own Cloudflare Worker:
- Net27's website embeds CF Worker URLs as `<video src>` directly in the browser
- Flutter plays the same CF Worker URLs via MediaKit
- CF Worker runs on Cloudflare's edge network (trusted IPs globally)
- Adds `access-control-allow-origin: *` CORS header

---

## 📱 Flutter Integration

### `BackendService.getStreams()` — Call on every Play press
```dart
final result = await BackendService.getStreams(
  tmdbId: 76479,
  type: 'tv',
  season: 1,
  episode: 1,
  sid: selectedLanguage?.dubSubjectId,  // from getLanguages()
  dp: movie.detailPath,
);

// result.streams → sorted by resolution ascending
// result.bestUrl → highest resolution CF Worker URL
// result.headers → Referer/Origin (for raw CDN mode only)
```

### MediaKit Playback (in `CustomVideoPlayerScreen`)
```dart
// CF Worker URL — no custom headers needed (Worker handles CORS)
await _player.open(Media(cfWorkerUrl));

// Raw CDN URL (?proxy=false mode) — must set headers
await _player.open(Media(cdnUrl, httpHeaders: {
  'Referer': result.headers!['Referer']!,
  'Origin': result.headers!['Origin']!,
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13...',
}));
```

### Quality Switching
```dart
// All quality URLs in result.streams — MediaKit seek position preserved
await _player.pause();
await _player.open(Media(quality.url, httpHeaders: playerHeaders));
await _player.seek(currentPosition);
await _player.play();
```

---

## 🔁 Complete Watch Flow (TV Episode)

```
1. User opens app
   └─ GET /api/catalog/trending → Hero banners + Category rails

2. User taps a TV show
   └─ GET /api/catalog/title/tv/76479
      → Title details + seasons list + subjectId + detailPath

3. Detail screen loads
   └─ GET /api/stream/languages/tv/76479?se=1&ep=1&sid=...&dp=...
      → [ { language: "Tamil dub", dubSubjectId: "..." }, ... ]

4. User selects "Tamil dub" + taps Play on Episode 3
   └─ GET /api/stream/play/76479?type=tv&se=1&ep=3&sid=<tamilDubSid>&dp=...
      → { streams: [ { url: "https://streamhub-proxy.../...mp4...", resolution: 360 }, ... ] }

5. Flutter → MediaKit.open(streams.last.url)
   └─ Flutter → CF Worker → CDN → 206 video bytes → playback ✅

6. User changes quality to 1080p
   └─ Flutter switches URL in-place, seeks to saved position

7. User exits player
   └─ Hive saves { positionSeconds, totalDurationSeconds } for resume
```

---

## 🚀 Deployment (Render)

### Environment
- **Service type:** Web Service (Node.js)
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Region:** Oregon (US West)
- **Auto-deploy:** On push to `main` branch

### Cold Start
Render free tier sleeps after 15 minutes of inactivity. First request after sleep takes ~10-15 seconds (Node startup + Net27 mirror probe). Subsequent requests are fast (~50-600ms).

### Logs to Watch
```
[Net27] ✅ Using mirror: https://net27.cc          ← Mirror found
[Net27] ✅ Token valid, expires in 1800s           ← Fresh token
[Net27] ℹ️ Token t=... appears expired by 1200s    ← Stale token (still works via CF Worker)
GET /api/stream/play/76479 200 600ms               ← Play request ✅
GET /api/stream/proxy?url=... 403 485ms            ← Server proxy blocked ⚠️ (expected, use CF Worker)
```

---

## 🧪 Testing Endpoints

### Quick Smoke Test (all in browser)
```
Health:    https://ott-backend-eg8y.onrender.com/health
Trending:  https://ott-backend-eg8y.onrender.com/api/catalog/trending
Title:     https://ott-backend-eg8y.onrender.com/api/catalog/title/tv/76479
Languages: https://ott-backend-eg8y.onrender.com/api/stream/languages/tv/76479?se=1&ep=1
Play:      https://ott-backend-eg8y.onrender.com/api/stream/play/76479?type=tv&se=1&ep=1
```

### Verify Stream URL Works (Node.js)
```javascript
const axios = require('axios');
const r = await axios.get('https://ott-backend-eg8y.onrender.com/api/stream/play/76479?type=tv&se=1&ep=1');
const cfWorkerUrl = r.data.streams[0].url;

// Test CF Worker directly
const video = await axios.get(cfWorkerUrl, {
  headers: { Range: 'bytes=0-1023' },
  responseType: 'arraybuffer'
});
console.log(video.status); // 206 ✅
```

---

## ⚡ Performance Notes

| Operation              | Typical Latency | Notes                                   |
|------------------------|----------------|-----------------------------------------|
| Mirror probe (cached)  | ~0ms           | Cached for 10 minutes                   |
| Mirror probe (first)   | ~200-500ms     | One HTTP request to net27.cc            |
| Catalog trending       | ~1-2s          | Net27 API response time                 |
| Title details          | ~300ms         | Cached after first fetch                |
| Language variants      | ~300ms         | Cached per episode                      |
| Stream play            | ~500-1500ms    | Net27 embed API (not cached)            |
| CF Worker video chunk  | ~50-200ms      | Cloudflare edge — very fast             |

---

## 📝 Known Behaviours

1. **Net27 stale tokens**: The embed API (`/api/embed-tmdb/`) sometimes returns CDN URLs where the `t=` timestamp looks expired. This is a Net27 server-side caching issue. The CF Worker still serves these URLs successfully because the CDN validates by IP, not by timestamp.

2. **Mirror rotation**: If `net27.cc` goes down, the backend auto-switches to `net52.cc` or `net22.cc` within 10 minutes (next cache expiry).

3. **Render 403 on proxy route**: `GET /api/stream/proxy` always returns 403 when deployed on Render because the CDN blocks datacenter IPs. This is expected and by design — the proxy route exists only for local testing.

4. **`streamsCache` variable**: Declared in net27.js but unused — `getStreams()` intentionally never caches (stream URLs expire).

---

*Last updated: 2026-05-29 — StreamVault Backend v1.0 Production*
