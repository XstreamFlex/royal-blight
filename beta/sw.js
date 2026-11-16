// Bump CACHE_VERSION whenever any file changes so phones pick up the update.
const CACHE_VERSION = 'royal-blight-beta-v39.22';   // BETA build (/royal-blight/beta/): own cache namespace
const CORE = [
  './', './index.html', './manifest.json', './mp.js', './story.js', './reclaim.js', './cloud.js', './assets/lib/qrcode.js', './assets/lib/jsQR.js', './assets/lib/peerjs.min.js',
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
  'nexus_felix', 'nexus_glade', 'nexus_glade_tainted', 'nexus_cline', 'nexus_drevlar', 'nexus_doom', 'nexus_vexis'].flatMap(n => n.startsWith('nexus_') && !/king|necromancer/.test(n) ? [n, n + '_back'] : [n]).concat(
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
    .concat(['felix_boss', 'felix_boss_back', 'drevlar_boss', 'drevlar_boss_back', 'doom_boss', 'doom_boss_back', 'knight_yellow', 'knight_yellow_back', 'knight_silver', 'knight_silver_back', 'archer_silver', 'archer_silver_back', 'brute_silver', 'brute_silver_back', 'wizard_silver', 'wizard_silver_back', 'worker_silver', 'worker_silver_back', 'barn', 'barn_burnt', 'windmill', 'windmill_burning', 'jailwagon', 'jailwagon_open', 'lantern_on', 'lantern_off', 'oilwagon', 'oilwagon_burnt', 'cavalier_blue', 'cavalier_blue_back', 'acolyte_red', 'acolyte_red_back'])
).map(n => './assets/' + n + (/^arena_/.test(n) ? '.jpg' : '.png'))
  .concat(['rufus','ruphene','vesper','garrow','felix','pip','farmer','mystery'].map(n => './assets/portraits/' + n + '.webp'), ['./assets/vo/index.json'],
    ['wren_blue','bram_blue','quill_blue','nettle_red','ossuar_red','wail_red'].flatMap(n => ['./assets/' + n + '.png', './assets/' + n + '_back.png'])).concat([   // v39.21 Nov 15 approved media
  './assets/cine/ch4_m23_intro_s1.mp4', './assets/cine/ch4_m23_intro_s1.jpg',
  './assets/cine/ch5_m25_intro_s2.mp4', './assets/cine/ch5_m25_intro_s2.jpg',
  './assets/cine/ch5_m25_end_s3.mp4', './assets/cine/ch5_m25_end_s3.jpg',
  './assets/vo/M22_b2.m4a', './assets/vo/M23_b0.m4a', './assets/vo/M24_a0.m4a', './assets/vo/M24_a1.m4a',
  './assets/npc/npc_drevlar_kneel.webp', './assets/prop/prop_crystal_spire_shattered.webp',
  './assets/knight_green.png', './assets/knight_green_back.png', './assets/knight_yellow.png', './assets/knight_yellow_back.png', './assets/archer_green.png', './assets/archer_green_back.png', './assets/archer_yellow.png', './assets/archer_yellow_back.png', './assets/brute_green.png', './assets/brute_green_back.png', './assets/brute_yellow.png', './assets/brute_yellow_back.png', './assets/wizard_green.png', './assets/wizard_green_back.png', './assets/wizard_yellow.png', './assets/wizard_yellow_back.png', './assets/worker_green.png', './assets/worker_green_back.png', './assets/worker_yellow.png', './assets/worker_yellow_back.png', './assets/pirate_pawn.png', './assets/pirate_pawn_back.png', './assets/outlaw_pawn.png', './assets/outlaw_pawn_back.png', './assets/pirate_archer.png', './assets/pirate_archer_back.png', './assets/outlaw_archer.png', './assets/outlaw_archer_back.png', './assets/pirate_brute.png', './assets/pirate_brute_back.png', './assets/outlaw_brute.png', './assets/outlaw_brute_back.png', './assets/pirate_wizard.png', './assets/pirate_wizard_back.png', './assets/outlaw_wizard.png', './assets/outlaw_wizard_back.png', './assets/prop/prop_pirate_longboat.webp'
]);

// v24.1: app shell is NETWORK-FIRST (cache only as offline fallback) so a new deploy shows on the next load;
// images/fonts/libs stay cache-first. skipWaiting + clients.claim make a new worker take over at once.
const NET_FIRST = /\/(index\.html|sw\.js|story\.js|cloud\.js|mp\.js|manifest\.json|version\.json)?$/;
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_VERSION).then(async c => {
    await c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all(OPTIONAL.map(u => fetch(u, { cache: 'reload' }).then(r => r.ok ? c.put(u, r) : null).catch(() => null)));
  }));
});
self.addEventListener('activate', e => {
  // only clean up OLD BETA caches; the live game's caches share this origin and must not be touched
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('royal-blight-beta-v39.22') && k !== CACHE_VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/assets/music/')) return;   // v34.5 music streams from the network, never cached
  // v37.3: Range requests (Safari/iOS <audio> for VO .m4a ALWAYS asks for bytes=0-1 first) used to get the cached full 200
  // back, which WebKit rejects/aborts mid-line; and a network 206 was then put() into the cache (r.ok is true for 206).
  // Now: answer from the cache with a real 206 slice, else straight to the network, never stored.
  if (req.headers.has('range')) {
    e.respondWith(caches.open(CACHE_VERSION).then(c => c.match(req, { ignoreSearch: true })).then(async hit => {
      if (!hit) return fetch(req);
      const buf = await hit.arrayBuffer(), n = buf.byteLength, m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
      let a = m && m[1] ? +m[1] : 0, b = m && m[2] ? +m[2] : n - 1; if (m && !m[1] && m[2]) { a = Math.max(0, n - +m[2]); b = n - 1; }
      b = Math.min(b, n - 1); if (a > b || a >= n) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + n } });
      return new Response(buf.slice(a, b + 1), { status: 206, headers: { 'Content-Type': hit.headers.get('Content-Type') || (/\.mp4$/.test(url.pathname) ? 'video/mp4' : 'audio/mp4'), 'Content-Range': `bytes ${a}-${b}/${n}`, 'Content-Length': String(b - a + 1), 'Accept-Ranges': 'bytes' } });
    }).catch(() => fetch(req)));
    return;
  }
  const store = r => { if (r && r.ok && r.status === 200) { const copy = r.clone(); caches.open(CACHE_VERSION).then(c => c.put(req, copy)); } return r; };
  const fromCache = () => caches.open(CACHE_VERSION).then(c => c.match(req, { ignoreSearch: true }).then(h => h || (req.mode === 'navigate' ? c.match('./index.html') : undefined)));
  if (req.mode === 'navigate' || NET_FIRST.test(url.pathname)) {
    e.respondWith(fetch(req, { cache: 'no-store' }).then(store).catch(() => fromCache()));
    return;
  }
  e.respondWith(fromCache().then(hit => hit || fetch(req).then(store)));
});
