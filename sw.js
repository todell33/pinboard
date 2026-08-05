// Bump this version string on every deploy that changes any cached file.
// Because the fetch handler below is network-first for app files, this mainly
// controls cleanup of old cache storage — but keeping it accurate is what lets
// old, mismatched file versions get purged instead of lingering indefinitely.
const CACHE_NAME = 'pinboard-v50';
const ASSETS = [
  './index.html',
  './app.js',
  './config.js',
  './cloud-sync.js',
  './score-scan.js',
  './alley-detect.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(()=> self.skipWaiting())
  );
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(()=> self.clients.claim())
  );
});

self.addEventListener('fetch', (e)=>{
  // Never cache calls to Supabase (your account data + auth) or Google (OAuth redirect flow) —
  // always go to network for live data. A stale cached response here could mean showing someone
  // old data, or a broken auth flow, which is far worse than the network-first behavior below.
  if (
    e.request.url.includes('supabase.co') ||
    e.request.url.includes('googleapis.com') ||
    e.request.url.includes('accounts.google.com')
  ){
    return;
  }

  // Network-first for our own app files: this app's HTML/JS/CSS are the whole product,
  // and users need updates the moment they're deployed, not on some arbitrary future reload.
  // Cache-first (the previous strategy) meant a fixed CACHE_NAME could serve a stale file
  // forever even after a fresh deploy, since old cache entries are only purged when the
  // cache NAME changes — not when individual file contents change. Network-first fixes that:
  // every load tries the network first, and only falls back to cache when truly offline.
  if (e.request.method === 'GET' && e.request.url.startsWith(self.location.origin)){
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok){
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
        }
        return res;
      }).catch(()=> caches.match(e.request))
    );
    return;
  }

  // Everything else (fonts, etc.): cache-first is fine, low risk of staleness mattering.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET'){
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
        }
        return res;
      }).catch(()=> cached);
    })
  );
});
