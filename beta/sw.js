// Bump CACHE_VERSION whenever any file changes so phones pick up the update.
const CACHE_VERSION = 'royal-blight-beta-v27-cloud1';   // BETA build (/royal-blight/beta/): own cache namespace
const CORE = [
  './', './index.html', './manifest.json', './mp.js', './story.js', './cloud.js', './assets/lib/qrcode.js', './assets/lib/jsQR.js', './assets/lib/peerjs.min.js',
  './assets/tailwind.js', './assets/kingdom_map.jpg', './assets/fonts/fonts.css',
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
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/apple-touch-icon.png', './assets/icons/favicon-32.png', './assets/icons/maskable-192.png', './assets/icons/maskable-512.png', './assets/logo_crest.webp'
];
// Optional sprites: cached if present, ignored if missing.
const OPTIONAL = ['arena_bg', 'nexus_king', 'nexus_king_back', 'nexus_necromancer', 'nexus_necromancer_back', 'turret_blue', 'turret_red', 'turret_pad', 'mine_safe', 'mine_mid', 'mine_far', 'cavalier_blue', 'cavalier_blue_back', 'acolyte_red', 'acolyte_red_back',
  'arena_farmland', 'arena_swamp', 'arena_library', 'arena_pass',
  'nexus_felix', 'nexus_glade', 'nexus_cline', 'nexus_drevlar', 'nexus_doom', 'nexus_vexis'].flatMap(n => n.startsWith('nexus_') && !/king|necromancer/.test(n) ? [n, n + '_back'] : [n]).concat(
  ['knight_mace_blue', 'knight_hammer_blue', 'knight_shield_blue', 'skeleton_mace_red', 'skeleton_hammer_red', 'skeleton_shield_red',
   'archer_long', 'archer_flame', 'archer_hunting', 'brute_light', 'brute_heavy', 'brute_spiked', 'wizard_priest', 'wizard_banner']
    .flatMap(k => /_(blue|red)$/.test(k) ? [k, k + '_back'] : [k + '_blue', k + '_red', k + '_blue_back', k + '_red_back'])
).concat(
  ['knight','skeleton','archer','wizard','brute','worker']
    .flatMap(k => [k + '_blue', k + '_red', k + '_blue_back', k + '_red_back'])
    .filter(n => !/^knight_red|^skeleton_blue/.test(n))
    .concat(['knight', 'skeleton'])
).concat(
  // v26: Green Army (story) + Felix boss + heroes
  ['knight','knight_mace','knight_hammer','knight_shield','archer','archer_long','archer_flame','archer_hunting','brute','brute_light','brute_heavy','brute_spiked',
   'wizard','wizard_priest','wizard_banner','worker','cavalier'].flatMap(k => [k + '_green', k + '_green_back'])
    .concat(['felix_boss', 'felix_boss_back', 'barn', 'barn_burnt', 'windmill', 'windmill_burning', 'jailwagon', 'jailwagon_open', 'lantern_on', 'lantern_off', 'oilwagon', 'oilwagon_burnt', 'cavalier_blue', 'cavalier_blue_back', 'acolyte_red', 'acolyte_red_back'])
).map(n => './assets/' + n + (/^arena_/.test(n) ? '.jpg' : '.png'))
  .concat(['rufus','ruphene','vesper','garrow','felix','pip','farmer','mystery'].map(n => './assets/portraits/' + n + '.webp'), ['./assets/vo/index.json'],
    ['wren_blue','bram_blue','quill_blue','nettle_red','ossuar_red','wail_red'].flatMap(n => ['./assets/' + n + '.png', './assets/' + n + '_back.png']));   // v31 heroes   // v29 portraits (voice .ogg cached on first play)

// v24.1: app shell is NETWORK-FIRST (cache only as offline fallback) so a new deploy shows on the next load;
// images/fonts/libs stay cache-first. skipWaiting + clients.claim make a new worker take over at once.
const NET_FIRST = /\/(index\.html|sw\.js|story\.js|cloud\.js|mp\.js|manifest\.json|version\.json)?$/;
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_VERSION).then(async c => {
    await c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all(OPTIONAL.map(u => fetch(u).then(r => r.ok ? c.put(u, r) : null).catch(() => null)));
  }));
});
self.addEventListener('activate', e => {
  // only clean up OLD BETA caches; the live game's caches share this origin and must not be touched
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('royal-blight-beta-') && k !== CACHE_VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/assets/music/')) return;   // v34.5 music streams from the network, never cached
  const store = r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE_VERSION).then(c => c.put(req, copy)); } return r; };
  const fromCache = () => caches.open(CACHE_VERSION).then(c => c.match(req, { ignoreSearch: true }).then(h => h || (req.mode === 'navigate' ? c.match('./index.html') : undefined)));
  if (req.mode === 'navigate' || NET_FIRST.test(url.pathname)) {
    e.respondWith(fetch(req, { cache: 'no-store' }).then(store).catch(() => fromCache()));
    return;
  }
  e.respondWith(fromCache().then(hit => hit || fetch(req).then(store)));
});
