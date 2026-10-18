// Bump CACHE_VERSION whenever any file changes so phones pick up the update.
const CACHE_VERSION = 'royal-blight-v7';
const CORE = [
  './', './index.html', './manifest.json', './mp.js', './assets/lib/qrcode.js', './assets/lib/jsQR.js',
  './assets/tailwind.js', './assets/fonts/fonts.css',
  './assets/fonts/f0.woff2',
  './assets/fonts/f1.woff2',
  './assets/fonts/f2.woff2',
  './assets/fonts/f3.woff2',
  './assets/fonts/f4.woff2',
  './assets/fonts/f5.woff2',
  './assets/fonts/f6.woff2',
  './assets/fonts/f7.woff2',
  './assets/fonts/f8.woff2',
  './assets/fonts/f9.woff2',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/apple-touch-icon.png'
];
// Optional sprites: cached if present, ignored if missing.
const OPTIONAL = ['arena_bg', 'nexus_king', 'nexus_king_back', 'nexus_necromancer', 'turret_blue', 'turret_red', 'turret_pad', 'mine_safe', 'mine_mid', 'mine_far'].concat(
  ['knight','skeleton','archer','wizard','brute','worker']
    .flatMap(k => [k + '_blue', k + '_red', k + '_blue_back', k + '_red_back'])
    .filter(n => !/^knight_red|^skeleton_blue/.test(n))
    .concat(['knight', 'skeleton'])
).map(n => './assets/' + n + '.png');

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(async c => {
    await c.addAll(CORE);
    await Promise.all(OPTIONAL.map(u => fetch(u).then(r => r.ok ? c.put(u, r) : null).catch(() => null)));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok && new URL(e.request.url).origin === location.origin) {
      const copy = r.clone(); caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
    }
    return r;
  }).catch(() => hit)));
});
