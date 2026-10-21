// Royal Blight v24 — STORY MODE foundation: save system, region map, data-driven mission engine, Chapter 1.
// Loaded after the main game script; talks to it through the shared globals (state, Unit, startMatch, ...)
// and a handful of hooks guarded by `window.Story && Story.active` in index.html.
(function () {
  'use strict';
  // ------------------------------------------------------------------ SAVE (localStorage, versioned)
  const SAVE_KEY = 'royalBlight.story', SAVE_V = 2;   // v27: v2 = illustrated map + new color rules (mapV)
  const freshSave = () => ({ v: SAVE_V, gold: 0, xp: 0, missions: {}, unlocks: ['pawn:sword', 'archer:long', 'worker', 'turret'], seen: [], created: Date.now(), mapV: 2 });
  function migrate(s) {
    if (!s || typeof s !== 'object') return freshSave();
    const f = freshSave();
    const out = { v: SAVE_V, gold: Math.max(0, Math.floor(+s.gold || 0)), xp: Math.max(0, Math.floor(+s.xp || 0)),
      missions: {}, unlocks: Array.isArray(s.unlocks) ? s.unlocks.filter(x => typeof x === 'string').slice(0, 500) : f.unlocks,
      seen: Array.isArray(s.seen) ? s.seen.filter(x => typeof x === 'string').slice(0, 500) : [], created: +s.created || Date.now(),
      mapV: 2, migratedFrom: (s.v | 0) < 2 ? (s.v | 0) || 1 : (s.migratedFrom || 0) };   // v1 -> v2: progress is derived from wins, so nothing is lost
    f.unlocks.forEach(u => { if (!out.unlocks.includes(u)) out.unlocks.push(u); });
    if (s.missions && typeof s.missions === 'object') for (const [id, m] of Object.entries(s.missions)) {
      if (!/^[A-Z0-9_]{2,8}$/.test(id) || !m) continue;
      out.missions[id] = { stars: Math.max(0, Math.min(3, m.stars | 0)), wins: Math.max(0, m.wins | 0), plays: Math.max(0, m.plays | 0), best: +m.best || 0, starSet: Array.isArray(m.starSet) ? m.starSet.slice(0, 3).map(Boolean) : [false, false, false] };
    }
    return out;
  }
  let SAVE = (() => { try { return migrate(JSON.parse(localStorage.getItem(SAVE_KEY))); } catch (e) { return freshSave(); } })();
  function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(SAVE)); } catch (e) {} }
  function exportSave() { return 'RB1.' + btoa(unescape(encodeURIComponent(JSON.stringify(SAVE)))); }
  function importSave(str) {
    try {
      str = String(str || '').trim(); if (!str.startsWith('RB1.')) throw new Error('not a Royal Blight save');
      const obj = JSON.parse(decodeURIComponent(escape(atob(str.slice(4)))));
      if (!obj || obj.v > SAVE_V) throw new Error('save from a newer version');
      SAVE = migrate(obj); persist(); return true;
    } catch (e) { return e.message || 'invalid save'; }
  }
  const level = () => 1 + Math.floor(Math.sqrt(SAVE.xp / 60));          // XP level (shop gating later)

  // ------------------------------------------------------------------ WORLD DATA (from STORY_BIBLE.md)
  const G = { G1: 100, G2: 150, G3: 250, G4: 400, G5: 600 }, X = { X1: 50, X2: 80, X3: 120 };
  const REGIONS = {
    paradale:  { name: 'Paradale',  ruler: 'King Rufus', dir: 'center', pos: [50, 47], missions: ['P0'], hub: true, cards: [] },
    eastmarch: { name: 'Eastmarch', ruler: 'King Felix', dir: 'east', pos: [84, 52], missions: ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07'],
                 cards: [['map:farmland', '\u{1F33E}', 'Burning Farmland map'], ['pawn:shield', '\u{1F6E1}', 'Sword & Shield pawn'], ['army:green', '\u{1F49A}', 'Green Army + King Felix'], ['archer:flame', '\u{1F525}', 'Flame Arrow archer'], ['hero:cavalier', '\u{1F40E}', 'The Cavalier']] },
    westreach: { name: 'Westreach', ruler: 'King Glade', dir: 'west', pos: [16, 50], missions: [], count: 8, soon: true, cards: [['map:library', '\u{1F4DA}', '?'], ['wizard:base', '\u{1F52E}', '?']] },
    northcrag: { name: 'Northcrag', ruler: 'King Cline', dir: 'north', pos: [50, 15], missions: [], count: 8, soon: true, cards: [['map:pass', '\u26F0', '?']] },
    southmire: { name: 'Southmire', ruler: 'General Drevlar', dir: 'south', pos: [50, 83], missions: [], count: 8, soon: true, cards: [['map:swamp', '\u{1F480}', '?']] }
  };
  // Mission definitions. Engine keys:
  //  ai {level, strat, income, think}, gold (start), cards (allowed player cards), cap (max player army), map,
  //  objectives: [{k:'nexus'} | {k:'hold', zones:[{y,h,name}], secs, mode:'sequence'} | {k:'defend', zone, secs, maxEnemy}
  //   | {k:'gold', target} | {k:'survive', secs, reinforce} | {k:'deadline', secs} | {k:'rescue', cages:[{y, unit, n, name}]}
  //   | {k:'evac', count, every, lossMax} | {k:'intercept', count, need, every} | {k:'escort', count, need, every}
  //   | {k:'protect', structs:[{x,y,hp,name}], lossMax} | {k:'beacons', ys} | {k:'vip', hp, name}],
  //  hazards: [{k:'fireline', every, warn, dur, dps}], boss {...}, stars: [desc,desc,desc] + starFns.
  const M = {
    P0: { region: 'paradale', name: 'Festival of Lanterns', type: 'STD + LIM', map: 'arena', gold: 150, reward: ['G1', 'X1'],
      ai: { level: 'easy', strat: 'balanced', income: 0.55 }, cards: ['worker', 'archers', 'turret'], enemy: 'drill',
      brief: 'A friendly drill for the festival crowd. Sir Garrow\u2019s practice squad holds the far end of the Royal Arena. Light the three lanterns along the lane by marching your troops past them, then break the practice nexus.',
      tips: ['Pawns march every 15s for free.', 'Tap ARCHER to add archers to every 2nd wave.', 'Workers mine gold; the FAR mine pays most but is risky.', 'A TURRET (250g) taunts nearby enemies.'],
      objectives: [{ k: 'nexus' }, { k: 'beacons', ys: [1560, 1110, 660], name: 'Lanterns' }],
      stars: ['Win the drill', 'Nexus above 50%', 'Light all 3 lanterns'],
      before: [['Ruphene', 'One for every friend we\u2019ve got. We\u2019re gonna need more lanterns.'], ['Vesper', 'Enjoy the lanterns, Majesty. I\u2019ll see to the birds myself.']],
      after: [['Pip', 'Your Majesty\u2026 no one\u2019s answering.'], ['', 'The map flickers. East, west, north and south turn red, one by one.'], ['???', 'Everything you love\u2026 I will take.']],
      cut: ['prologue_lanterns', 'prologue_contact_lost'] },
    M01: { region: 'eastmarch', name: 'Smoke on the Horizon', type: 'STD', map: 'farmland', gold: 120, reward: ['G1', 'X1'], par: 420,
      ai: { level: 'normal', strat: 'balanced', income: 0.6 },
      brief: 'Felix\u2019s Green Army is burning the haystacks of Eastmarch. Meet them in the fields and destroy their nexus.',
      objectives: [{ k: 'nexus' }], stars: ['Win', 'Nexus above 50%', 'Win under 7:00 (par)'],
      before: [['Vesper', 'He\u2019ll fire the western rows first. Trust me, Majesty. I know the way.'], ['Rufus', 'Felix grew those fields with his own hands. Why is he burning them?']],
      after: [['Felix', '(cold, eyes glowing red) Paradale takes everything. Not this time.']], cut: ['ch1_m01_briefing', 'ch1_m01_red_eyes'] },
    M02: { region: 'eastmarch', name: 'Save the Harvest', type: 'EVAC', map: 'farmland', gold: 150, reward: ['G1', 'X1'], unlock: ['pawn:shield'],
      ai: { level: 'normal', strat: 'balanced', income: 0.6 },
      brief: 'Farmers are fleeing across the rows toward your nexus. Escort them home: lose no more than 3.',
      objectives: [{ k: 'evac', count: 10, every: 8, lossMax: 3, fromY: 1180, name: 'Farmers' }], noNexusWin: true,
      stars: ['Evacuate the farmers', 'Lose at most 1 farmer', 'Lose zero farmers'],
      before: [['Rufus', 'Farmers first. Fields can wait.']], after: [['Farmer', 'Bless you, Majesty. My son\u2019s shield is yours, if you\u2019ll have it.']], cut: ['ch1_m02_farmers'] },
    M03: { region: 'eastmarch', name: 'Fire-Oil Wagons', type: 'INT', map: 'farmland', gold: 180, reward: ['G2', 'X1'], unlock: ['army:green'],
      ai: { level: 'normal', strat: 'balanced', income: 0.7 },
      brief: 'Eight wagons are hauling fire-oil to Felix\u2019s archers. Destroy at least 6 before they reach his nexus. Every wagon that arrives makes his army hit harder.',
      objectives: [{ k: 'intercept', count: 8, need: 6, every: 20, name: 'Wagons' }], noNexusWin: true,
      stars: ['Destroy 6 wagons', 'Destroy 7 wagons', 'Destroy all 8'],
      before: [['Vesper', 'The oil comes up the east road at dusk. Always at dusk.']], after: [['Rufus', 'No more fire for his arrows tonight.']], cut: ['ch1_m03_wagons'] },
    M04: { region: 'eastmarch', name: 'Recapture the Farms', type: 'ATK + CUR', map: 'farmland', gold: 180, reward: ['G2', 'X1'], unlock: ['bonus:worker_east'],
      ai: { level: 'normal', strat: 'turtle', income: 0.85 },
      brief: 'Take back the scorched farmland one farmstead at a time. Push into each farm and hold it to replant it; every held farm pays bonus gold. Watch for fire-lines flaring across the rows.',
      objectives: [{ k: 'hold', name: 'Farmsteads', secs: 14, mode: 'sequence', pay: 60, zones: [{ y: 1420, h: 80, name: 'South farm' }, { y: 1110, h: 80, name: 'Mill farm' }, { y: 800, h: 80, name: 'East farm' }] }],
      hazards: [{ k: 'fireline', every: 16, warn: 2.2, dur: 4, dps: 14, h: 46 }], noNexusWin: true, timeLimit: 900,
      stars: ['Recapture all 3 farms', 'Nexus above 50%', 'Hold all 3 farms at the same time'],
      before: [['Vesper', 'Take the south farm first. Felix never guards it.']], after: [['Farmer', '(presses one seed into the ash)'], ['Rufus', 'That\u2019s how it starts. One field at a time.']], cut: ['ch1_m04_fields_reclaimed'] },
    M05: { region: 'eastmarch', name: 'Windmill Ridge', type: 'DEF', map: 'farmland', gold: 260, reward: ['G2', 'X2'], unlock: ['archer:flame'],
      ai: { level: 'normal', strat: 'push', income: 1.0 },
      brief: 'Hold the windmill zone while flame arrows set the ground alight. Keep the enemy out of the zone until the timer runs out.',
      objectives: [{ k: 'defend', zone: { y: 1460, h: 110, name: 'Windmill' }, secs: 240, maxEnemy: 25 }], hazards: [{ k: 'fireline', every: 22, warn: 2.2, dur: 3, dps: 10, h: 40, minY: 1250, maxY: 1700 }],
      noNexusWin: true, stars: ['Hold the windmill', 'Enemy holds it under 10s', 'Lose no turrets'],
      before: [['Rufus', 'If the windmill burns, the whole valley starves.']], after: [['Pip', 'The flames went out! The mill\u2019s still turning!']], cut: ['ch1_m05_windmill'] },
    M06: { region: 'eastmarch', name: 'The Cavalier\u2019s Charge', type: 'RSC', map: 'farmland', gold: 220, reward: ['G2', 'X2'], unlock: ['hero:cavalier'],
      ai: { level: 'normal', strat: 'pulse', income: 1.0 }, cards: ['worker', 'archers', 'brutes', 'wizards', 'turret'],
      brief: 'Sir Garrow was captured while scouting. Push the tug to his cage; free him and he rides with you as a trial hero. Then break the nexus.',
      objectives: [{ k: 'rescue', cages: [{ y: 760, hero: true, name: 'Sir Garrow' }] }, { k: 'nexus' }],
      stars: ['Win', 'Free Garrow', 'The Cavalier lands 3 jousts'],
      before: [['Vesper', 'Garrow always did ride too far ahead.']], after: [['Garrow', 'I *meant* to get captured. Tactically. \u2026Mostly.']], cut: ['ch1_m06_garrow'] },
    M07: { region: 'eastmarch', name: 'BOSS: The Scorched King', type: 'BOSS + CUR', map: 'farmland', gold: 260, reward: ['G3', 'X2'], unlock: ['region:eastmarch'], final: true,
      ai: { level: 'normal', strat: 'balanced', income: 1.1 },
      brief: 'Felix himself takes the field. Three phases: arrow volleys, then fire-lines split the lane, then his Rain of Arrows. While Felix stands, his nexus is shielded.',
      objectives: [{ k: 'boss', name: 'King Felix' }, { k: 'nexus' }],
      boss: { hp: 4200, atk: 32, range: 170, interval: 1.2, speed: 24, y: 300 },
      stars: ['Defeat Felix', 'Nexus above 50%', 'Nexus never below 75%'],
      before: [['Felix', 'You want my fields? Come and take the ashes.']],
      after: [['Felix', '(tearful, eyes brown again) Rufus\u2026 I burned it. I burned everything.'], ['Rufus', 'Fields grow back. You\u2019re home now.'], ['Vesper', '(watching the hug) How\u2026 touching.'], ['Pip', 'The map\u2019s turning green, Your Majesty!']],
      cut: ['ch1_m07_apology', 'ch1_m07_cold_smile'] }
  };
  Object.entries(M).forEach(([id, m]) => { m.id = id; });

  // ------------------------------------------------------------------ PROGRESS / COLORS
  const won = id => (SAVE.missions[id] && SAVE.missions[id].wins > 0);
  function regionColor(rk) {
    // v27 color rules: every region starts GREEN (peace). After the Prologue the realm turns YELLOW (contact lost),
    // except Eastmarch which goes RED (Felix's Green Army is burning it). Then red -> orange -> yellow -> lightgreen -> green.
    const r = REGIONS[rk]; if (!won('P0')) return 'green';
    if (r.hub) return 'blue';
    const ms = r.missions, n = ms.length || r.count; if (!ms.length) return rk === 'eastmarch' ? 'red' : 'yellow';
    const w = ms.filter(won).length, final = ms[ms.length - 1];
    if (won(final)) return 'green';
    if (w === 0) return 'red';
    if (w === n - 1) return 'lightgreen';
    if (w >= Math.ceil(n / 2)) return 'yellow';
    return 'orange';
  }
  // v27 controlling army per region (border color). A freed region flies the Royal Blue of Paradale.
  const ARMY = { paradale: ['Royal Blue', '#2563eb'], eastmarch: ['Green Army', '#22c55e'], westreach: ['Yellow Army', '#eab308'], northcrag: ['Silver Army', '#e5e7eb'], southmire: ['Grave Purple', '#9333ea'] };
  function controller(rk) { const r = REGIONS[rk]; if (r.hub || (r.missions.length && won(r.missions[r.missions.length - 1]))) return ARMY.paradale; return ARMY[rk]; }
  const MAP_C = [50, 47], DIRA = { east: 0, south: 90, west: 180, north: 270 };
  function regionPath(rk) {             // wedge between the capital ring and the coast, in 0-100 map space
    const r = REGIONS[rk], [cx, cy] = MAP_C, P = [];
    if (r.hub) { for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; P.push([cx + Math.cos(a) * 17, cy + Math.sin(a) * 15]); } }
    else { const a0 = (DIRA[r.dir] - 44) * Math.PI / 180, a1 = (DIRA[r.dir] + 44) * Math.PI / 180;
      for (let i = 0; i <= 12; i++) { const a = a0 + (a1 - a0) * i / 12, w = 1 + 0.05 * Math.sin(i * 1.7); P.push([cx + Math.cos(a) * 45 * w, cy + Math.sin(a) * 44 * w]); }
      for (let i = 12; i >= 0; i--) { const a = a0 + (a1 - a0) * i / 12; P.push([cx + Math.cos(a) * 19, cy + Math.sin(a) * 17]); } }
    return 'M' + P.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L') + ' Z';
  }
  const COLOR = { red: '#dc2626', orange: '#f97316', yellow: '#facc15', lightgreen: '#86efac', green: '#16a34a', blue: '#3b82f6' };
  function missionOpen(id) { const m = M[id], ms = REGIONS[m.region].missions, i = ms.indexOf(id); return i <= 0 || won(ms[i - 1]); }
  const unlocked = k => SAVE.unlocks.includes(k);
  function storyLoadout() {
    const lo = Object.assign({}, DEFAULT_LOADOUT, (typeof SETTINGS !== 'undefined' && SETTINGS.loadout) || {});
    for (const slot of Object.keys(lo)) if (lo[slot] !== DEFAULT_LOADOUT[slot] && !unlocked(slot + ':' + lo[slot])) lo[slot] = slot === 'archer' ? 'long' : DEFAULT_LOADOUT[slot];
    if (lo.archer === 'short' && !unlocked('archer:short')) lo.archer = 'long';   // starter deck: Longbow
    return lo;
  }

  // ------------------------------------------------------------------ RUNTIME
  const S = { active: false, team: 'blue', m: null, R: null };
  window.Story = S;
  const foe = 'red';
  const blueArmy = () => state.units.filter(u => !u.dead && u.team === 'blue' && u.type !== 'worker' && !u.story);
  const redArmy = () => state.units.filter(u => !u.dead && u.team === 'red' && u.type !== 'worker' && !u.story);
  function zoneCount(z, list) { return list.filter(u => Math.abs(u.y - z.y) <= z.h && Math.abs(u.x - LANE_X) < LANE_HALF_W + 30).length; }
  function storyUnit(o) {
    const u = new Unit(Object.assign({ atk: 0, range: 0, interval: 99, speed: 30, radius: 13 }, o));
    u.story = true; state.units.push(u); return u;
  }
  function toast(text, color) { addFloatingText(LANE_X, state.cameraY + 300, text, color || '#fde68a', 15, true); }

  S.start = function (id) {
    const m = M[id]; if (!m || !missionOpen(id)) return false;
    AI_LEVELS.story = Object.assign({}, AI_LEVELS[m.ai.level || 'normal'], { income: m.ai.income || 1, think: m.ai.think || AI_LEVELS[m.ai.level || 'normal'].think, heroWave: 99, heroArmy: 99 });
    const prevArmy = SETTINGS.army; SETTINGS.army = 'blue';
    S.active = true; S.m = m; S.team = 'blue';
    startMatch('cpu', 'story', { mission: id });
    SETTINGS.army = prevArmy;
    state.map = m.map || 'arena'; bgCache = null; mapBgKey();
    state.loadout = { blue: storyLoadout(), red: Object.assign({}, DEFAULT_LOADOUT, m.region === 'eastmarch' ? { archer: 'flame', pawn: 'sword' } : {}) };
    state.leaders = { blue: 'rufus', red: m.region === 'eastmarch' ? 'felix' : 'necro' };
    AIS.red.strat = AIS.red.strat0 = m.ai.strat || 'balanced'; AIS.red.switches = 0;
    state.blueGold = m.gold || 100;
    if (m.region === 'eastmarch' && unlocked('bonus:worker_east')) spawnWorker('blue', 'MID');     // M04 reward: +1 starting worker
    const R = S.R = { t: 0, obj: {}, lost: 0, minCoreFrac: 1, turretsLost: 0, spent: 0, jousts: 0, lastJoust: -9, hazards: [], done: null, msgs: [] };
    (m.objectives || []).forEach((o, i) => setupObjective(o, i));
    if (m.boss) spawnBoss(m.boss);
    S.prevDmgHook = window.dmgHook;
    window.dmgHook = (owner, dealt, target) => {
      if (S.prevDmgHook) S.prevDmgHook(owner, dealt, target);
      if (owner && owner.type === 'cavalier' && owner.team === 'blue' && owner.chargeState === 'charge' && state.gameTime - R.lastJoust > 1.2 && target instanceof Unit) { R.jousts++; R.lastJoust = state.gameTime; }
    };
    S.renderHud(); document.getElementById('story-hud').classList.remove('hidden');
    setTimeout(() => toast(m.name.toUpperCase(), '#fde68a'), 500);
    return true;
  };
  function setupObjective(o, i) {
    const R = S.R, st = R.obj[i] = { o, done: false, failed: false };
    if (o.k === 'hold') { st.idx = 0; st.held = o.zones.map(() => 0); st.owned = o.zones.map(() => false); st.loseT = o.zones.map(() => 0); st.allAtOnce = false; }
    if (o.k === 'defend') { st.enemyT = 0; }
    if (o.k === 'beacons') { st.lit = o.ys.map(() => false); }
    if (o.k === 'evac') { st.spawned = 0; st.saved = 0; st.lost = 0; st.next = 3; }
    if (o.k === 'intercept' || o.k === 'escort') { st.spawned = 0; st.killed = 0; st.arrived = 0; st.next = o.k === 'escort' ? 6 : 8; }
    if (o.k === 'rescue') { st.cages = o.cages.map(c => ({ c, prog: 0, freed: false, u: storyUnit({ type: 'cage', team: 'neutral', x: LANE_X, y: c.y, hp: 1e9, speed: 0, radius: 16 }) })); st.cages.forEach(c => { c.u.untargetable = true; }); }
    if (o.k === 'protect') { st.structs = o.structs.map(s => storyUnit({ type: 'structure', team: 'blue', x: s.x || LANE_X + 70, y: s.y, hp: s.hp || 600, speed: 0, radius: 20, label: s.name })); }
    if (o.k === 'vip') { st.u = storyUnit({ type: 'vip', team: 'blue', x: LANE_X, y: state.cores.blue.y - 90, hp: o.hp || 500, speed: o.speed || 18, radius: 15, label: o.name }); }
    if (o.k === 'survive' || o.k === 'deadline') { st.left = o.secs; }
  }
  function spawnBoss(b) {
    const u = new Unit({ type: 'archer', team: 'red', lane: 'C', x: LANE_X, y: b.y, hp: b.hp, atk: b.atk, range: b.range, interval: b.interval, speed: b.speed, radius: 22, resist: { ranged: 0.3, magic: 0.3 } });
    u.boss = true; u.variant = 'flame'; u.burn = [6, 3]; state.units.push(u); S.R.boss = u; S.R.phase = 1; S.R.rainT = 6;
  }

  S.allow = function (team, c) {           // limited army / unlock gating for the story player
    if (team !== 'blue' || !S.m) return true;
    if (c.k === 'node' || c.k === 'tup') return true;
    const cards = S.m.cards || ['worker', 'archers', 'brutes', 'wizards', 'turret'];
    if (c.k === 'hero') return unlocked('hero:cavalier') || !!(S.R && S.R.trialHero);
    if (!cards.includes(c.k)) { if (team === myTeam() && !c.quiet) toast('Locked in this mission', '#fca5a5'); return false; }
    if (S.m.cap && CADENCE_INFO[c.k] && (state.blueCadence.archers + state.blueCadence.wizards + state.blueCadence.brutes) >= S.m.cap) { if (!c.quiet) toast('Army limit reached', '#fca5a5'); return false; }
    return true;
  };
  S.cardAllowed = function (id) {
    const k = { 'btn-buy-worker': 'worker', 'btn-buy-archer': 'archers', 'btn-buy-brute': 'brutes', 'btn-buy-wizard': 'wizards', 'btn-buy-turret': 'turret', 'btn-buy-hero': 'hero' }[id];
    return !k || S.allow('blue', { k, quiet: true });
  };

  // per-frame mission logic (called from update())
  S.tick = function (dt) {
    const R = S.R, m = S.m; if (!R || R.done) return;
    R.t += dt;
    const cb = state.cores.blue; R.minCoreFrac = Math.min(R.minCoreFrac, cb.hp / cb.maxHp);
    const B = blueArmy(), Rd = redArmy();
    for (const st of Object.values(R.obj)) tickObjective(st, dt, B, Rd);
    (m.hazards || []).forEach((h, i) => tickHazard(h, i, dt));
    if (R.boss) tickBoss(dt);
    if ((R.hudT = (R.hudT || 0) - dt) <= 0) { R.hudT = 0.25; S.renderHud(); }
  };
  function tickObjective(st, dt, B, Rd) {
    const o = st.o, R = S.R;
    if (o.k === 'hold') {
      o.zones.forEach((z, i) => {
        const b = zoneCount(z, B), r = zoneCount(z, Rd);
        const active = o.mode !== 'sequence' || i === st.idx || st.owned[i];
        if (!active) return;
        if (!st.owned[i]) {
          if (b > 0 && b > r) st.held[i] = Math.min(o.secs, st.held[i] + dt); else if (r > b) st.held[i] = Math.max(0, st.held[i] - dt * 0.5);
          if (st.held[i] >= o.secs) { st.owned[i] = true; st.loseT[i] = 0; if (o.pay) { state.blueGold += o.pay; addFloatingText(LANE_X, z.y, '+' + o.pay + 'g REPLANTED!', '#4ade80', 16); } if (o.mode === 'sequence') st.idx = Math.max(st.idx, i + 1); toast(z.name + ' recaptured!', '#4ade80'); }
        } else if (r > 0 && b === 0) {                        // enemy retakes a farm it sits in for 10s
          st.loseT[i] += dt; if (st.loseT[i] > 10) { st.owned[i] = false; st.held[i] = 0; toast(z.name + ' lost!', '#f87171'); if (o.mode === 'sequence') st.idx = Math.min(st.idx, i); }
        } else st.loseT[i] = Math.max(0, st.loseT[i] - dt);
      });
      if (st.owned.every(Boolean)) { st.allAtOnce = true; st.done = true; }
    } else if (o.k === 'defend') {
      const z = o.zone, b = zoneCount(z, B), r = zoneCount(z, Rd);
      if (r > 0 && r > b) st.enemyT += dt;
      st.left = Math.max(0, o.secs - R.t);
      if (st.enemyT >= o.maxEnemy) st.failed = true; else if (st.left <= 0) st.done = true;
    } else if (o.k === 'beacons') {
      o.ys.forEach((y, i) => { if (!st.lit[i] && B.some(u => Math.abs(u.y - y) < 30)) { st.lit[i] = true; toast('Lantern lit! (' + st.lit.filter(Boolean).length + '/3)', '#fde68a'); createSparks(LANE_X + 80, y, '#facc15', 16); } });
      st.done = st.lit.every(Boolean);
    } else if (o.k === 'evac') {
      st.next -= dt;
      if (st.spawned < o.count && st.next <= 0) {
        st.next = o.every; st.spawned++;
        const u = storyUnit({ type: 'civilian', team: 'blue', x: LANE_X + (Math.random() - 0.5) * 60, y: o.fromY, hp: 90, speed: 34, radius: 11 });
        u.goal = state.cores.blue.y - 40; u.evac = st;
      }
      if (st.lost > o.lossMax) st.failed = true;
      else if (st.spawned >= o.count && st.saved + st.lost >= o.count) st.done = true;
    } else if (o.k === 'intercept' || o.k === 'escort') {
      st.next -= dt;
      if (st.spawned < o.count && st.next <= 0) {
        st.next = o.every; st.spawned++;
        const esc = o.k === 'escort';
        const u = storyUnit({ type: 'wagon', team: esc ? 'blue' : 'red', x: LANE_X + (esc ? 30 : -30), y: esc ? state.cores.blue.y - 120 : 1500, hp: esc ? 420 : 300, speed: esc ? 20 : 24, radius: 16 });
        u.goal = esc ? NODE_POS.blue.FAR.y : state.cores.red.y + 60; u.wagon = st;
      }
      const resolved = st.killed + st.arrived;
      if (o.k === 'intercept') { if (st.arrived > o.count - o.need) st.failed = true; else if (st.killed >= o.need && resolved >= Math.min(o.count, st.spawned) && (st.spawned >= o.count || st.killed >= o.need + 2)) st.done = true; if (st.killed >= o.need && st.spawned >= o.count && resolved >= o.count) st.done = true; }
      else { if (st.killed > o.count - o.need) st.failed = true; else if (st.arrived >= o.need) st.done = true; }
    } else if (o.k === 'rescue') {
      st.cages.forEach(c => {
        if (c.freed) return;
        const near = B.filter(u => Math.hypot(u.x - c.u.x, u.y - c.u.y) < 70).length, foes = Rd.filter(u => Math.hypot(u.x - c.u.x, u.y - c.u.y) < 90).length;
        if (near > 0 && foes === 0) c.prog += dt; else c.prog = Math.max(0, c.prog - dt * 0.5);
        if (c.prog >= 3) {
          c.freed = true; c.u.dead = true; toast(c.c.name + ' is free!', '#4ade80');
          if (c.c.hero) { R.trialHero = true; state.blueCadence.hero = 1; const h = spawnUnit('cavalier', 'blue', 'C', 0); h.y = c.c.y + 40; }
          else for (let k = 0; k < (c.c.n || 1); k++) { state.blueCadence[c.c.unit] = (state.blueCadence[c.c.unit] || 0) + 1; addOrder('blue', c.c.unit); }
        }
      });
      st.done = st.cages.every(c => c.freed);
    } else if (o.k === 'protect') {
      const lost = st.structs.filter(s => s.dead).length; st.lost = lost;
      if (lost > o.lossMax) st.failed = true;
    } else if (o.k === 'vip') {
      if (st.u.dead) st.failed = true; else if (Math.abs(st.u.y - state.cores.red.y) < 120) st.done = true;
    } else if (o.k === 'gold') {
      st.mine = state.goldMined.blue || 0; st.theirs = state.goldMined.red || 0;
      if (st.mine >= o.target) st.done = true; else if (st.theirs >= o.target) st.failed = true;
    } else if (o.k === 'survive') {
      st.left = Math.max(0, o.secs - R.t);
      if (st.left <= 0 && !st.arrived) { st.arrived = true; st.done = true; toast('REINFORCEMENTS HAVE ARRIVED!', '#4ade80');
        (o.reinforce || [['brute', 4], ['archer', 4], ['pawn', 8]]).forEach(([ty, n]) => { for (let k = 0; k < n; k++) state.spawnQ.blue.push(ty); }); }
    } else if (o.k === 'deadline') {
      st.left = Math.max(0, o.secs - R.t);
      if (st.left <= 0) { st.failed = true; toast('THE ENEMY HOST HAS ARRIVED', '#f87171'); }
    } else if (o.k === 'boss') {
      st.done = !!(R.boss && R.boss.dead);
    }
  }
  // story-only units (farmers, wagons, structures, cages, VIPs) — called from the unit loop
  S.unitTick = function (u, dt) {
    u.soulAt = undefined;
    if (u.type === 'civilian' || u.type === 'wagon' || u.type === 'vip') {
      const goal = u.type === 'vip' ? state.cores.red.y + 100 : u.goal, d = goal - u.y;
      if (Math.abs(d) < 8) {
        u.dead = true;
        if (u.evac) { u.evac.saved++; addFloatingText(u.x, u.y - 14, 'SAFE!', '#4ade80', 13); }
        if (u.wagon) { u.wagon.arrived++; if (u.team === 'red') { state.redUpgradeLevel += 0.25; toast('A wagon reached Felix! His army burns hotter.', '#fb923c'); } else { state.blueGold += 120; addFloatingText(u.x, u.y, '+120g', '#facc15', 15); } }
        return;
      }
      u.y += Math.sign(d) * u.speed * dt; u.walkAnim += dt * 6;
      u.x += (LANE_X + (u.team === 'blue' ? 25 : -25) - u.x) * 0.8 * dt;
    }
  };
  S.onUnitDeath = function (u) {
    if (!u.story) return;
    if (u.evac) { u.evac.lost++; addFloatingText(u.x, u.y - 14, 'FARMER LOST', '#f87171', 13); }
    if (u.wagon) { u.wagon.killed++; addFloatingText(u.x, u.y - 14, u.team === 'red' ? 'WAGON DESTROYED!' : 'WAGON LOST', u.team === 'red' ? '#4ade80' : '#f87171', 14); createSparks(u.x, u.y, '#f97316', 18); }
  };
  function tickHazard(h, i, dt) {
    const R = S.R, hz = R.hazards[i] = R.hazards[i] || { t: h.every * 0.6, lines: [] };
    hz.t -= dt;
    if (hz.t <= 0) {
      hz.t = h.every * (R.boss && R.phase >= 2 ? 0.6 : 1);
      const lo = h.minY || 500, hi = h.maxY || 1750;
      const B = blueArmy(); const near = B.length ? B[Math.floor(Math.random() * B.length)].y : lo + Math.random() * (hi - lo);
      hz.lines.push({ y: Math.max(lo, Math.min(hi, near + (Math.random() - 0.5) * 80)), warn: h.warn, burn: h.dur });
    }
    hz.lines = hz.lines.filter(l => {
      if (l.warn > 0) { l.warn -= dt; return true; }
      l.burn -= dt; l.tick = (l.tick || 0) - dt;
      if (l.tick <= 0) { l.tick = 0.5; state.units.forEach(u => { if (!u.dead && u.team === 'blue' && u.type !== 'worker' && Math.abs(u.y - l.y) < h.h) dealDamage(u, Math.round(h.dps * 0.5), null, 'burn'); }); }
      return l.burn > 0;
    });
  }
  function tickBoss(dt) {
    const R = S.R, b = R.boss; if (b.dead) { if (!R.bossDown) { R.bossDown = true; toast('FELIX FALLS! HIS NEXUS IS EXPOSED', '#4ade80'); } return; }
    const f = b.hp / b.maxHp, cr = state.cores.red;
    R.shieldHp = R.shieldHp || cr.hp; cr.hp = Math.max(cr.hp, R.shieldHp);          // nexus shielded while Felix stands
    if (R.phase === 1 && f < 0.66) { R.phase = 2; toast('PHASE 2: FIRE-LINES SPLIT THE LANE', '#fb923c'); }
    if (R.phase === 2 && f < 0.33) { R.phase = 3; toast('PHASE 3: RAIN OF ARROWS!', '#f87171'); }
    if (R.phase >= 2 && !S.m.hazards) S.m._hz = S.m._hz || { k: 'fireline', every: 9, warn: 2, dur: 3.5, dps: 16, h: 44 };
    if (R.phase >= 2) tickHazard(S.m._hz, 9, dt);
    if (R.phase >= 3) {
      R.rainT -= dt;
      if (R.rainT <= 0) { R.rainT = 6; const B = blueArmy(); if (B.length) { const t = B[Math.floor(Math.random() * B.length)]; R.rain = { x: t.x, y: t.y, warn: 1.6, r: 80 }; } }
      if (R.rain) { R.rain.warn -= dt; if (R.rain.warn <= 0) { const rn = R.rain; state.units.forEach(u => { if (!u.dead && u.team === 'blue' && Math.hypot(u.x - rn.x, u.y - rn.y) < rn.r) dealDamage(u, 45, b, 'ranged'); }); createSparks(rn.x, rn.y, '#fb923c', 20); R.rain = null; } }
    }
    // Felix holds back near his archers
    if (b.y > 520) b.y = 520;
  }

  // win/lose (called from checkGameOver): returns 'win' | 'lose' | null
  S.check = function () {
    const R = S.R, m = S.m; if (!R) return null;
    if (state.cores.blue.hp <= 0) return 'lose';
    const objs = Object.values(R.obj);
    if (objs.some(st => st.failed)) return 'lose';
    if (m.timeLimit && R.t > m.timeLimit) return 'lose';
    const main = objs.filter(st => !['beacons', 'rescue'].includes(st.o.k) || m.objectives.length === 1);
    const nexusObj = objs.find(st => st.o.k === 'nexus');
    if (nexusObj) { if (state.cores.red.hp <= 0 && objs.filter(st => st.o.k === 'boss').every(st => st.done)) return 'win'; return null; }
    if (state.cores.red.hp <= 0) return 'win';
    if (main.length && main.every(st => st.done)) return 'win';
    return null;
  };
  function starsFor(win) {
    const R = S.R, m = S.m, o = Object.values(R.obj), get = k => o.find(st => st.o.k === k);
    if (!win) return [false, false, false];
    const s = [true, false, false], core = state.cores.blue.hp / state.cores.blue.maxHp;
    switch (m.id) {
      case 'P0': s[1] = core > 0.5; s[2] = get('beacons').done; break;
      case 'M01': s[1] = core > 0.5; s[2] = R.t <= m.par; break;
      case 'M02': { const e = get('evac'); s[1] = e.lost <= 1; s[2] = e.lost === 0; break; }
      case 'M03': { const e = get('intercept'); s[1] = e.killed >= 7; s[2] = e.killed >= 8; break; }
      case 'M04': s[1] = R.minCoreFrac > 0.5; s[2] = get('hold').allAtOnce; break;
      case 'M05': s[1] = get('defend').enemyT < 10; s[2] = R.turretsLost === 0; break;
      case 'M06': s[1] = get('rescue').done; s[2] = R.jousts >= 3; break;
      case 'M07': s[1] = core > 0.5; s[2] = R.minCoreFrac >= 0.75; break;
      default: s[1] = core > 0.5; s[2] = R.minCoreFrac >= 0.75;
    }
    return s;
  }
  S.trackTurretLoss = function (t) { if (S.R && t.team === 'blue') S.R.turretsLost++; };

  // end of a story match (called from showGameOver). Returns true = story handled the end screen.
  S.onEnd = function (win) {
    const R = S.R, m = S.m; if (!R || R.done) return true;
    R.done = true;
    const st = starsFor(win);
    const rec = SAVE.missions[m.id] = SAVE.missions[m.id] || { stars: 0, wins: 0, plays: 0, best: 0, starSet: [false, false, false] };
    const firstClear = win && !rec.wins;
    rec.plays++; let gold = 0, xp = 0, newStars = 0;
    if (win) {
      rec.wins++; rec.best = rec.best ? Math.min(rec.best, Math.round(R.t)) : Math.round(R.t);
      st.forEach((v, i) => { if (v && !rec.starSet[i]) { rec.starSet[i] = true; newStars++; } });
      rec.stars = rec.starSet.filter(Boolean).length;
      const g = G[m.reward[0]], x = X[m.reward[1]];
      gold = firstClear ? g : Math.round(g * 0.5); xp = firstClear ? x : Math.round(x * 0.5);   // replays still pay: grinding never punished
      gold += newStars * 25; xp += newStars * 10;
      (m.unlock || []).forEach(u => { if (!SAVE.unlocks.includes(u)) SAVE.unlocks.push(u); });
    } else { xp = 10; }                                                                          // a loss still teaches something
    SAVE.gold += gold; SAVE.xp += xp; persist();
    S.lastResult = { id: m.id, win, stars: st, gold, xp, firstClear, newStars, t: Math.round(R.t) };
    window.dmgHook = S.prevDmgHook || null;
    document.getElementById('story-hud').classList.add('hidden');
    showResults(S.lastResult);
    return true;
  };
  S.quit = function () {
    S.active = false; S.m = null; S.R = null; window.dmgHook = S.prevDmgHook || null;
    document.getElementById('story-hud').classList.add('hidden');
  };

  // ------------------------------------------------------------------ DRAW (inside the world transform)
  S.draw = function (c) {
    const R = S.R, m = S.m; if (!R) return;
    const now = performance.now() / 1000;
    for (const st of Object.values(R.obj)) {
      const o = st.o;
      if (o.k === 'hold') o.zones.forEach((z, i) => {
        const active = o.mode !== 'sequence' || i <= st.idx || st.owned[i];
        c.fillStyle = st.owned[i] ? 'rgba(74,222,128,0.22)' : active ? 'rgba(250,204,21,0.18)' : 'rgba(148,163,184,0.10)';
        c.fillRect(LANE_X - LANE_HALF_W - 40, z.y - z.h, (LANE_HALF_W + 40) * 2, z.h * 2);
        c.strokeStyle = st.owned[i] ? '#4ade80' : active ? '#facc15' : '#64748b'; c.lineWidth = 3; c.setLineDash([10, 6]);
        c.strokeRect(LANE_X - LANE_HALF_W - 40, z.y - z.h, (LANE_HALF_W + 40) * 2, z.h * 2); c.setLineDash([]);
        label(c, (st.owned[i] ? '\u{1F33E} ' : '\u{1F3DA} ') + z.name + (st.owned[i] ? '' : ' ' + Math.round(100 * st.held[i] / o.secs) + '%'), LANE_X, z.y - z.h - 8);
      });
      if (o.k === 'defend') {
        const z = o.zone; c.fillStyle = 'rgba(56,189,248,0.16)'; c.fillRect(LANE_X - LANE_HALF_W - 40, z.y - z.h, (LANE_HALF_W + 40) * 2, z.h * 2);
        c.strokeStyle = '#38bdf8'; c.lineWidth = 3; c.setLineDash([10, 6]); c.strokeRect(LANE_X - LANE_HALF_W - 40, z.y - z.h, (LANE_HALF_W + 40) * 2, z.h * 2); c.setLineDash([]);
        label(c, '\u{1F3ED} ' + z.name + ' zone', LANE_X, z.y - z.h - 8);
      }
      if (o.k === 'beacons') o.ys.forEach((y, i) => {
        const x = LANE_X + LANE_HALF_W + 22; c.fillStyle = '#44403c'; c.fillRect(x - 2, y - 26, 4, 26);
        c.fillStyle = st.lit[i] ? `rgba(250,204,21,${0.8 + 0.2 * Math.sin(now * 6)})` : '#57534e';
        c.beginPath(); c.arc(x, y - 30, 8, 0, Math.PI * 2); c.fill(); if (st.lit[i]) { c.fillStyle = 'rgba(250,204,21,0.25)'; c.beginPath(); c.arc(x, y - 30, 22, 0, Math.PI * 2); c.fill(); }
      });
    }
    // hazards
    const drawLines = (h, hz) => hz && hz.lines.forEach(l => {
      if (l.warn > 0) { c.strokeStyle = `rgba(249,115,22,${0.4 + 0.4 * Math.sin(now * 14)})`; c.lineWidth = 2; c.setLineDash([6, 6]); c.strokeRect(LANE_X - LANE_HALF_W, l.y - h.h, LANE_HALF_W * 2, h.h * 2); c.setLineDash([]); }
      else { const g = c.createLinearGradient(0, l.y - h.h, 0, l.y + h.h); g.addColorStop(0, 'rgba(239,68,68,0)'); g.addColorStop(0.5, `rgba(249,115,22,${0.55 + 0.2 * Math.sin(now * 20)})`); g.addColorStop(1, 'rgba(239,68,68,0)'); c.fillStyle = g; c.fillRect(LANE_X - LANE_HALF_W - 20, l.y - h.h, (LANE_HALF_W + 20) * 2, h.h * 2); }
    });
    (m.hazards || []).forEach((h, i) => drawLines(h, R.hazards[i]));
    if (m._hz) drawLines(m._hz, R.hazards[9]);
    if (R.rain) { c.strokeStyle = '#f87171'; c.lineWidth = 3; c.beginPath(); c.arc(R.rain.x, R.rain.y, R.rain.r * (1 - R.rain.warn / 1.6 * 0.3), 0, Math.PI * 2); c.stroke(); c.fillStyle = 'rgba(248,113,113,0.18)'; c.fill(); }
    if (R.boss && !R.boss.dead) { const b = R.boss; c.strokeStyle = '#facc15'; c.lineWidth = 3; c.beginPath(); c.ellipse(b.x, b.y + 18, 30, 12, 0, 0, Math.PI * 2); c.stroke(); label(c, '\u{1F451} KING FELIX \u00B7 phase ' + R.phase, b.x, b.y - 52); }
    if (R.boss && !R.boss.dead) { const cr = state.cores.red; c.strokeStyle = `rgba(74,222,128,${0.5 + 0.3 * Math.sin(now * 3)})`; c.lineWidth = 4; c.beginPath(); c.arc(cr.x, cr.y, 70, 0, Math.PI * 2); c.stroke(); }
    // story units
    state.units.forEach(u => {
      if (!u.story || u.dead) return;
      const icon = { civilian: '\u{1F9D1}\u200D\u{1F33E}', wagon: u.team === 'red' ? '\u{1F6E2}' : '\u{1F6D2}', structure: '\u{1F3DB}', cage: '\u26D3', vip: '\u{1F451}' }[u.type] || '?';
      c.save(); c.translate(u.x, u.y + Math.sin(u.walkAnim) * 1.5);
      if (u.type === 'wagon') { c.fillStyle = u.team === 'red' ? '#7c2d12' : '#1e3a8a'; c.fillRect(-16, -10, 32, 20); c.fillStyle = '#292524'; c.beginPath(); c.arc(-10, 11, 5, 0, 7); c.arc(10, 11, 5, 0, 7); c.fill(); }
      if (u.type === 'cage') { c.strokeStyle = '#a8a29e'; c.lineWidth = 3; c.strokeRect(-16, -20, 32, 36); for (let k = -10; k <= 10; k += 7) { c.beginPath(); c.moveTo(k, -20); c.lineTo(k, 16); c.stroke(); } }
      c.font = (u.type === 'civilian' ? 20 : 22) + 'px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(icon, 0, u.type === 'wagon' ? -14 : 0);
      c.restore();
      if (u.type !== 'cage') drawHealthBar(u.x, u.y - u.radius - 14, u.radius * 2, 4, u.hp, u.lagHp, u.maxHp);
      else { const cg = Object.values(S.R.obj).find(s => s.o.k === 'rescue'); const cc = cg && cg.cages.find(x => x.u === u); label(c, '\u26D3 ' + (cc ? cc.c.name : '') + (cc && cc.prog > 0 ? ' ' + Math.round(cc.prog / 3 * 100) + '%' : ''), u.x, u.y - 30); }
    });
  };
  function label(c, t, x, y) { c.save(); c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.lineWidth = 3; c.strokeStyle = 'rgba(15,23,42,0.85)'; c.strokeText(t, x, y); c.fillStyle = '#f8fafc'; c.fillText(t, x, y); c.restore(); }

  // ------------------------------------------------------------------ DOM / UI
  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function injectUI() {
    const root = $('app') || document.body.querySelector('#game-container') || document.body;
    const host = document.getElementById('modal-menu').parentElement;
    host.insertAdjacentHTML('beforeend', `
      <div id="story-hud" class="hidden absolute z-30 pointer-events-none" style="top:8px;left:64px;right:52px"></div>
      <div id="modal-story" class="hidden absolute inset-0 z-[58] flex flex-col items-center overflow-y-auto text-center" style="background:radial-gradient(circle at 50% 45%,#3f3a2c 0%,#1c1a14 70%,#0b0a07 100%)">
        <div class="w-full max-w-sm px-3 pt-3 flex items-center justify-between">
          <button id="st-back" class="py-1.5 px-3 rounded-lg bg-slate-700 text-slate-100 font-black text-[11px] uppercase">\u2190 Menu</button>
          <div class="text-[11px] font-black text-amber-200" id="st-purse"></div>
        </div>
        <h2 class="text-2xl font-black text-amber-300 uppercase tracking-wider mt-1" style="font-family:serif">The Realm of Paradale</h2>
        <div class="text-[10px] text-amber-100/70 mb-1">Act 1 \u00B7 The Red-Eyed Crowns</div>
        <div id="st-map" class="relative w-full max-w-sm" style="aspect-ratio:1/1"></div>
        <div id="st-legend" class="flex flex-wrap justify-center gap-1 text-[9px] font-bold text-slate-200 px-2 mb-1"></div>
        <div id="st-region" class="w-full max-w-sm px-3 pb-3"></div>
        <div class="w-full max-w-sm px-3 pb-4 grid grid-cols-3 gap-2">
          <button id="st-shop" class="py-2 rounded-lg bg-amber-800/80 text-amber-100 font-black text-[10px] uppercase">\u{1F4B0} Treasury</button>
          <button id="st-export" class="py-2 rounded-lg bg-slate-700 text-slate-100 font-black text-[10px] uppercase">Export save</button>
          <button id="st-import" class="py-2 rounded-lg bg-slate-700 text-slate-100 font-black text-[10px] uppercase">Import save</button>
        </div>
      </div>
      <div id="modal-brief" class="hidden absolute inset-0 z-[59] bg-black/90 backdrop-blur-md flex flex-col items-center justify-start overflow-y-auto p-4 text-center"></div>`);
    $('st-back').onclick = () => { $('modal-story').classList.add('hidden'); $('modal-menu').classList.remove('hidden'); };
    $('st-export').onclick = () => { const s = exportSave(); try { navigator.clipboard && navigator.clipboard.writeText(s); } catch (e) {} prompt('Your story save (copied). Keep it somewhere safe:', s); };
    $('st-import').onclick = () => { const s = prompt('Paste a Royal Blight save (RB1....):'); if (!s) return; const r = importSave(s); alert(r === true ? 'Save imported!' : 'Could not import: ' + r); S.openMap(); };
    $('st-shop').onclick = () => showPanel('\u{1F4B0} Royal Treasury', `<p class="text-slate-300 text-xs mb-2">Gold ${SAVE.gold} \u00B7 XP ${SAVE.xp} \u00B7 Level ${level()}</p><p class="text-slate-400 text-xs">The shop opens in a later update. Cleared regions will sell their units, maps, armies and kings for story gold + XP level. No real money, ever.</p>`);
    // menu entry (keeps Quick Match + multiplayer intact)
    const menuBox = $('btn-loadout');
    menuBox.insertAdjacentHTML('beforebegin', `<button id="btn-story" class="w-full max-w-xs mb-2 py-3 rounded-xl bg-gradient-to-r from-amber-600 to-yellow-500 text-slate-950 font-black text-sm uppercase tracking-wider shadow-lg active:scale-95">\u{1F4D6} Story <span class="normal-case font-bold text-[10px]">\u00B7 Act 1</span></button>`);
    $('btn-story').onclick = () => S.openMap();
  }
  function showPanel(title, html, buttons) {
    const b = $('modal-brief');
    b.innerHTML = `<div class="w-full max-w-sm bg-slate-900/95 border border-amber-700/60 rounded-2xl p-4 mt-6 text-left">
      <h3 class="text-lg font-black text-amber-300 uppercase mb-2 text-center">${title}</h3>${html}
      <div class="grid ${buttons && buttons.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} gap-2 mt-3">${(buttons || [['Close', 'close']]).map(([t, k], i) => `<button data-k="${k}" class="py-3 rounded-xl ${i === (buttons || []).length - 1 && k !== 'close' ? 'bg-amber-500 text-slate-950' : 'bg-slate-700 text-slate-100'} font-black text-xs uppercase">${t}</button>`).join('')}</div></div>`;
    b.classList.remove('hidden');
    return new Promise(res => b.querySelectorAll('button[data-k]').forEach(x => x.onclick = () => { b.classList.add('hidden'); res(x.dataset.k); }));
  }
  const cutSlot = key => `<div class="my-2 mx-auto rounded-lg border border-dashed border-amber-500/60 bg-black/60 flex flex-col items-center justify-center text-amber-200/80" style="width:120px;aspect-ratio:9/16" data-cutscene="${key}"><div class="text-2xl">\u{1F3AC}</div><div class="text-[9px] font-bold px-1">Cutscene<br>${esc(key)}<br>(9:16, coming)</div></div>`;
  const beats = lines => lines.map(([who, t]) => `<p class="text-xs text-slate-200 mb-1">${who ? `<b class="text-amber-300">${esc(who)}:</b> ` : ''}<i>${esc(t)}</i></p>`).join('');
  S.openMap = function () {
    $('modal-menu').classList.add('hidden'); $('modal-gameover').classList.add('hidden'); $('modal-story').classList.remove('hidden');
    $('st-purse').textContent = `\u{1FA99} ${SAVE.gold}  \u2B50 XP ${SAVE.xp} (Lv ${level()})`;
    const map = $('st-map');
    // v27: illustrated kingdom map; each region = progress-tinted area with a border in its controlling army's color
    const shapes = Object.keys(REGIONS).map(k => { const col = COLOR[regionColor(k)], [an, ac] = controller(k);
      return `<path d="${regionPath(k)}" fill="${col}" fill-opacity="0.26" stroke="#000" stroke-opacity="0.45" stroke-width="2.4" stroke-linejoin="round"/>` +
             `<path d="${regionPath(k)}" fill="none" stroke="${ac}" stroke-width="1.3" stroke-linejoin="round" stroke-dasharray="${REGIONS[k].hub ? 'none' : '3 1.2'}"><title>${an}</title></path>`; }).join('');
    map.style.background = "url('assets/kingdom_map.jpg') center/cover"; map.style.borderRadius = '14px'; map.style.boxShadow = '0 6px 24px #0009';
    map.innerHTML = `<svg viewBox="0 0 100 100" class="absolute inset-0 w-full h-full">${shapes}</svg>` +
      Object.entries(REGIONS).map(([k, r]) => {
        const col = regionColor(k), w = r.missions.filter(won).length, n = r.missions.length || r.count;
        const pulse = col === 'lightgreen' ? 'animation:stpulse 1.2s infinite' : '';
        const [an, ac] = controller(k), sz = r.hub ? 40 : 34;
        return `<button data-region="${k}" class="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center" style="left:${r.pos[0]}%;top:${r.pos[1]}%">
          <div class="rounded-full shadow-xl flex items-center justify-center text-base" style="width:${sz}px;height:${sz}px;background:${COLOR[col]};border:3px solid ${ac};${pulse}">${r.hub ? '\u{1F3F0}' : r.soon ? '\u2601' : '\u2694'}</div>
          <div class="mt-0.5 px-1.5 rounded bg-black/70 text-[10px] font-black text-white leading-tight">${r.name}<br><span class="text-[9px] font-bold" style="color:${COLOR[col]}">${r.soon ? 'coming soon' : r.hub ? (won('P0') ? 'Prologue \u2713' : 'Prologue') : w + '/' + n}</span><br><span class="text-[8px] font-bold" style="color:${ac}">${an}</span></div></button>`;
      }).join('') + `<style>@keyframes stpulse{0%,100%{box-shadow:0 0 0 0 #86efac}50%{box-shadow:0 0 0 10px #86efac00}}</style>`;
    map.querySelectorAll('button[data-region]').forEach(b => b.onclick = () => S.openRegion(b.dataset.region));
    $('st-legend').innerHTML = (won('P0') ? [['red', 'Under attack'], ['orange', '1+ win'], ['yellow', 'Contested / no contact'], ['lightgreen', 'Final left'], ['green', 'Freed']] : [['green', 'At peace \u2014 play the Prologue']]).map(([c, t]) => `<span class="px-1.5 py-0.5 rounded" style="background:${COLOR[c]}33;border:1px solid ${COLOR[c]}">${t}</span>`).join('');
    S.openRegion(S.curRegion || (won('P0') ? 'eastmarch' : 'paradale'));
  };
  S.openRegion = function (rk) {
    S.curRegion = rk; const r = REGIONS[rk], col = regionColor(rk);
    let h = `<div class="bg-slate-900/90 rounded-xl border-2 p-2 text-left" style="border-color:${COLOR[col]}"><div class="flex justify-between items-center"><div class="font-black text-amber-200 text-sm">${r.name} <span class="text-[10px] text-slate-400">\u00B7 ${r.ruler}</span></div><div class="text-[10px] font-black uppercase" style="color:${COLOR[col]}">${col === 'lightgreen' ? 'FINAL BATTLE' : col}</div></div>`;
    if (r.soon) h += `<p class="text-[11px] text-slate-400 mt-1">Contact lost. This chapter arrives in a later update.</p>`;
    r.missions.forEach(id => {
      const m = M[id], rec = SAVE.missions[id], open = missionOpen(id);
      h += `<button data-mission="${id}" ${open ? '' : 'disabled'} class="w-full mt-1 flex items-center justify-between rounded-lg px-2 py-1.5 ${open ? 'bg-slate-800 active:scale-[0.98]' : 'bg-slate-800/40 opacity-50'}">
        <span class="text-[11px] font-black text-slate-100 text-left">${id} \u00B7 ${esc(m.name)}<br><span class="text-[9px] font-bold text-slate-400">${m.type}</span></span>
        <span class="text-sm">${[0, 1, 2].map(i => rec && rec.starSet[i] ? '\u2B50' : '\u2606').join('')}${open ? '' : ' \u{1F512}'}</span></button>`;
    });
    if (r.cards.length) h += `<div class="mt-2 text-[10px] font-black text-slate-300 uppercase">Unlocks</div><div class="grid grid-cols-5 gap-1 mt-1">` + r.cards.map(([k, ic, nm]) => {
      const hidden = col === 'red'; return `<div class="rounded-lg bg-slate-800 border border-slate-600 p-1 text-center" title="${esc(nm)}"><div class="text-lg">${hidden ? '?' : ic}</div><div class="text-[8px] font-bold text-slate-300 leading-tight">${hidden ? '???' : esc(nm)}</div></div>`; }).join('') + `</div>`;
    h += `</div>`;
    $('st-region').innerHTML = h;
    $('st-region').querySelectorAll('button[data-mission]').forEach(b => b.onclick = () => S.brief(b.dataset.mission));
  };
  S.brief = async function (id) {
    const m = M[id], rec = SAVE.missions[id];
    const obj = (m.objectives || []).map(o => `<li>${esc(objText(o, m))}</li>`).join('');
    const html = `<div class="text-[10px] font-black text-slate-400 uppercase text-center mb-1">${m.type} \u00B7 ${MAPS[m.map].name}</div>
      ${m.cut && m.cut[0] ? cutSlot(m.cut[0]) : ''}${beats(m.before || [])}
      <p class="text-xs text-slate-300 my-2">${esc(m.brief)}</p>
      <div class="text-[10px] font-black text-amber-300 uppercase">Objectives</div><ul class="list-disc ml-4 text-xs text-slate-200 mb-2">${obj}</ul>
      <div class="text-[10px] font-black text-amber-300 uppercase">Stars</div><ul class="text-xs text-slate-200 mb-2">${m.stars.map((s, i) => `<li>${rec && rec.starSet[i] ? '\u2B50' : '\u2606'} ${esc(s)}</li>`).join('')}</ul>
      ${m.tips ? `<div class="text-[10px] font-black text-sky-300 uppercase">Drill notes</div><ul class="list-disc ml-4 text-[11px] text-slate-300 mb-2">${m.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="text-[11px] text-slate-300">Reward: <b class="text-amber-300">${G[m.reward[0]]}g</b> + <b class="text-sky-300">${X[m.reward[1]]} XP</b>${rec && rec.wins ? ' (replay: half, + new stars)' : ''}${m.cards ? ' \u00B7 Limited army: ' + m.cards.join(', ') : ''}</div>`;
    const k = await showPanel(`${id}: ${esc(m.name)}`, html, [['Back', 'back'], ['\u2694 Start', 'go']]);
    if (k === 'go') { $('modal-story').classList.add('hidden'); S.start(id); }
  };
  function objText(o, m) {
    switch (o.k) {
      case 'nexus': return m.objectives.some(x => x.k === 'boss') ? 'Then destroy Felix\u2019s nexus' : 'Destroy the enemy nexus';
      case 'beacons': return 'Bonus: light 3 lanterns by marching past them';
      case 'evac': return `Escort ${o.count} farmers to your nexus (lose at most ${o.lossMax})`;
      case 'intercept': return `Destroy ${o.need} of ${o.count} fire-oil wagons (${o.count - o.need + 1} arrivals = defeat)`;
      case 'escort': return `Get ${o.need} of ${o.count} wagons to the far mine`;
      case 'hold': return `Hold ${o.zones.length} farmsteads in turn (${o.secs}s each); enemies retake a farm they sit in`;
      case 'defend': return `Hold the ${o.zone.name} zone for ${Math.round(o.secs / 60)}:00 (enemy may hold it ${o.maxEnemy}s total)`;
      case 'rescue': return 'Free ' + o.cages.map(c => c.name).join(', ') + ': get troops to the cage with no enemies nearby';
      case 'boss': return 'Defeat King Felix (his nexus is shielded while he stands)';
      case 'gold': return `Bank ${o.target} gold before the enemy`;
      case 'survive': return `Survive ${o.secs}s until reinforcements arrive`;
      case 'deadline': return `Win within ${o.secs}s, before enemy reinforcements arrive`;
      case 'protect': return `Protect the ${o.structs.map(s => s.name).join(', ')} (lose at most ${o.lossMax})`;
      case 'vip': return `Escort ${o.name} to the enemy gate`;
    }
    return o.k;
  }
  async function showResults(r) {
    const m = M[r.id];
    const html = `<div class="text-center text-3xl mb-1">${r.win ? r.stars.map(s => s ? '\u2B50' : '\u2606').join('') : '\u{1F480}'}</div>
      <p class="text-center text-xs text-slate-300 mb-2">${r.win ? 'Victory in ' + Math.floor(r.t / 60) + ':' + String(r.t % 60).padStart(2, '0') : 'Defeat. Regroup and try again: losses still earn XP.'}</p>
      ${r.win ? m.stars.map((s, i) => `<p class="text-xs ${r.stars[i] ? 'text-amber-200' : 'text-slate-500'}">${r.stars[i] ? '\u2B50' : '\u2606'} ${esc(s)}</p>`).join('') : ''}
      <p class="text-center text-sm font-black mt-2"><span class="text-amber-300">+${r.gold}g</span> \u00B7 <span class="text-sky-300">+${r.xp} XP</span></p>
      ${r.win && m.unlock ? `<p class="text-center text-[11px] text-emerald-300 mt-1">${r.firstClear ? 'Unlocked: ' + m.unlock.map(u => (REGIONS[m.region].cards.find(c => c[0] === u) || [0, 0, u.replace('bonus:worker_east', '+1 starting worker in Eastmarch').replace('region:eastmarch', 'Eastmarch is free!')])[2]).join(', ') : ''}</p>` : ''}
      ${r.win ? `<div class="mt-2 border-t border-slate-700 pt-2">${m.cut && m.cut[m.cut.length - 1] && m.cut.length > 1 ? cutSlot(m.cut[m.cut.length - 1]) : ''}${beats(m.after || [])}</div>` : ''}`;
    const k = await showPanel(r.win ? 'Victory!' : 'Defeat', html, [['Retry', 'retry'], ['Continue', 'map']]);
    S.quit(); state.started = false; initGame();
    if (k === 'retry') S.start(r.id); else S.openMap();
  }
  S.renderHud = function () {
    const R = S.R, m = S.m, el = $('story-hud'); if (!R || !el) return;
    const rows = [];
    for (const st of Object.values(R.obj)) {
      const o = st.o, ck = st.done ? '\u2705' : st.failed ? '\u274C' : '\u25AB';
      if (o.k === 'nexus') rows.push(`${ck} Destroy the nexus`);
      if (o.k === 'beacons') rows.push(`${ck} Lanterns ${st.lit.filter(Boolean).length}/3`);
      if (o.k === 'evac') rows.push(`${ck} Farmers safe ${st.saved}/${o.count} \u00B7 lost ${st.lost}/${o.lossMax}`);
      if (o.k === 'intercept') rows.push(`${ck} Wagons destroyed ${st.killed}/${o.need} \u00B7 arrived ${st.arrived}/${o.count - o.need}`);
      if (o.k === 'escort') rows.push(`${ck} Wagons delivered ${st.arrived}/${o.need} \u00B7 lost ${st.killed}`);
      if (o.k === 'hold') rows.push(`${ck} Farms held ${st.owned.filter(Boolean).length}/${o.zones.length}` + (st.idx < o.zones.length && !st.owned[st.idx] ? ` \u00B7 ${o.zones[st.idx].name} ${Math.round(100 * st.held[st.idx] / o.secs)}%` : ''));
      if (o.k === 'defend') rows.push(`${ck} Hold ${o.zone.name} ${fmt(st.left)} \u00B7 enemy ${Math.round(st.enemyT)}/${o.maxEnemy}s`);
      if (o.k === 'rescue') rows.push(`${ck} Free ${o.cages.map(c => c.name).join(', ')}`);
      if (o.k === 'boss') rows.push(`${ck} Defeat Felix` + (R.boss && !R.boss.dead ? ` ${Math.round(100 * R.boss.hp / R.boss.maxHp)}% \u00B7 phase ${R.phase}` : ''));
      if (o.k === 'gold') rows.push(`${ck} Gold ${Math.floor(st.mine || 0)}/${o.target} (enemy ${Math.floor(st.theirs || 0)})`);
      if (o.k === 'survive') rows.push(`${ck} Reinforcements in ${fmt(st.left)}`);
      if (o.k === 'deadline') rows.push(`${ck} Enemy host arrives in ${fmt(st.left)}`);
      if (o.k === 'protect') rows.push(`${ck} Protect: lost ${st.lost || 0}/${o.lossMax}`);
      if (o.k === 'vip') rows.push(`${ck} Escort ${o.name}`);
    }
    if (m.timeLimit) rows.push(`\u23F3 ${fmt(Math.max(0, m.timeLimit - R.t))}`);
    el.innerHTML = `<div class="rounded-xl bg-slate-950/80 border border-amber-500/60 px-2 py-1 text-left shadow-xl"><div class="text-[10px] font-black text-amber-300 uppercase tracking-wide">${m.id} \u00B7 ${esc(m.name)}</div>${rows.map(r => `<div class="text-[11px] font-bold text-slate-100 leading-snug">${r}</div>`).join('')}</div>`;
  };
  const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  S.save = () => SAVE; S.missions = M; S.regions = REGIONS; S.regionColor = regionColor; S.exportSave = exportSave; S.importSave = importSave;
  S.reset = () => { SAVE = freshSave(); persist(); };
  S.setSave = o => { SAVE = migrate(o); persist(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI); else injectUI();
})();
