// Royal Blight v24 — STORY MODE foundation: save system, region map, data-driven mission engine, Chapter 1.
// Loaded after the main game script; talks to it through the shared globals (state, Unit, startMatch, ...)
// and a handful of hooks guarded by `window.Story && Story.active` in index.html.
(function () {
  'use strict';
  // ------------------------------------------------------------------ SAVE (localStorage, versioned)
  const SAVE_KEY = 'royalBlight.story', SAVE_V = 2;   // v27: v2 = illustrated map + new color rules (mapV)
  const freshSave = () => ({ v: SAVE_V, gold: 0, xp: 0, missions: {}, unlocks: ['pawn:sword', 'archer:short', 'worker', 'turret'], seen: [], created: Date.now(), mapV: 2, diff: 'normal', up: {}, power: null, replayStory: false });
  function cleanUp(u) {   // v31 region upgrades { region: { mines, walls, barracks, hall } }, 0..3 each
    const o = {}; if (!u || typeof u !== 'object') return o;
    for (const [r, t] of Object.entries(u)) { if (!/^[a-z]{3,12}$/.test(r) || !t) continue; o[r] = {}; for (const k of ['mines', 'walls', 'barracks', 'hall']) o[r][k] = Math.max(0, Math.min(3, t[k] | 0)); }
    return o;
  }
  function migrate(s) {
    if (!s || typeof s !== 'object') return freshSave();
    const f = freshSave();
    const out = { v: SAVE_V, gold: Math.max(0, Math.floor(+s.gold || 0)), xp: Math.max(0, Math.floor(+s.xp || 0)),
      missions: {}, unlocks: Array.isArray(s.unlocks) ? s.unlocks.filter(x => typeof x === 'string').slice(0, 500) : f.unlocks,
      seen: Array.isArray(s.seen) ? s.seen.filter(x => typeof x === 'string').slice(0, 500) : [], created: +s.created || Date.now(),
      diff: ['easy', 'normal', 'hard'].includes(s.diff) ? s.diff : 'normal', mapV: 2, replayStory: !!s.replayStory, cineAll: !!s.cineAll, power: typeof s.power === 'string' ? s.power : null, up: cleanUp(s.up), migratedFrom: (s.v | 0) < 2 ? (s.v | 0) || 1 : (s.migratedFrom || 0) };   // v1 -> v2: progress is derived from wins, so nothing is lost
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
    northcrag: { name: 'Northcrag', ruler: 'Light Keeper Cline', dir: 'north', pos: [50, 15], missions: [], count: 8, soon: true, cards: [['map:pass', '\u26F0', '?']] },
    southmire: { name: 'Southmire', ruler: 'General Drevlar', dir: 'south', pos: [50, 83], missions: [], count: 8, soon: true, cards: [['map:swamp', '\u{1F480}', '?']] }
  };
  // Mission definitions. Engine keys:
  //  ai {level, strat, income, think}, gold (start), cards (allowed player cards), cap (max player army), map,
  //  objectives: [{k:'nexus'} | {k:'hold', zones:[{y,h,name}], secs, mode:'sequence'} | {k:'defend', zone, secs, maxEnemy}
  //   | {k:'gold', target} | {k:'survive', secs, reinforce} | {k:'deadline', secs} | {k:'rescue', cages:[{y, unit, n, name}]}
  //   | {k:'evac', count, every, lossMax} | {k:'intercept', count, need, every} | {k:'escort', count, need, every}
  //   | {k:'protect', structs:[{x,y,hp,name}], lossMax} | {k:'beacons', ys} | {k:'vip', hp, name}],
  //  hazards: [{k:'fireline', every, warn, dur, dps}], boss {...}, stars: [desc,desc,desc] + starFns.
  // v35.9 per-mission unit restriction. Entries: 'worker', 'turret', 'pawn:<variant>', 'archer:<variant>', 'brute:<variant>',
  //  'wizard:<variant>', 'hero:<type>'. Card bar + story loadout only allow what is listed. Act 1 = BASIC units only
  //  (base variant of each slot, Royal Blue only, no Necromancer faction, no alternate armor/weapon units).
  const A1_BASIC = ['worker', 'turret', 'pawn:sword', 'archer:short', 'brute:base', 'wizard:battle', 'hero:cavalier'];
  const A1 = {   // v35.9 Act 1 teaching order (data only: reorder/redesign missions by editing these lists)
    P0:  ['worker', 'turret', 'pawn:sword', 'archer:short'],                         // controls
    M01: ['worker', 'pawn:sword'],                                                    // miners
    M02: ['worker', 'pawn:sword', 'archer:short'],                                    // pawns + archers
    M03: ['worker', 'pawn:sword', 'archer:short', 'wizard:battle'],                   // wizards + archers
    M04: ['worker', 'pawn:sword', 'archer:short', 'wizard:battle', 'brute:base', 'hero:cavalier'],   // brutes + archers + wizards + heroes
    M05: A1_BASIC, M06: A1_BASIC, M07: A1_BASIC                                       // turrets + practice, mastery mix, boss
  };
  const M = {
    P0: { region: 'paradale', allowedUnits: A1.P0, act: 1, name: 'Festival of Lanterns', type: 'STD + LIM', map: 'arena', gold: 150, reward: ['G1', 'X1'],
      ai: { level: 'easy', strat: 'balanced', income: 0.55 }, cards: ['worker', 'archers', 'turret'], enemy: 'drill',
      brief: 'The Festival of Lanterns: a thousand years since the clans of light marched together. The crowd wants a show. General Garrow\u2019s practice squad holds the far end of the Royal Arena. March past the three pact lanterns to light them (Eastmarch, Westreach, Northcrag), then break the practice nexus. Nobody gets hurt. Garrow promised.',
      tips: ['Pawns march every 15s for free.', 'Tap ARCHER to add archers to every 2nd wave.', 'Workers mine gold. SAFE pays little, FAR pays most but sits near the enemy.', 'A TURRET (250g) taunts nearby enemies.'],
      objectives: [{ k: 'nexus' }, { k: 'beacons', ys: [1560, 1110, 660], name: 'Lanterns' }],
      stars: ['Win the drill', 'Nexus above 50%', 'Light all 3 lanterns'],
      before: [['Ruphene', 'Three lanterns, lit from mine. Like the clans did. Don\u2019t trip, brother.'], ['Rufus', 'Felix brought wheat, Glade brought books. Cline\u2019s on the wall at Highwatch again. He\u2019s the Light Keeper, Ru. Somebody has to watch the pass.'], ['Ruphene', 'I married him, Rufus. I know where he is.'], ['Vesper', 'General Garrow\u2019s squad is ready, Majesty. Give them a show.'], ['Garrow', 'My soldiers are instructed to lose gracefully. Within reason.'], ['Garrow', 'A thousand years of peace, and they made me a drill captain.']],
      after: [['Vesper', 'A fine show, Majesty. The crowd\u2019s still cheering, and the feast is just starting. King Felix is saving you a seat at the high table.'], ['Rufus', 'Then let\u2019s not keep him waiting. Bring the gifts!'], ['Garrow', 'Enjoy the lanterns, lad. I\u2019m riding east at dawn. Something\u2019s off with Felix\u2019s birds.']],
      cut: ['prologue_lanterns', 'prologue_contact_lost'] },
    M01: { region: 'eastmarch', allowedUnits: A1.M01, act: 1, name: 'Smoke on the Horizon', type: 'STD', map: 'farmland', gold: 120, reward: ['G1', 'X1'], par: 420,
      ai: { level: 'normal', strat: 'balanced', income: 0.6 },
      brief: 'Felix\u2019s threat came true. Three days\u2019 ride east, at dawn. Felix\u2019s Green Army is burning the haystacks of Eastmarch. Meet them in the fields and break their nexus. Gold wins wars. Keep your miners alive.',
      objectives: [{ k: 'nexus' }], stars: ['Win', 'Nexus above 50%', 'Win under 7:00 (par)'],
      before: [['Vesper', 'He\u2019ll start with the western rows. He always does, Majesty. Trust me.'], ['Rufus', 'Felix planted half those rows himself. Why burn them?']],
      after: [['Rufus', 'Felix\u2026 the letter. Tell me someone forged it.'], ['Felix', 'I wrote every word.'], ['Rufus', 'Why? I forgave your tithe!'], ['Felix', 'In front of every king at that table. Like a beggar. Never again, Rufus.']], cut: ['ch1_m01_briefing', 'ch1_m01_red_eyes'] },
    M02: { region: 'eastmarch', allowedUnits: A1.M02, act: 1, name: 'Save the Harvest', type: 'EVAC', map: 'farmland', gold: 150, reward: ['G1', 'X1'], unlock: [],
      ai: { level: 'normal', strat: 'balanced', income: 0.6 },
      brief: 'Noon. Smoke over the rows. Farmers are running toward your lines with what they could carry. Bring them home; lose no more than 3. Pawns shield them, archers cover them.',
      objectives: [{ k: 'evac', count: 10, every: 8, lossMax: 3, fromY: 1180, name: 'Farmers' }], noNexusWin: true,
      stars: ['Evacuate the farmers', 'Lose at most 1 farmer', 'Lose zero farmers'],
      before: [['Rufus', 'Farmers first. Fields can wait.'], ['Garrow', 'Fields can\u2019t run, Majesty. Farmers can. Cover them.']], after: [['Farmer', 'I\u2019m Tam. My shield\u2019s yours. The fire took the rest.'], ['Rufus', 'Then I\u2019ll carry it until you want it back.']], cut: ['ch1_m02_farmers'] },
    M03: { region: 'eastmarch', allowedUnits: A1.M03, act: 1, name: 'Fire-Oil Wagons', type: 'INT', map: 'farmland', gold: 180, reward: ['G2', 'X1'], unlock: [],
      ai: { level: 'normal', strat: 'balanced', income: 0.7 },
      brief: 'Dusk. Garrow\u2019s outriders say the oil wagons come up the east road when the light goes. Eight are hauling fire-oil to Felix\u2019s archers. Stop at least 6. Wizard fire bursts wagons and anything bunched around them.',
      objectives: [{ k: 'intercept', count: 8, need: 6, every: 20, name: 'Wagons' }], noNexusWin: true,
      stars: ['Destroy 6 wagons', 'Destroy 7 wagons', 'Destroy all 8'],
      before: [['Garrow', 'Eight wagons at dusk. My riders counted them three nights running.']], after: [['Rufus', 'No more fire for his arrows tonight.'], ['Garrow', 'Or ever, ideally.']], cut: ['ch1_m03_wagons'] },
    M04: { region: 'eastmarch', allowedUnits: A1.M04, act: 1, name: 'Recapture the Farms', type: 'ATK + CUR', map: 'farmland', gold: 180, reward: ['G2', 'X1'], unlock: ['hero:cavalier', 'bonus:worker_east'], heroTrial: true,
      ai: { level: 'normal', strat: 'turtle', income: 0.85 },
      brief: 'Next morning. Ash where the wheat was. Take back the farmsteads one at a time. Watch the fire-lines.',
      objectives: [{ k: 'hold', name: 'Farmsteads', guards: true, secs: 14, mode: 'sequence', pay: 60, zones: [{ y: 1420, h: 80, name: 'South farm' }, { y: 1110, h: 80, name: 'Mill farm' }, { y: 800, h: 80, name: 'East farm' }] }],
      hazards: [{ k: 'fireline', every: 16, warn: 2.2, dur: 4, dps: 14, h: 46 }], noNexusWin: true, timeLimit: 900,
      stars: ['Recapture all 3 farms', 'Nexus above 50%', 'No farm lost, under 4:00'],
      before: [['Garrow', 'South farm\u2019s barely guarded.'], ['Vesper', 'Then start there, Majesty.'], ['Garrow', 'Take my best rider. I\u2019ll find Felix\u2019s camp at first light.']], after: [['Rufus', 'One field at a time.']], cut: ['ch1_m04_fields_reclaimed'] },
    M05: { region: 'eastmarch', allowedUnits: A1.M05, act: 1, name: 'Windmill Ridge', type: 'DEF', map: 'farmland', gold: 260, reward: ['G2', 'X2'], unlock: [],
      ai: { level: 'normal', strat: 'push', income: 1.0 },
      brief: 'Night wind from the east. Garrow rode out at first light and hasn\u2019t come back. The windmill on the ridge is Eastmarch\u2019s signal beacon. Hold it until the wind turns and the fire is lit.',
      objectives: [{ k: 'defend', zone: { y: 1460, h: 110, name: 'Windmill' }, secs: 240, maxEnemy: 25 }], hazards: [{ k: 'fireline', every: 22, warn: 2.2, dur: 3, dps: 10, h: 40, minY: 1250, maxY: 1700 }],
      noNexusWin: true, stars: ['Hold the windmill', 'Enemy holds it under 10s', 'Lose no turrets'],
      before: [['Rufus', 'If the windmill burns, the whole valley starves.'], ['Vesper', 'And Garrow, Majesty?'], ['Rufus', 'Garrow can take care of himself. The mill can\u2019t.'], ['Vesper', 'The beacon is lit, Majesty. I\u2019ll make sure Paradale reads it.']], after: [['Farmer', 'Fire\u2019s out. Mill\u2019s still turning.'], ['Rufus', 'Good. Now let\u2019s find my general.']], cut: ['ch1_m05_windmill'] },
    M06: { region: 'eastmarch', allowedUnits: A1.M06, act: 1, name: 'The Cavalier\u2019s Charge', type: 'RSC', map: 'farmland', gold: 220, reward: ['G2', 'X2'], unlock: [],
      ai: { level: 'normal', strat: 'pulse', income: 1.0 },
      brief: 'Day four. As usual, General Garrow rode ahead to scout Felix\u2019s camp. He didn\u2019t ride back. Push to his jail-wagon, free him, then break the nexus.',
      objectives: [{ k: 'rescue', cages: [{ y: 760, hero: true, name: 'General Garrow' }] }, { k: 'nexus' }],
      stars: ['Win', 'Free Garrow', 'The Cavalier lands 3 jousts'],
      before: [['Vesper', 'Garrow always did ride too far ahead.'], ['Rufus', 'So nobody else has to.'], ['Vesper', 'I\u2019d trust him with my life.']], after: [['Garrow', 'I meant to get captured. Tactically. \u2026Mostly.'], ['Garrow', 'He\u2019s right. I went alone. Somebody told me Felix wanted to talk.'], ['Garrow', 'Felix cries in his tent. Every night. Holds that amulet like it\u2019s choking him.']], cut: ['ch1_m06_garrow'] },
    M07: { region: 'eastmarch', allowedUnits: A1.M07, act: 1, name: 'BOSS: The Scorched King', type: 'BOSS + CUR', map: 'farmland', gold: 260, reward: ['G3', 'X2'], unlock: ['region:eastmarch', 'pawn:shield', 'army:green', 'archer:flame'], final: true,
      ai: { level: 'normal', strat: 'balanced', income: 1.1 },
      brief: 'The fourth night. Felix takes the field himself. His nexus is shielded while he stands; break him three times as he falls back to his fortress. Free him. Don\u2019t kill him.',
      objectives: [{ k: 'boss', name: 'King Felix' }, { k: 'nexus' }],
      boss: { hp: 1000, atk: 30, range: 170, interval: 1.2, speed: 24, y: 300 },
      stars: ['Defeat Felix', 'Nexus above 50%', 'Nexus never below 75%'],
      before: [['Felix', 'You want my fields? Come and take the ashes.'], ['Rufus', 'I don\u2019t want your fields, Felix. I want my friend.']],
      after: [['Felix', 'Rufus\u2026 I wrote it. I meant it, while I wrote it. And I burned everything.'], ['Rufus', 'Fields grow back. You\u2019re home now.'], ['Vesper', 'How\u2026 touching.'], ['Garrow', 'I\u2019ll send word to the Loft. They can pin Eastmarch green.'], ['Felix', 'Send a bird home for me, Chancellor.'], ['Vesper', 'Of course.']],
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
  const ARMY = { paradale: ['Royal Blue', '#2563eb'], eastmarch: ['Green Army', '#a3a322', 'url(#rbWheat)'], westreach: ['Yellow Army', '#eab308'], northcrag: ['Silver Army', '#e5e7eb'], southmire: ['Grave Purple', '#9333ea'] };
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
  function storyLoadout(m) {
    const lo = Object.assign({}, DEFAULT_LOADOUT, (typeof SETTINGS !== 'undefined' && SETTINGS.loadout) || {});
    if (m && m.allowedUnits) {   // v35.9: only listed variants; otherwise the first listed one for that slot (or the base)
      for (const slot of ['pawn', 'archer', 'brute', 'wizard', 'hero']) { const ok = m.allowedUnits.filter(a => a.startsWith(slot + ':')).map(a => a.split(':')[1]);
        if (slot === 'hero') { lo.hero = 'default'; continue; }
        if (!ok.includes(lo[slot])) lo[slot] = ok[0] || DEFAULT_LOADOUT[slot]; }
      return lo;
    }
    for (const slot of Object.keys(lo)) if (lo[slot] !== DEFAULT_LOADOUT[slot] && !unlocked(slot + ':' + lo[slot])) lo[slot] = DEFAULT_LOADOUT[slot];
    // v35.9: starter archer is the basic Short Bow (was Longbow via a free 'archer:long' unlock)
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

  // ---- v31 Region Upgrades + King Powers (STORY_BIBLE 10) ----
  const UP = {
    tracks: [['mines', 'Mines', '+10% battle gold per level'], ['walls', 'Walls', '+5% nexus HP per level'], ['barracks', 'Barracks', '-5g signature unit per level'], ['hall', 'Hall', '+10% battle XP per level']],
    cost: { mines: [100, 150, 250], walls: [100, 150, 250], barracks: [150, 250, 400], hall: [150, 250, 400] },
    names: { paradale: { mines: 'Royal Treasury', walls: 'Lantern Walls', barracks: "Knights' Yard", hall: 'Festival Square', sig: 'brutes', power: 'decree' },
             eastmarch: { mines: 'Golden Granary', walls: 'Hedgerow Forts', barracks: 'Archery Butts', hall: 'Harvest Hall', sig: 'archers', power: 'volley' } }
  };
  S.UP = UP;
  const upOf = rk => (SAVE.up && SAVE.up[rk]) || { mines: 0, walls: 0, barracks: 0, hall: 0 };
  const canUpgrade = rk => rk === 'paradale' ? won('P0') : regionColor(rk) === 'green';
  const powerOpen = rk => UP.tracks.every(([k]) => upOf(rk)[k] >= 3);
  S.powerOpen = powerOpen;
  S.buyUpgrade = function (rk, k) {
    const u = SAVE.up[rk] = Object.assign({ mines: 0, walls: 0, barracks: 0, hall: 0 }, SAVE.up[rk] || {});
    if (!canUpgrade(rk) || u[k] >= 3) return false; const c = UP.cost[k][u[k]]; if (SAVE.gold < c) return false;
    SAVE.gold -= c; u[k]++; if (powerOpen(rk) && !SAVE.power) SAVE.power = UP.names[rk].power; persist(); return true;
  };
  function openTreasury() {
    let h = `<p class="text-slate-300 text-xs mb-2 text-center">Gold <b class="text-amber-300">${SAVE.gold}</b> \u00B7 XP ${SAVE.xp} \u00B7 Level ${level()}</p>`;
    for (const rk of Object.keys(UP.names)) {
      const N = UP.names[rk], u = upOf(rk), open = canUpgrade(rk), P = KING_POWERS[N.power];
      h += `<div class="rounded-xl border border-slate-600 bg-slate-800/80 p-2 mb-2"><div class="flex justify-between text-xs font-black"><span class="text-amber-200">${REGIONS[rk].name}</span><span class="text-[10px] ${open ? 'text-emerald-300' : 'text-slate-500'}">${open ? 'free \u2014 upgrade' : rk === 'paradale' ? 'win the Prologue' : 'free the region first'}</span></div>`;
      for (const [k, nm, ds] of UP.tracks) { const lv = u[k], c = lv < 3 ? UP.cost[k][lv] : 0;
        h += `<div class="flex items-center justify-between mt-1"><div class="text-[11px] text-slate-200 leading-tight"><b>${esc(N[k])}</b> <span class="text-amber-300">${'\u2605'.repeat(lv)}${'\u2606'.repeat(3 - lv)}</span><br><span class="text-[9px] text-slate-400">${nm}: ${ds}</span></div>` +
          (lv >= 3 ? '<span class="text-[10px] font-black text-emerald-300">MAX</span>' : `<button data-up="${rk}:${k}" ${open && SAVE.gold >= c ? '' : 'disabled'} class="px-2 py-1 rounded-lg text-[10px] font-black ${open && SAVE.gold >= c ? 'bg-amber-500 text-slate-950' : 'bg-slate-700 text-slate-400'}">${c}g</button>`) + `</div>`; }
      const po = powerOpen(rk);
      h += `<div class="mt-2 rounded-lg p-1.5 ${po ? 'bg-amber-500/20 border border-amber-400' : 'bg-slate-900/60 border border-slate-700'} flex items-center justify-between"><div class="text-[10px] leading-tight"><b class="${po ? 'text-amber-200' : 'text-slate-400'}">${P.icon} King Power: ${P.name}</b><br><span class="text-slate-400">${po ? esc(P.desc) : 'All 4 tracks at \u2605\u2605\u2605 to unlock'}</span></div>` +
        (po ? `<button data-pw="${N.power}" class="px-2 py-1 rounded-lg text-[10px] font-black ${SAVE.power === N.power ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700 text-slate-100'}">${SAVE.power === N.power ? 'EQUIPPED' : 'EQUIP'}</button>` : '') + `</div></div>`;
    }
    h += `<p class="text-[10px] text-slate-400">Upgrades boost that region's battles. One King Power per battle; its meter fills from kills and gold mined.</p>`;
    showPanel('\u{1F4B0} Royal Treasury', h).then(() => {});
    const b = $('modal-brief');
    b.querySelectorAll('[data-up]').forEach(x => x.onclick = () => { const [rk, k] = x.dataset.up.split(':'); if (S.buyUpgrade(rk, k)) { openTreasury(); $('st-purse').textContent = `\u{1FA99} ${SAVE.gold}  \u2B50 XP ${SAVE.xp} (Lv ${level()})`; } });
    b.querySelectorAll('[data-pw]').forEach(x => x.onclick = () => { SAVE.power = SAVE.power === x.dataset.pw ? null : x.dataset.pw; persist(); openTreasury(); });
  }
  S.start = function (id) {
    const m = M[id]; if (!m || !missionOpen(id)) return false;
    AI_LEVELS.story = Object.assign({}, AI_LEVELS[m.ai.level || 'normal'], { income: m.ai.income || 1, think: m.ai.think || AI_LEVELS[m.ai.level || 'normal'].think, heroWave: 99, heroArmy: 99 });
    const prevArmy = SETTINGS.army; SETTINGS.army = 'blue';
    S.active = true; S.m = m; S.team = 'blue';
    startMatch('cpu', 'story', { mission: id });
    SETTINGS.army = prevArmy;
    state.map = m.map || 'arena'; bgCache = null; mapBgKey();
    state.loadout = { blue: storyLoadout(m), red: Object.assign({}, DEFAULT_LOADOUT, m.region === 'eastmarch' ? { archer: 'flame', pawn: 'sword' } : {}) };
    state.leaders = { blue: 'rufus', red: m.region === 'eastmarch' ? 'felix' : 'necro' };
    AIS.red.strat = AIS.red.strat0 = m.ai.strat || 'balanced'; AIS.red.switches = 0;
    state.blueGold = m.gold || 100;
    { const u = upOf(m.region), N = UP.names[m.region];   // v31 region upgrades for this region's battles
      if (u.walls) { const c = state.cores.blue; c.maxHp = Math.round(c.maxHp * (1 + 0.05 * u.walls)); c.hp = c.maxHp; }
      state.costMod = { blue: N && u.barracks ? { [N.sig]: 5 * u.barracks } : {} };
      if (SAVE.power && KING_POWERS[SAVE.power] && Object.keys(UP.names).some(rk => UP.names[rk].power === SAVE.power && powerOpen(rk))) setKingPowers({ blue: SAVE.power, red: null }); }
    if (m.region === 'eastmarch' && unlocked('bonus:worker_east')) spawnWorker('blue', 'MID');     // M04 reward: +1 starting worker
    const R = S.R = { t: 0, obj: {}, lost: 0, minCoreFrac: 1, turretsLost: 0, spent: 0, jousts: 0, lastJoust: -9, hazards: [], done: null, msgs: [] };
    (m.objectives || []).forEach((o, i) => setupObjective(o, i));
    if (m.boss) spawnBoss(m.boss);
    S.prevDmgHook = window.dmgHook;
    window.dmgHook = (owner, dealt, target) => {
      if (S.prevDmgHook) S.prevDmgHook(owner, dealt, target);
      if (owner && owner.team === 'blue' && target && target.team === 'red') {   // v35.9 tutorial combo events
        if (owner.type === 'archer' && target.markUntil > state.gameTime) R.tComboHit = true;
        if (owner.type === 'brute' && target.scorchUntil > state.gameTime) R.tScorchHit = true; }
      if (owner && owner.type === 'cavalier' && owner.team === 'blue' && owner.chargeState === 'charge' && state.gameTime - R.lastJoust > 1.2 && target instanceof Unit) { R.jousts++; R.lastJoust = state.gameTime; }
    };
    S.renderHud(); document.getElementById('story-hud').classList.remove('hidden');
    tutStart(m);   // v35.9 staged tutorial (off for replays of won missions / when Tutorial tips are Off)
    setTimeout(() => toast(m.name.toUpperCase(), '#fde68a'), 500);
    return true;
  };
  // v28 guarded barns: enemy pawns stand guard at every farmstead. Felix's pawns muster at HALF rate while the
  // guards hold; each guard killed raises the enemy pawn rate one step, back to full when all are down.
  // Guards per farm by difficulty: Easy 1, Normal 2, Hard 3 (step = 50% / total guards).
  const GUARDS = { easy: 1, normal: 2, hard: 3 };
  function spawnBarnGuards(o) {
    const R = S.R, per = GUARDS[SAVE.diff] || 2; R.guards = []; R.barnRate = 0.5; R.pawnAcc = 0; R.guardsDown = 0;
    o.zones.forEach((z, zi) => { for (let g = 0; g < per; g++) {
      const u = spawnUnit('pawn', 'red', 'C', 0); u.x = LANE_X + (g - (per - 1) / 2) * 34; u.y = z.y - 10 + (g % 2) * 14;
      u.speed = 0; u.guard = zi; u.variant = 'shield'; u.maxHp = u.hp = Math.round(u.hp * 1.8); u.lagHp = u.hp; u.atk *= 1.2; u.resist = Object.assign({}, u.resist, { ranged: Math.max(u.resist.ranged || 0, 0.3) }); R.guards.push(u); } });
    const inc = { easy: 1.0, normal: 1.3, hard: 1.6 }[SAVE.diff] || 1.3;   // v28: barn missions scale the enemy economy with difficulty
    AI_LEVELS.story.income *= inc; if (SAVE.diff === 'hard') AI_LEVELS.story.think = AI_LEVELS.hard.think;
  }
  S.pawnsFor = function (team) {           // pawns per wave (index.html triggerWave hook)
    const R = S.R; if (!R || team !== 'red' || R.barnRate == null) return 4;
    R.pawnAcc += 4 * R.barnRate; const n = Math.floor(R.pawnAcc + 1e-6); R.pawnAcc -= n; return n;
  };
  function tickGuards() {
    const R = S.R; if (!R.guards) return;
    const down = R.guards.filter(u => u.dead).length;
    if (down > R.guardsDown) { R.guardsDown = down; R.barnRate = 0.5 + 0.5 * down / R.guards.length;
      toast(down === R.guards.length ? 'Last guard down! Felix musters at full strength.' : `Guard down! Felix musters faster (${Math.round(R.barnRate * 100)}%)`, '#fb923c'); S.bark('guard_down'); }
  }
  function setupObjective(o, i) {
    const R = S.R, st = R.obj[i] = { o, done: false, failed: false };
    if (o.k === 'hold') { st.idx = 0; st.held = o.zones.map(() => 0); st.owned = o.zones.map(() => false); st.loseT = o.zones.map(() => 0); st.allAtOnce = false;
      if (o.guards) spawnBarnGuards(o); }
    if (o.k === 'defend') { st.enemyT = 0; }
    if (o.k === 'beacons') { st.lit = o.ys.map(() => false); }
    if (o.k === 'evac') { st.spawned = 0; st.saved = 0; st.lost = 0; st.next = 3; }
    if (o.k === 'intercept' || o.k === 'escort') { st.spawned = 0; st.killed = 0; st.arrived = 0; st.next = o.k === 'escort' ? 6 : 8; }
    if (o.k === 'rescue') { st.cages = o.cages.map(c => ({ c, prog: 0, freed: false, u: storyUnit({ type: 'cage', team: 'neutral', x: LANE_X, y: c.y, hp: 1e9, speed: 0, radius: 16 }) })); st.cages.forEach(c => { c.u.untargetable = true; }); }
    if (o.k === 'protect') { st.structs = o.structs.map(s => storyUnit({ type: 'structure', team: 'blue', x: s.x || LANE_X + 70, y: s.y, hp: s.hp || 600, speed: 0, radius: 20, label: s.name })); }
    if (o.k === 'vip') { st.u = storyUnit({ type: 'vip', team: 'blue', x: LANE_X, y: state.cores.blue.y - 90, hp: o.hp || 500, speed: o.speed || 18, radius: 15, label: o.name }); }
    if (o.k === 'survive' || o.k === 'deadline') { st.left = o.secs; }
  }
  // v34 THREE-BAR BOSS: each health bar is one phase. When a bar empties the boss flees to his fortress (his nexus),
  // untargetable, heals to full and returns with stronger powers. Only the 3rd bar kills him; then his nexus
  // drops to turret-level HP. Bar HP scales with the story difficulty.
  const BOSS_DIFF = { easy: 0.7, normal: 1, hard: 1.3 };
  const BOSS_PH = { 1: { atk: 1, interval: 1, fx: { r: 40, f: 0.18 } }, 2: { atk: 1.1, interval: 0.9, fx: { r: 48, f: 0.22 } }, 3: { atk: 1.2, interval: 0.85, fx: { r: 56, f: 0.26 } } };
  function spawnBoss(b) {
    const hp = Math.round(b.hp * (BOSS_DIFF[SAVE.diff] || 1));
    const u = new Unit({ type: 'archer', team: 'red', lane: 'C', x: LANE_X, y: b.y, hp, atk: b.atk, range: b.range, interval: b.interval, speed: b.speed, radius: 22, resist: { ranged: 0.3, magic: 0.3 } });
    u.boss = true; u.variant = 'flame'; u.burn = [6, 3]; u.baseAtk = b.atk; u.baseInt = b.interval; u.bossFx = Object.assign({ kind: 'flame' }, BOSS_PH[1].fx);
    state.units.push(u); S.R.boss = u; S.R.phase = 1; S.R.rainT = 6;
  }
  function bossPhase(u, ph) {
    const P = BOSS_PH[ph]; S.R.phase = ph; u.atk = Math.round(u.baseAtk * P.atk); u.attackInterval = u.interval = u.baseInt * P.interval; u.bossFx = Object.assign({ kind: 'flame' }, P.fx);
    if (u.stats) { u.stats.atk = u.atk; }
  }
  // called from dealDamage when the boss hits 0 HP; true = handled (he flees instead of dying)
  S.bossDown = function (u) {
    const R = S.R; if (!R || u !== R.boss || R.phase >= 3) return false;
    u.hp = 1; u.lagHp = 1; u.retreat = true; u.untargetable = true; u.burnT = 0; u.stunT = 0; R.bossFlee = R.phase + 1;
    createSparks(u.x, u.y, '#fb923c', 24); state.shake = Math.max(state.shake || 0, 0.4);
    toast(R.phase === 1 ? 'FELIX FLEES TO HIS FORTRESS!' : 'FELIX FLEES AGAIN! ONE BAR LEFT', '#fde68a'); S.bark('felix_flee');
    return true;
  };

  S.allow = function (team, c) {           // limited army / unlock gating for the story player
    if (team !== 'blue' || !S.m) return true;
    if (c.k === 'node' || c.k === 'tup') return true;
    let cards = S.m.cards || ['worker', 'archers', 'brutes', 'wizards', 'turret'];
    const au = S.m.allowedUnits;   // v35.9
    if (au) cards = cards.filter(k => au.some(a => a === k || a.split(':')[0] === ({ archers: 'archer', brutes: 'brute', wizards: 'wizard' }[k] || k)));
    if (c.k === 'hero' && S.m && S.m.heroTrial && S.R) S.R.trialHero = true;
    if (c.k === 'hero') return (!au || au.some(a => a.startsWith('hero:'))) && (unlocked('hero:cavalier') || !!(S.R && S.R.trialHero));
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
    tickGuards();
    if (S.tutTick) S.tutTick(dt);
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
          if (st.held[i] >= o.secs) { st.owned[i] = true; st.loseT[i] = 0; if (o.pay) { state.blueGold += o.pay; addFloatingText(LANE_X, z.y, '+' + o.pay + 'g REPLANTED!', '#4ade80', 16); } if (o.mode === 'sequence') st.idx = Math.max(st.idx, i + 1); toast(z.name + ' recaptured!', '#4ade80'); S.bark('farm_won'); }
        } else if (r > 0 && b === 0) {                        // enemy retakes a farm it sits in for 10s
          st.loseT[i] += dt; if (st.loseT[i] > 10) { st.owned[i] = false; st.held[i] = 0; st.everLost = true; toast(z.name + ' lost!', '#f87171'); S.bark('farm_lost'); if (o.mode === 'sequence') st.idx = Math.min(st.idx, i); }
        } else st.loseT[i] = Math.max(0, st.loseT[i] - dt);
      });
      if (st.owned.every(Boolean)) { st.allAtOnce = true; st.done = true; }
    } else if (o.k === 'defend') {
      const z = o.zone, b = zoneCount(z, B), r = zoneCount(z, Rd);
      if (r > 0 && r > b) st.enemyT += dt;
      st.left = Math.max(0, o.secs - R.t);
      if (st.enemyT >= o.maxEnemy) st.failed = true; else if (st.left <= 0) st.done = true;
    } else if (o.k === 'beacons') {
      o.ys.forEach((y, i) => { if (!st.lit[i] && B.some(u => Math.abs(u.y - y) < 30)) { st.lit[i] = true; const nLit = st.lit.filter(Boolean).length; toast('Lantern lit! (' + nLit + '/3)', '#fde68a'); S.bark(nLit >= 3 ? 'lantern_3' : nLit === 2 ? 'lantern_2' : 'lantern'); createSparks(LANE_X + 80, y, '#facc15', 16); } });
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
          c.freed = true; c.u.dead = true; toast(c.c.name + ' is free!', '#4ade80'); S.bark('freed');
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
      if (st.left <= 0 && !st.arrived) { st.arrived = true; st.done = true; toast('REINFORCEMENTS HAVE ARRIVED!', '#4ade80'); S.bark('reinf');
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
        if (u.wagon) { u.wagon.arrived++; if (u.team === 'red') { state.redUpgradeLevel += 0.25; toast('A wagon reached Felix! His army burns hotter.', '#fb923c'); S.bark('wagon_in'); } else { state.blueGold += 120; addFloatingText(u.x, u.y, '+120g', '#facc15', 15); } }
        return;
      }
      u.y += Math.sign(d) * u.speed * dt; u.walkAnim += dt * 6;
      u.x += (LANE_X + (u.team === 'blue' ? 25 : -25) - u.x) * 0.8 * dt;
    }
  };
  S.onUnitDeath = function (u) {
    if (!u.story) return;
    if (u.evac) { u.evac.lost++; addFloatingText(u.x, u.y - 14, 'FARMER LOST', '#f87171', 13); }
    if (u.wagon) { u.wagon.killed++; addFloatingText(u.x, u.y - 14, u.team === 'red' ? 'WAGON DESTROYED!' : 'WAGON LOST', u.team === 'red' ? '#4ade80' : '#f87171', 14); createSparks(u.x, u.y, '#f97316', 18); (S.R.wrecks = S.R.wrecks || []).push({ x: u.x, y: u.y, t: state.gameTime }); state.shake = Math.max(state.shake || 0, 0.25); }
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
    const R = S.R, b = R.boss, cr = state.cores.red;
    if (b.dead) { if (!R.bossDown) { R.bossDown = true; cr.hp = Math.min(cr.hp, 1500); state.shake = 0.6; createSparks(cr.x, cr.y, '#4ade80', 30);   // nexus drops to turret-level HP
      toast('FELIX FALLS! HIS NEXUS IS EXPOSED', '#4ade80'); S.bark('felix_down'); } return; }
    R.shieldHp = R.shieldHp || cr.hp; cr.hp = Math.max(cr.hp, R.shieldHp);          // nexus shielded while Felix stands
    if (R.bossFlee && !b.retreat) {                                               // healed at the fortress: back for the next phase
      const ph = R.bossFlee; R.bossFlee = 0; b.rally = true; b.rallyT = 12; bossPhase(b, ph);
      if (ph === 2) { toast('PHASE 2: FELIX RETURNS \u2014 FIRE-LINES SPLIT THE LANE', '#fb923c'); S.bark('phase2'); }
      else { toast('PHASE 3: FELIX RETURNS \u2014 RAIN OF ARROWS!', '#f87171'); S.bark('phase3'); }
    }
    if (b.retreat) return;
    if (R.phase >= 2 && !S.m.hazards) S.m._hz = S.m._hz || { k: 'fireline', every: 9, warn: 2, dur: 3.5, dps: 16, h: 44 };
    if (R.phase >= 2) tickHazard(S.m._hz, 9, dt);
    if (R.phase >= 3) {
      R.rainT -= dt;
      if (R.rainT <= 0) { R.rainT = 6; const B = blueArmy(); if (B.length) { const t = B[Math.floor(Math.random() * B.length)]; R.rain = { x: t.x, y: t.y, warn: 1.6, r: 80 }; } }
      if (R.rain) { R.rain.warn -= dt; if (R.rain.warn <= 0) { const rn = R.rain; state.units.forEach(u => { if (!u.dead && u.team === 'blue' && Math.hypot(u.x - rn.x, u.y - rn.y) < rn.r) dealDamage(u, 45, b, 'ranged'); }); createSparks(rn.x, rn.y, '#fb923c', 30); createSparks(rn.x, rn.y, '#fde047', 16);
          state.particles.push({ type: 'shockwave', color: '249,115,22', x: rn.x, y: rn.y, radius: 10, maxRadius: rn.r * 1.2, life: 0.5, maxLife: 0.5 }); state.shake = Math.max(state.shake || 0, 0.45); R.rain = null; } }
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
      case 'M04': s[1] = R.minCoreFrac > 0.5; s[2] = get('hold').allAtOnce && !get('hold').everLost && R.t < 240; break;
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
    R.done = true; if (S.tutStop) S.tutStop();
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
      { const u = upOf(m.region); gold = Math.round(gold * (1 + 0.1 * u.mines)); xp = Math.round(xp * (1 + 0.1 * u.hall)); }
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
    if (S.tutStop) S.tutStop();
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
        { const img = loadSprite(st.owned[i] ? 'barn' : 'barn_burnt'), bx = i % 2 ? LANE_X - LANE_HALF_W - 70 : LANE_X + LANE_HALF_W + 70;   // v28 barns
          if (img) c.drawImage(img, bx - 62, z.y - 92, 124, 124); }
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
        // v34: the windmill itself stands beside the zone; it catches fire as the enemy holds it
        const hurt = st.failed || st.enemyT >= o.maxEnemy * 0.4, wm = loadSprite(hurt ? 'windmill_burning' : 'windmill'), wx = LANE_X - LANE_HALF_W - 62;
        if (wm) c.drawImage(wm, wx - 70, z.y - 140, 140, 140);
        if (!hurt && st.enemyT > 0) { c.fillStyle = `rgba(249,115,22,${0.25 + 0.15 * Math.sin(now * 9)})`; c.beginPath(); c.arc(wx, z.y - 70, 40, 0, Math.PI * 2); c.fill(); }
      }
      if (o.k === 'rescue') st.cages.forEach(cg => {   // v34: Garrow is locked in a prison wagon until freed; it bursts open on rescue
        const x = cg.u.x, y = cg.c.y, open = cg.freed, img = loadSprite(open ? 'jailwagon_open' : 'jailwagon');
        const sh = !open && cg.prog > 0 ? Math.sin(now * 40) * 2 * (cg.prog / 3) : 0;
        if (img) c.drawImage(img, x - 48 + sh, y - 66, 96, 96);
        if (!open && cg.c.hero) { const g = loadSprite('cavalier_blue'); if (g) c.drawImage(g, x - 22 + sh, y - 62, 44, 44); }
        if (!open && cg.c.hero) { c.strokeStyle = '#3f3f46'; c.lineWidth = 3; for (let k = -16; k <= 16; k += 8) { c.beginPath(); c.moveTo(x + k + sh, y - 44); c.lineTo(x + k + sh, y - 6); c.stroke(); } }
        if (open && !cg.boom) { cg.boom = 1; createSparks(x, y - 30, '#a8a29e', 26); createSparks(x, y - 30, '#facc15', 14); }
        if (open) label(c, '\u2694 ' + cg.c.name + ' rides!', x, y - 74);
      });
      if (o.k === 'beacons') o.ys.forEach((y, i) => {
        const x = LANE_X + LANE_HALF_W + 34, img = loadSprite(st.lit[i] ? 'lantern_on' : 'lantern_off');   // v34 lantern-post art
        if (st.lit[i]) { c.fillStyle = `rgba(250,204,21,${0.22 + 0.08 * Math.sin(now * 6)})`; c.beginPath(); c.arc(x - 12, y - 44, 30, 0, Math.PI * 2); c.fill(); }
        if (img) c.drawImage(img, x - 50, y - 100, 100, 100);
        else { c.fillStyle = '#44403c'; c.fillRect(x - 2, y - 26, 4, 26); c.fillStyle = st.lit[i] ? '#facc15' : '#57534e'; c.beginPath(); c.arc(x, y - 30, 8, 0, Math.PI * 2); c.fill(); }
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
    if (R.boss && !R.boss.dead && R.boss.retreat) { const cr = state.cores.red; label(c, '\u{1F3F0} Felix regroups at his fortress\u2026 ' + Math.round(100 * R.boss.hp / R.boss.maxHp) + '%', cr.x, cr.y + 110); }
    if (R.boss && !R.boss.dead) { const b = R.boss; c.strokeStyle = '#facc15'; c.lineWidth = 3; c.beginPath(); c.ellipse(b.x, b.y + 18, 30, 12, 0, 0, Math.PI * 2); c.stroke(); label(c, '\u{1F451} KING FELIX \u00B7 phase ' + R.phase, b.x, b.y - 52); }
    if (R.boss && !R.boss.dead) { const cr = state.cores.red; c.strokeStyle = `rgba(74,222,128,${0.5 + 0.3 * Math.sin(now * 3)})`; c.lineWidth = 4; c.beginPath(); c.arc(cr.x, cr.y, 70, 0, Math.PI * 2); c.stroke(); }
    (R.wrecks || []).forEach(w => { const a = 1 - (state.gameTime - w.t) / 8, img = loadSprite('oilwagon_burnt'); if (a > 0 && img) { c.globalAlpha = a; c.drawImage(img, w.x - 34, w.y - 44, 68, 68); c.globalAlpha = 1; } });   // v34 wrecks smoulder, then fade
    if (R.wrecks && R.wrecks.length > 12) R.wrecks.splice(0, R.wrecks.length - 12);
    // story units
    state.units.forEach(u => {
      if (!u.story || u.dead) return;
      const icon = { civilian: '\u{1F9D1}\u200D\u{1F33E}', wagon: u.team === 'red' ? '\u{1F6E2}' : '\u{1F6D2}', structure: '\u{1F3DB}', cage: '\u26D3', vip: '\u{1F451}' }[u.type] || '?';
      c.save(); c.translate(u.x, u.y + Math.sin(u.walkAnim) * 1.5);
      if (u.type === 'wagon') {   // v34 oil-wagon art: intact, then burning below half HP
        const img = loadSprite(u.hp < u.maxHp * 0.5 ? 'oilwagon_burnt' : 'oilwagon');
        if (img) { c.restore(); c.drawImage(img, u.x - 34, u.y - 44 + Math.sin(u.walkAnim) * 1.2, 68, 68); drawHealthBar(u.x, u.y - 46, u.radius * 2, 4, u.hp, u.lagHp, u.maxHp); return; }
        c.fillStyle = u.team === 'red' ? '#7c2d12' : '#1e3a8a'; c.fillRect(-16, -10, 32, 20); c.fillStyle = '#292524'; c.beginPath(); c.arc(-10, 11, 5, 0, 7); c.arc(10, 11, 5, 0, 7); c.fill(); }
      if (u.type === 'cage') { c.restore(); const cg = Object.values(S.R.obj).find(s => s.o.k === 'rescue'); const cc = cg && cg.cages.find(x => x.u === u); label(c, '\u26D3 ' + (cc ? cc.c.name : '') + (cc && cc.prog > 0 ? ' ' + Math.round(cc.prog / 3 * 100) + '%' : ''), u.x, u.y - 74); return; }
      if (false) { c.strokeStyle = '#a8a29e'; c.lineWidth = 3; c.strokeRect(-16, -20, 32, 36); for (let k = -10; k <= 10; k += 7) { c.beginPath(); c.moveTo(k, -20); c.lineTo(k, 16); c.stroke(); } }
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
      <div id="story-hud" class="hidden absolute z-30 pointer-events-none" style="top:calc(var(--sat, 0px) + 8px);left:64px;right:52px"></div>
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
        <div class="w-full max-w-sm px-3 pb-4 grid grid-cols-2 gap-2">
          <button id="st-cine" class="py-2 rounded-lg bg-indigo-800/80 text-indigo-100 font-black text-[10px] uppercase">\u{1F3AC} Cinematics</button>
          <button id="st-prologue" class="py-2 rounded-lg bg-sky-800/80 text-sky-100 font-black text-[10px] uppercase">\u{1F3EE} Replay Prologue</button>
          <button id="st-cineall" class="py-2 rounded-lg bg-fuchsia-900/80 text-fuchsia-100 font-black text-[10px] uppercase">\u{1F513} Unlock all cinematics (beta)</button>
          <button id="st-shop" class="py-2 rounded-lg bg-amber-800/80 text-amber-100 font-black text-[10px] uppercase">\u{1F4B0} Treasury</button>
          <button id="st-export" class="py-2 rounded-lg bg-slate-700 text-slate-100 font-black text-[10px] uppercase">Export save</button>
          <button id="st-import" class="py-2 rounded-lg bg-slate-700 text-slate-100 font-black text-[10px] uppercase">Import save</button>
        </div>
      </div>
      <div id="modal-brief" class="hidden absolute inset-0 z-[59] bg-black/90 backdrop-blur-md flex flex-col items-center justify-start overflow-y-auto p-4 text-center"></div>`);
    $('st-back').onclick = () => { $('modal-story').classList.add('hidden'); $('modal-menu').classList.remove('hidden'); };
    $('st-export').onclick = () => { const s = exportSave(); try { navigator.clipboard && navigator.clipboard.writeText(s); } catch (e) {} prompt('Your story save (copied). Keep it somewhere safe:', s); };
    $('st-import').onclick = () => { const s = prompt('Paste a ' + (window.RB_TITLE || 'Royal Blight') + ' save (RB1....):'); if (!s) return; const r = importSave(s); alert(r === true ? 'Save imported!' : 'Could not import: ' + r); S.openMap(); };
    $('st-shop').onclick = () => openTreasury();
    $('st-cine').onclick = () => S.openCinematics();
    $('st-prologue').onclick = () => S.brief('P0');                     // v34.2: tutorial/prologue always replayable
    $('st-cineall').onclick = () => { SAVE.cineAll = true; persist(); S.openCinematics(); };
    // menu entry (keeps Quick Match + multiplayer intact)
    const menuBox = $('btn-loadout');
    menuBox.insertAdjacentHTML('beforebegin', `<button id="btn-story" class="w-full max-w-xs mb-2 py-3 rounded-xl bg-gradient-to-r from-amber-600 to-yellow-500 text-slate-950 font-black text-sm uppercase tracking-wider shadow-lg active:scale-95">\u{1F4D6} Story <span class="normal-case font-bold text-[10px]">\u00B7 Act 1</span></button>`);
    // v35.5: Story always plays the narrator intro (skippable), then the map
    $('btn-story').onclick = () => {
      const pr = S.playCine('intro_realm'); S._introJust = true;
      const tap = document.querySelector('#rb-cine [data-c=tap]'); if (tap) tap.click();   // inside the user gesture -> plays with sound
      pr.then(() => S.openMap());
    };
    // v29: voices toggle + credits
    // v35.6: home = exactly Story, Skirmish (accordion: army, difficulty, loadout), Multiplayer, Options.
    //        Loadout also reachable from Multiplayer; Voices + Credits live in Options.
    (() => {
      const menu = $('modal-menu'), card = menu.querySelector('.diff-btn').closest('#modal-menu > div');
      const lbl = card.querySelector('div'); if (lbl) lbl.remove();
      card.querySelectorAll('.army-btn, .diff-btn').forEach(b => { b.classList.remove('py-2'); b.classList.add('py-3'); });
      card.className = 'w-full bg-slate-800/90 rounded-xl p-3 border border-slate-700 mt-2';
      const lo = $('btn-loadout'); lo.className = 'w-full mt-3 py-3 rounded-lg bg-slate-700 text-slate-100 font-black text-xs uppercase tracking-wider active:scale-95'; card.appendChild(lo);
      const wrap = document.createElement('div'); wrap.id = 'skirmish-wrap'; wrap.className = 'w-full max-w-xs mb-2';
      wrap.innerHTML = `<button id="btn-skirmish" aria-expanded="false" class="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 text-white font-black text-sm uppercase tracking-wider shadow-lg active:scale-95 flex items-center justify-center gap-2">\u2694\uFE0F Skirmish <span class="normal-case font-bold text-[10px]">\u00B7 vs Computer</span><span id="skirm-chev" style="display:inline-block;transition:transform .25s">\u25BE</span></button><div id="skirmish-panel" style="display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s ease, opacity .28s ease;opacity:0"><div style="overflow:hidden;min-height:0"></div></div>`;
      wrap.querySelector('#skirmish-panel > div').appendChild(card);
      const panel = wrap.querySelector('#skirmish-panel'), sb = wrap.querySelector('#btn-skirmish'), chev = wrap.querySelector('#skirm-chev');
      const setOpen = o => { panel.style.gridTemplateRows = o ? '1fr' : '0fr'; panel.style.opacity = o ? '1' : '0'; panel.inert = !o; sb.setAttribute('aria-expanded', o); chev.style.transform = o ? 'rotate(180deg)' : ''; };
      setOpen(false);
      sb.onclick = () => setOpen(sb.getAttribute('aria-expanded') !== 'true');
      const fr = $('btn-friend'); fr.className = 'w-full max-w-xs mb-2 py-3 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 text-white font-black text-sm uppercase tracking-wider shadow-lg active:scale-95'; fr.innerHTML = '\u{1F465} Multiplayer <span class="normal-case font-bold text-[10px]">(2 phones)</span>';
      const st = $('btn-settings'), sum = $('settings-summary'); st.innerHTML = '\u2699\uFE0F Options '; if (sum) st.appendChild(sum);
      st.className = 'w-full max-w-xs mb-2 py-3 rounded-xl bg-slate-600 text-slate-50 font-black text-sm uppercase tracking-wider active:scale-95';
      const keep = new Set([$('menu-logo'), $('menu-title')]), main = [$('btn-story'), wrap, fr, st];
      [...menu.children].filter(e => !keep.has(e) && !main.includes(e) && e.tagName !== 'STYLE' && e.tagName !== 'P').forEach(e => e.remove());
      main.forEach(e => menu.appendChild(e));
      menu.classList.add('overflow-y-auto'); menu.style.justifyContent = 'safe center';
      // Voices + Credits -> Options
      const vc = document.createElement('div'); vc.className = 'w-full max-w-xs grid grid-cols-2 gap-2 mt-3';
      vc.innerHTML = `<button id="btn-vo" class="py-3 rounded-xl bg-slate-700 text-slate-100 font-black text-xs uppercase active:scale-95"></button><button id="btn-credits" class="py-3 rounded-xl bg-slate-700 text-slate-100 font-black text-xs uppercase active:scale-95">\u{1F4DC} Credits</button>`;
      const ms = $('modal-settings'); $('settings-done').before(vc); ms.classList.remove('justify-center'); ms.classList.add('justify-start', 'overflow-y-auto');
      const h2 = ms.querySelector('h2'); if (h2) h2.textContent = 'Options';
      // Loadout also in Multiplayer
      const ch = $('mp-step-choose'); if (ch) { const mb = document.createElement('button'); mb.id = 'btn-mp-loadout'; mb.className = 'w-full py-3 rounded-xl bg-slate-700 text-slate-100 font-black text-xs uppercase tracking-wider active:scale-95'; mb.innerHTML = '\u2694\uFE0F Leader, loadout &amp; map'; mb.onclick = () => lo.click(); ch.children[0].after(mb); }
    })();
    const voLbl = () => $('btn-vo').textContent = S.voMuted() ? '\u{1F507} Voices off' : '\u{1F50A} Voices on';
    voLbl(); $('btn-vo').onclick = () => { S.setVoMute(!S.voMuted()); voLbl(); };
    $('btn-credits').onclick = () => showPanel('Credits', CREDITS_HTML);
  }
  function showPanel(title, html, buttons) {
    const b = $('modal-brief');
    b.innerHTML = `<div class="w-full max-w-sm bg-slate-900/95 border border-amber-700/60 rounded-2xl p-4 mt-6 text-left">
      <h3 class="text-lg font-black text-amber-300 uppercase mb-2 text-center">${title}</h3>${html}
      <div class="grid ${buttons && buttons.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} gap-2 mt-3">${(buttons || [['Close', 'close']]).map(([t, k], i) => `<button data-k="${k}" class="py-3 rounded-xl ${i === (buttons || []).length - 1 && k !== 'close' ? 'bg-amber-500 text-slate-950' : 'bg-slate-700 text-slate-100'} font-black text-xs uppercase">${t}</button>`).join('')}</div></div>`;
    b.classList.remove('hidden');
    return new Promise(res => b.querySelectorAll('button[data-k]').forEach(x => x.onclick = () => { b.classList.add('hidden'); res(x.dataset.k); }));
  }

  // ---- v29: dialogue (portraits + speech bubbles + pre-rendered Piper voice) ----
  const BARKS = {
    farm_won: ['Farmer', 'That\u2019s my father\u2019s barn! Plant it, plant it!'],
    farm_lost: ['Farmer', 'They took a farm back! Hurry!'],
    guard_down: ['Garrow', 'One less guard. Felix will feel that.'],
    lantern: ['Ruphene', 'That one\u2019s for Eastmarch!'],
    lantern_2: ['Ruphene', 'Westreach! Somebody tell Glade to look up from his book!'],
    lantern_3: ['Ruphene', 'And Northcrag. Wherever you are, love.'],
    freed: ['Garrow', 'Free! Where\u2019s my horse? \u2026Where\u2019s my sword?'],
    reinf: ['Ruphene', 'Reinforcements! Right on time.'],
    wagon_in: ['Felix', 'More oil! Burn it all. Nobody gets it.'],
    phase2: ['Felix', 'I\u2019ll cut this field in two. Pick a side, Rufus.'],
    phase3: ['Felix', 'Archers! Rain on everything Paradale ever touched!'],
    felix_down: ['Felix', 'The fire\u2026 it\u2019s going out\u2026 why is it so cold\u2026'],
    felix_flee: ['Felix', 'Not yet! Back to the walls!'],
  };
  S.BARKS = BARKS;
  const PORTRAIT = { Rufus: 'rufus', Ruphene: 'ruphene', Vesper: 'vesper', Garrow: 'garrow', Felix: 'felix', Pip: 'pip', Farmer: 'farmer', '???': 'mystery' };
  const LEFT = { Rufus: 1, Ruphene: 1, Garrow: 1, Pip: 1, Farmer: 1, Vesper: 1 };
  let VO = null, voAudio = null;
  const VO_LINE = {"P0_b0": "p0_ruphene_01.m4a?fc4d0b", "P0_b1": "p0_rufus_01.m4a?b00906", "P0_b2": "p0_ruphene_02.m4a?f9a5a8", "P0_b3": "p0_vesper_02.m4a?c5df9a", "P0_b4": "p0_garrow_01.m4a?88faaa", "P0_b5": "p0_garrow_02.m4a?601911", "bark_lantern": "p0_ruphene_03.m4a?58913c", "bark_lantern_2": "p0_ruphene_04.m4a?5f445f", "bark_lantern_3": "p0_ruphene_05.m4a?14f3fc", "P0_a0": "p0_vesper_03.m4a?3b1b70", "P0_a1": "p0_rufus_02.m4a?cda406", "M01_b0": "m01_vesper_02.m4a?dc7c41", "M01_b1": "m01_rufus_01.m4a?f2cb1e", "M01_a0": "m01_rufus_02.m4a?f8e5fa", "M01_a1": "m01_felix_01.m4a?ec7bb8", "M01_a2": "m01_rufus_03.m4a?79254d", "M01_a3": "m01_felix_02.m4a?e9036e", "M02_b0": "m02_rufus_02.m4a?b63d96", "M02_b1": "m02_garrow_02.m4a?dfa0bd", "M02_a0": "m02_farmer_01.m4a?f14da3", "M02_a1": "m02_rufus_03.m4a?8ff55a", "M03_b0": "m03_garrow_01.m4a?d40200", "bark_wagon_in": "m03_felix_01.m4a?d03507", "M03_a0": "m03_rufus_01.m4a?15b168", "M03_a1": "m03_garrow_02.m4a?8f7f67", "M04_b0": "m04_garrow_01.m4a?b65354", "M04_b1": "m04_vesper_01.m4a?036eac", "M04_b2": "m04_garrow_02.m4a?970c80", "bark_farm_won": "m04_farmer_01.m4a?f6ae59", "bark_farm_lost": "m04_farmer_02.m4a?e3d457", "bark_guard_down": "m04_garrow_03.m4a?7f45d2", "M04_a0": "m04_rufus_01.m4a?e4bf19", "M05_b0": "m05_rufus_02.m4a?d7cc80", "M05_b1": "m05_vesper_01.m4a?72fcff", "M05_b2": "m05_rufus_03.m4a?154949", "M05_a0": "m05_farmer_01.m4a?44faa6", "M05_a1": "m05_rufus_04.m4a?3aaffb", "M06_b0": "m06_vesper_01.m4a?7a0dbd", "M06_b1": "m06_rufus_01.m4a?8a2396", "M06_b2": "m06_vesper_02.m4a?9e1e44", "bark_freed": "m06_garrow_01.m4a?9edeee", "M06_a0": "m06_garrow_02.m4a?2855bd", "M06_a1": "m06_garrow_03.m4a?9d5470", "M07_b0": "m07_felix_01.m4a?f3dce6", "M07_b1": "m07_rufus_01.m4a?f20ea0", "bark_phase2": "m07_felix_02.m4a?679afe", "bark_phase3": "m07_felix_03.m4a?047a84", "bark_felix_down": "m07_felix_04.m4a?dd7614", "bark_felix_flee": "m07_felix_05.m4a?9fd59e", "M07_a0": "m07_felix_06.m4a?1d34f8", "M07_a1": "m07_rufus_02.m4a?2c6d1b", "M07_a2": "m07_vesper_01.m4a?9e6322", "M07_a3": "m07_garrow_01.m4a?5445f0", "M07_a4": "m07_felix_07.m4a?4d38dc", "M07_a5": "m07_vesper_02.m4a?1b09e9", "bark_reinf": "ch1_global_ruphene_01.m4a?bb0ab0"};
  fetch('assets/vo/index.json').then(r => r.json()).then(j => VO = j).catch(() => {});
  S.voMuted = () => localStorage.getItem('rb.voMute') === '1';
  S.setVoMute = m => { localStorage.setItem('rb.voMute', m ? '1' : '0'); if (m && voAudio) voAudio.pause(); };
  S.pauseVo = p => { if (!voAudio) return; if (p) voAudio.pause(); else if (!S.voMuted() && !voAudio.ended) voAudio.play().catch(() => {}); };
  function playVo(key) {
    if (voAudio) { voAudio.pause(); voAudio = null; }
    const fx = VO_LINE[key];   // v34.9: Cut's recorded lines (lineId files) override old Piper VO
    if (S.voMuted() || (!fx && (!VO || !VO[key]))) return null;
    try { voAudio = new Audio('assets/vo/' + (fx || key + '.m4a?' + VO[key].h)); voAudio.volume = 0.95; voAudio.play().catch(() => {}); } catch (e) { voAudio = null; }
    return voAudio;
  }
  const portraitHtml = (who, size) => { const p = PORTRAIT[who];
    return p ? `<img src="assets/portraits/${p}.webp" alt="${esc(who)}" style="width:${size}px;height:${size}px" class="rounded-2xl bg-gradient-to-b from-sky-700 to-slate-900 border-[3px] border-amber-300 shadow-xl object-contain">`
             : `<div style="width:${size}px;height:${size}px" class="rounded-2xl bg-slate-800 border-[3px] border-amber-300 shadow-xl flex items-center justify-center text-4xl">\u{1F4DC}</div>`; };
  // full-screen dialogue: tap to advance, Skip, mute toggle. prefix = mission id + '_b' / '_a'
  S.dialogue = function (lines, prefix) {
    lines = (lines || []).filter(l => l && l[1]);
    if (!lines.length) return Promise.resolve();
    let el = $('rb-dialogue');
    if (!el) { el = document.createElement('div'); el.id = 'rb-dialogue'; el.className = 'fixed inset-0 z-[80] flex flex-col justify-end'; document.body.appendChild(el); }
    el.classList.remove('hidden');
    return new Promise(done => {
      let i = 0, t = null;
      const finish = () => { clearTimeout(t); if (voAudio) voAudio.pause(); el.classList.add('hidden'); el.innerHTML = ''; done(); };
      const show = () => {
        clearTimeout(t);
        if (i >= lines.length) return finish();
        const [w0, txt] = lines[i], who = w0 || 'Narrator', left = !!LEFT[who] || who === 'Narrator', muted = S.voMuted();
        const clean = String(txt);
        el.innerHTML = `<div class="absolute inset-0 bg-black/55"></div>
          <div class="absolute right-3 flex gap-2 z-10" style="top:calc(var(--sat, 0px) + 12px)">
            <button data-d="mute" class="px-3 py-2 rounded-xl bg-slate-800/90 border border-slate-500 text-lg" aria-label="Toggle voices">${muted ? '\u{1F507}' : '\u{1F50A}'}</button>
            <button data-d="skip" class="px-3 py-2 rounded-xl bg-slate-800/90 border border-slate-500 text-xs font-black text-slate-100 uppercase">Skip \u23ED</button></div>
          <div class="relative w-full max-w-md mx-auto px-3 flex ${left ? 'flex-row' : 'flex-row-reverse'} items-end gap-2" style="padding-bottom:calc(var(--sab, 0px) + 2rem);animation:rbpop .18s ease-out">
            <div class="shrink-0 flex flex-col items-center">${portraitHtml(who, 96)}<div class="mt-1 px-2 rounded-md bg-amber-400 text-slate-950 text-[11px] font-black uppercase">${esc(who === 'Narrator' ? 'Narrator' : who)}</div></div>
            <div class="relative flex-1 mb-6 bg-white text-slate-900 rounded-2xl px-3 py-3 shadow-2xl border-[3px] border-slate-900 text-[15px] font-bold leading-snug">
              <div class="absolute bottom-3 ${left ? '-left-3' : '-right-3'} w-0 h-0" style="border-top:10px solid transparent;border-bottom:10px solid transparent;${left ? 'border-right:12px solid #0f172a' : 'border-left:12px solid #0f172a'}"></div>
              ${who === 'Narrator' ? `<i>${esc(clean)}</i>` : esc(clean).replace(/\*([^*]+)\*/g, '<b><i>$1</i></b>').replace(/\(([^)]*)\)/g, '<span class="block text-[11px] text-slate-500 italic font-semibold">($1)</span>')}
              <div class="text-right text-[10px] text-slate-500 font-black mt-1">${i + 1}/${lines.length} \u00B7 tap \u25B6</div></div></div>
          <style>@keyframes rbpop{from{transform:translateY(14px) scale(.96);opacity:.3}to{transform:none;opacity:1}}</style>`;
        const a = playVo(prefix + i);
        // auto-advance after voice ends (+0.9s) or reading time when muted
        const next = () => { i++; show(); };
        if (a) a.onended = () => { t = setTimeout(next, 900); };
        else t = setTimeout(next, 1800 + clean.length * 55);
        el.onclick = e => { const d = e.target.closest('[data-d]'); if (d && d.dataset.d === 'skip') return finish();
          if (d && d.dataset.d === 'mute') { S.setVoMute(!S.voMuted()); d.textContent = S.voMuted() ? '\u{1F507}' : '\u{1F50A}'; return; } next(); };
      };
      show();
    });
  };
  // small non-blocking mid-mission bubble (top of screen)
  let barkT = null;
  S.bark = function (key) {
    const b = BARKS[key]; if (!b || !S.R) return;
    let el = $('rb-bark');
    if (!el) { el = document.createElement('div'); el.id = 'rb-bark'; el.className = 'fixed left-1/2 -translate-x-1/2 z-[60] pointer-events-none w-[92%] max-w-sm'; el.style.top = 'calc(var(--sat, 0px) + 118px)'; document.body.appendChild(el); }
    el.innerHTML = `<div class="flex items-center gap-2" style="animation:rbpop .18s ease-out">${portraitHtml(b[0], 54)}<div class="flex-1 bg-white text-slate-900 rounded-2xl px-2 py-1.5 border-[3px] border-slate-900 shadow-xl text-[12px] font-bold leading-tight"><span class="text-[10px] font-black uppercase text-amber-700">${esc(b[0])}</span><br>${esc(b[1])}</div></div>`;
    el.style.display = 'block'; playVo('bark_' + key);
    clearTimeout(barkT); barkT = setTimeout(() => { el.style.display = 'none'; }, 3800);
  };
  const CREDITS_HTML = `<div class="text-xs text-slate-200 space-y-2">
    <p><b class="text-amber-300">${esc(window.RB_TITLE || 'Royal Blight')}</b> \u00B7 design, code &amp; art direction: XstreamFlex</p>
    <div><div class="text-[10px] font-black text-amber-300 uppercase">Character voices</div>
    <p>Voices synthesized with <b>Piper</b> (rhasspy/piper, piper-tts 1.8.0, GPL-3.0; used offline, not shipped).</p>
    <p>Voices synthesized with Piper using the <b>LibriTTS-R dataset (CC BY 4.0)</b>, Koizumi et al., derived from LibriVox / LibriTTS. Voice model en_US-libritts_r-medium (Ruphene, Vesper, Felix, Garrow, Farmer, Narrator, ???). <a class="underline text-sky-300" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">License</a></p>
    <p>en_US-joe-medium (Rufus): CC0 \u00B7 en_US-kristin-medium (Pip): public domain.</p>
    <p class="text-slate-400">Voice lines were rendered with pitch, tempo and echo filters (ffmpeg).</p></div>
    <div><div class="text-[10px] font-black text-amber-300 uppercase">Art</div><p>Sprites, portraits and maps generated and edited for ${esc(window.RB_TITLE || 'Royal Blight')}.</p></div></div>`;
  // ---- v33 CINEMATICS: the voiced Ch1 cutscenes (assets/cine/<key>.mp4, 720p H.264/AAC, streamed, not precached)
  // 'start' plays after tapping Start on the first attempt; 'end' plays after the first clear. Seen ones go to the gallery.
  const CINE = [
    ['intro_realm', 'P0', 'start', 'The Lanternlands'], ['prologue_lanterns', 'P0', 'end', 'Festival of Lanterns'],
    ['prologue_contact_lost', 'P0', 'end', 'Contact Lost'],
    ['ch1_m01_briefing', 'M01', 'start', 'Smoke on the Horizon'], ['ch1_m01_red_eyes', 'M01', 'end', 'Red Eyes'],
    ['ch1_m02_farmers', 'M02', 'start', 'Save the Harvest'], ['ch1_m03_wagons', 'M03', 'start', 'Fire-Oil Wagons'],
    ['ch1_m04_fields_reclaimed', 'M04', 'end', 'Fields Reclaimed'], ['ch1_m05_windmill', 'M05', 'start', 'The Windmill'],
    ['ch1_m06_garrow', 'M06', 'end', 'Garrow Rides Again'], ['ch1_m07_apology', 'M07', 'end', "Felix's Apology"], ['ch1_m07_cold_smile', 'M07', 'end', 'A Cold Smile']
  ];
  S.CINE = CINE;
  const cinesFor = (id, when) => CINE.filter(c => c[1] === id && c[2] === when).map(c => c[0]);
  // full-screen 9:16 player. Always starts from a tap (iOS needs a user gesture for sound). Resolves when done/skipped.
  S.playCine = function (keys) {
    keys = [].concat(keys).filter(Boolean); if (!keys.length) return Promise.resolve(false);
    let el = $('rb-cine'); if (!el) { el = document.createElement('div'); el.id = 'rb-cine'; el.className = 'fixed inset-0 z-[90] bg-black flex items-center justify-center'; document.body.appendChild(el); }
    el.classList.remove('hidden');
    return new Promise(done => {
      let i = 0;
      const finish = () => { const v = el.querySelector('video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } el.classList.add('hidden'); el.innerHTML = ''; done(true); };
      const one = () => {
        if (i >= keys.length) return finish();
        const k = keys[i], meta = CINE.find(c => c[0] === k) || [k, '', '', k];
        if (!SAVE.seen.includes('cine:' + k)) { SAVE.seen.push('cine:' + k); persist(); }
        el.innerHTML = `<video playsinline webkit-playsinline preload="auto" src="assets/cine/${k}.mp4?v=${window.APP_VERSION||1}" poster="assets/cine/${k}.jpg" class="h-full w-full object-contain bg-black"></video>
          <button data-c="skip" style="top:calc(var(--sat, 0px) + 12px);right:calc(var(--sar, 0px) + 12px);touch-action:manipulation" class="absolute z-20 px-4 py-3 min-w-[64px] min-h-[44px] rounded-xl bg-slate-900/80 border border-slate-500 text-xs font-black text-white uppercase">Skip \u23ED</button>
          <div data-c="tap" class="absolute inset-0 flex flex-col items-center justify-center bg-black/40"><div class="w-20 h-20 rounded-full bg-amber-500 text-slate-950 text-4xl flex items-center justify-center shadow-2xl">\u25B6</div>
          <div class="mt-3 text-amber-200 font-black text-sm uppercase tracking-wider">${esc(meta[3])}</div><div class="text-slate-300 text-[11px]">Tap to watch</div></div>`;
        const v = el.querySelector('video'), tap = el.querySelector('[data-c=tap]');
        v.onended = () => { i++; one(); }; v.onerror = () => { i++; one(); };
        el.querySelector('[data-c=skip]').onclick = e => { e.stopPropagation(); finish(); };
        tap.onclick = () => { v.muted = false; const p = v.play(); tap.style.display = 'none'; if (p && p.catch) p.catch(() => { tap.style.display = 'flex'; }); };
        v.onclick = () => { if (v.paused) v.play(); else v.pause(); };
      };
      one();
    });
  };
  // v34.2: unlocked if watched, OR its mission was ever started/cleared (retroactive for old and cloud saves),
  // OR it belongs to the Prologue (always open), OR the beta "unlock all" switch is on.
  function cineUnlocked(c) { return SAVE.cineAll || c[1] === 'P0' || SAVE.seen.includes('cine:' + c[0]) || !!SAVE.missions[c[1]]; }
  S.cineUnlocked = cineUnlocked;
  S.openCinematics = function () {
    const seen = CINE.filter(cineUnlocked);
    const h = `<p class="text-[11px] text-slate-300 mb-2 text-center">Cutscenes you have unlocked. They play the first time you start or clear a mission.</p><div class="grid grid-cols-2 gap-2">` +
      CINE.map(c => { const ok = seen.includes(c); return `<button data-cine="${c[0]}" ${ok ? '' : 'disabled'} class="rounded-xl overflow-hidden border-2 ${ok ? 'border-amber-500' : 'border-slate-700 opacity-50'} bg-slate-900 text-left">
        <div class="aspect-[9/16] max-h-32 w-full bg-black flex items-center justify-center" style="${ok ? `background:url('assets/cine/${c[0]}.jpg') center/cover` : ''}">${ok ? '<span class="text-2xl">\u25B6</span>' : '\u{1F512}'}</div>
        <div class="px-1.5 py-1 text-[10px] font-black ${ok ? 'text-amber-200' : 'text-slate-500'}">${c[1]} \u00B7 ${ok ? esc(c[3]) : '???'}</div></button>`; }).join('') + `</div>` +
      `<button id="cine-all" class="mt-2 w-full py-2 rounded-lg bg-slate-700 text-slate-100 text-[11px] font-black uppercase" ${seen.length ? '' : 'disabled'}>\u25B6 Play all unlocked (${seen.length}/${CINE.length})</button>`;
    showPanel('\u{1F3AC} Cinematics', h);
    const b = $('modal-brief');
    b.querySelectorAll('[data-cine]').forEach(x => x.onclick = () => { b.classList.add('hidden'); S.playCine(x.dataset.cine).then(() => S.openCinematics()); });
    const all = $('cine-all'); if (all) all.onclick = () => { b.classList.add('hidden'); S.playCine(seen.map(c => c[0])).then(() => S.openCinematics()); };
  };
  const BIG_CUTS = { prologue_contact_lost: 1, ch1_m01_red_eyes: 1, ch1_m07_apology: 1, ch1_m07_cold_smile: 1 };   // v29: video slots only for big story moments
  const cutSlot = key => '';   // v33: real cutscenes play instead (see CINE); gallery on the story map
  const cutSlot0 = key => `<div class="my-2 mx-auto rounded-lg border border-dashed border-amber-500/60 bg-black/60 flex flex-col items-center justify-center text-amber-200/80" style="width:120px;aspect-ratio:9/16" data-cutscene="${key}"><div class="text-2xl">\u{1F3AC}</div><div class="text-[9px] font-bold px-1">Cutscene<br>${esc(key)}<br>(9:16, coming)</div></div>`;
  const beats = lines => lines.map(([who, t]) => `<p class="text-xs text-slate-200 mb-1">${who ? `<b class="text-amber-300">${esc(who)}:</b> ` : ''}<i>${esc(t)}</i></p>`).join('');
  S.openMap = function () {
    $('modal-menu').classList.add('hidden'); $('modal-gameover').classList.add('hidden'); $('modal-story').classList.remove('hidden');
    $('st-purse').textContent = `\u{1FA99} ${SAVE.gold}  \u2B50 XP ${SAVE.xp} (Lv ${level()})`;
    const map = $('st-map');
    // v27: illustrated kingdom map; each region = progress-tinted area with a border in its controlling army's color
    const shapes = Object.keys(REGIONS).map(k => { const col = COLOR[regionColor(k)], [an, ac] = controller(k);
      return `<path d="${regionPath(k)}" fill="${col}" fill-opacity="0.26" stroke="#000" stroke-opacity="0.45" stroke-width="2.4" stroke-linejoin="round"/>` +
             `<path d="${regionPath(k)}" fill="none" stroke="${controller(k)[2] || ac}" stroke-width="${controller(k)[2] ? 2 : 1.3}" stroke-linejoin="round" stroke-dasharray="${REGIONS[k].hub ? 'none' : '3 1.2'}"><title>${an}</title></path>`; }).join('');
    map.style.background = "url('assets/kingdom_map.jpg') center/cover"; map.style.borderRadius = '14px'; map.style.boxShadow = '0 6px 24px #0009';
    const defs = `<defs><pattern id="rbWheat" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#a3a322"/><path d="M1.5 0.3 L1.5 2.7 M1.5 1 L0.7 0.5 M1.5 1 L2.3 0.5 M1.5 1.8 L0.7 1.3 M1.5 1.8 L2.3 1.3" stroke="#fde68a" stroke-width="0.35"/></pattern></defs>`;   // v29: olive wheat border = Green Army
    map.innerHTML = `<svg viewBox="0 0 100 100" class="absolute inset-0 w-full h-full">${defs}${shapes}</svg>` +
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
    const guarded = (m.objectives || []).some(o => o.guards);
    const dsel = guarded ? `<div class="text-[10px] font-black text-amber-300 uppercase mt-2">Difficulty \u00B7 barn guards per farm</div><div class="text-xs text-slate-200">${['easy', 'normal', 'hard'].map(d => d === SAVE.diff ? `<b class="text-amber-300">[${d} ${GUARDS[d]}]</b>` : d + ' ' + GUARDS[d]).join(' \u00B7 ')}</div><p class="text-[10px] text-slate-400">Felix musters pawns at half rate while his barn guards stand; each guard you kill raises it.</p>` : '';
    const replayed = !!(rec && rec.wins);   // v31: replays auto-skip the story unless 'Replay story' is on
    const rs = replayed ? `<button id="st-rs" class="mt-2 w-full py-2 rounded-lg border-2 text-[11px] font-black uppercase ${SAVE.replayStory ? 'bg-amber-500 text-slate-950 border-amber-300' : 'bg-slate-800 text-slate-300 border-slate-600'}">\u{1F4D6} Replay story: ${SAVE.replayStory ? 'ON' : 'OFF'}</button>` : '';
    const bsel = m.boss ? `<div class="text-[10px] font-black text-amber-300 uppercase mt-2">Difficulty \u00B7 boss health per phase</div><div class="text-xs text-slate-200">${['easy', 'normal', 'hard'].map(d => d === SAVE.diff ? `<b class="text-amber-300">[${d} ${Math.round(BOSS_DIFF[d] * 100)}%]</b>` : d + ' ' + Math.round(BOSS_DIFF[d] * 100) + '%').join(' \u00B7 ')}</div><p class="text-[10px] text-slate-400">Three health bars. Each time Felix falls he flees to his fortress, heals, and returns stronger.</p>` : '';
    const kP = showPanel(`${id}: ${esc(m.name)}`, html + dsel + bsel + rs, guarded || m.boss ? [['Back', 'back'], ['Easy', 'd:easy'], ['Normal', 'd:normal'], ['Hard', 'd:hard'], ['\u2694 Start', 'go']] : [['Back', 'back'], ['\u2694 Start', 'go']]);
    const rsb = $('st-rs'); if (rsb) rsb.onclick = () => { SAVE.replayStory = !SAVE.replayStory; persist(); rsb.textContent = '\u{1F4D6} Replay story: ' + (SAVE.replayStory ? 'ON' : 'OFF'); rsb.className = rsb.className.replace(SAVE.replayStory ? 'bg-slate-800 text-slate-300 border-slate-600' : 'bg-amber-500 text-slate-950 border-amber-300', SAVE.replayStory ? 'bg-amber-500 text-slate-950 border-amber-300' : 'bg-slate-800 text-slate-300 border-slate-600'); };
    const k = await kP;
    if (k && k.startsWith('d:')) { SAVE.diff = k.slice(2); persist(); return S.brief(id); }
    if (k === 'go') { $('modal-story').classList.add('hidden'); if (!replayed || SAVE.replayStory) { const cs = cinesFor(id, 'start').filter(c => (SAVE.replayStory || !SAVE.seen.includes('cine:' + c)) && !(c === 'intro_realm' && S._introJust)); S._introJust = false; if (cs.length) await S.playCine(cs); else await S.dialogue(m.before, id + '_b'); } S.start(id); }
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
    if (r.win && (r.firstClear || SAVE.replayStory)) { const ce = cinesFor(r.id, 'end'); if (ce.length) await S.playCine(ce); else await S.dialogue(m.after, r.id + '_a'); }
    const html = `<div class="text-center text-3xl mb-1">${r.win ? r.stars.map(s => s ? '\u2B50' : '\u2606').join('') : '\u{1F480}'}</div>
      <p class="text-center text-xs text-slate-300 mb-2">${r.win ? 'Victory in ' + Math.floor(r.t / 60) + ':' + String(r.t % 60).padStart(2, '0') : 'Defeat. Regroup and try again: losses still earn XP.'}</p>
      ${r.win ? m.stars.map((s, i) => `<p class="text-xs ${r.stars[i] ? 'text-amber-200' : 'text-slate-500'}">${r.stars[i] ? '\u2B50' : '\u2606'} ${esc(s)}</p>`).join('') : ''}
      <p class="text-center text-sm font-black mt-2"><span class="text-amber-300">+${r.gold}g</span> \u00B7 <span class="text-sky-300">+${r.xp} XP</span></p>
      ${r.win && m.unlock ? `<p class="text-center text-[11px] text-emerald-300 mt-1">${r.firstClear ? 'Unlocked: ' + m.unlock.map(u => (REGIONS[m.region].cards.find(c => c[0] === u) || [0, 0, u.replace('bonus:worker_east', '+1 starting worker in Eastmarch').replace('region:eastmarch', 'Eastmarch is free!')])[2]).join(', ') : ''}</p>` : ''}
      ${r.win ? `<div class="mt-2 border-t border-slate-700 pt-2">${m.cut && m.cut[m.cut.length - 1] && m.cut.length > 1 ? cutSlot(m.cut[m.cut.length - 1]) : ''}${beats(m.after || [])}</div>` : ''}`;
    const k = await showPanel(r.win ? 'Victory!' : 'Defeat', html + (window.matchStatsHtml ? '<div class="mt-2 flex justify-center">' + matchStatsHtml() + '</div>' : ''), [['Retry', 'retry'], ['Continue', 'map']]);
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
      if (o.k === 'hold' && R.guards) rows.push(`\u{1F6E1} Barn guards ${R.guards.length - R.guardsDown}/${R.guards.length} \u00B7 enemy muster ${Math.round(R.barnRate * 100)}%`);
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

  // ================================================================== v35.9 ACT 1 STAGED TUTORIAL ENGINE
  // Data-driven: TUT[missionId] = { steps: [...] }. Schema + rules: TUTORIAL_SCHEMA.md. Text lives in TUT_LINES
  // keyed by lineId; every entry below is a PLACEHOLDER until Cut hands over locked lines (S.setTutLines({...})).
  // v35.9: Cut's act1_tutorial_lines.json (69 lines). Missing ids show as [PLACEHOLDER id].
  const TUT_LINES = {
   "tut_p0_goal": "Here's the whole job, lad. Our soldiers march on their own. Get them to that far nexus and break it.",
   "tut_p0_bar": "This rail is the tug-of-war. Blue means we're pushing, red means they are. Keep it blue.",
   "tut_p0_symbols": "Each little mark on the rail is a unit, a miner or a turret. One look tells you who's winning where.",
   "tut_p0_speed": "Too slow? Tap 1x for 2x. Tap it again to come back when it gets busy.",
   "tut_p0_menu": "The ☰ button pauses everything. Restart, the Field Guide and your mission orders all live in there.",
   "tut_p0_sound": "Sound, voices and music switch on and off in that same ☰ menu.",
   "tut_p0_buy": "Pawns come free every wave. Tap ARCHER and archers join the march behind them.",
   "tut_p0_batch": "Tap the card again to batch. Every extra tap adds one more to each wave that card joins.",
   "tut_p0_camera": "Far, Mid and Home jump the view along the lane. Or just drag to look around.",
   "tut_p0_miners": "Workers dig gold. More gold buys more soldiers, so never run short of workers.",
   "tut_p0_zones": "Pick where they dig. SAFE pays little, MID pays better, FAR pays most but sits right under the enemy.",
   "tut_p0_turret": "A turret holds a pad on our side and draws enemies onto itself. It never marches.",
   "tut_p0_stats": "When it's over, the stats screen shows what earned and what cost you. Now go light those lanterns!",
   "tut_p0_fieldguide": "Forget what something does? Open ☰, then the Field Guide. Every unit, combo and symbol you've met is in there.",
   "tut_p0_guide": "Your orders for each fight are in ☰ under Mission Guide: the goal, plus a few hints. Check it any time.",
   "tut_p0_lantern": "That's one lantern lit! March past all three and the crowd gets its show.",
   "tut_m01_miners": "Watch your miners, Majesty. They're your income, and Felix knows it.",
   "tut_m01_attack": "A miner's hit! When a miner gets struck, he drops his load and runs home.",
   "tut_m01_why": "Every dropped load is gold you'll never spend. Guard the lane, or dig somewhere safer.",
   "tut_m01_advance": "The lane's ours for now. Send the miners FAR while it lasts; that's where the big loads are.",
   "tut_m01_retreat": "They're pushing back! Pull the miners to MID or SAFE until the line holds again.",
   "tut_m01_killed": "We lost a miner. Buy another, move the rest closer to home, or push the enemy off them. Pick one, fast.",
   "tut_m02_pawns": "Pawns march every wave for free. Put them between the farmers and the fire.",
   "tut_m02_archers": "Tap ARCHER. Archers shoot over the pawns and pick off whatever chases the farmers.",
   "tut_m02_batch": "Tap ARCHER again to double up. Two archers per wave covers twice the road.",
   "tut_m02_combo": "See that? Pawns mark a foe, and archers hit marked foes harder. That's your first combo.",
   "tut_m02_fieldguide": "That combo's in the Field Guide now. ☰, then Field Guide, whenever you need a reminder.",
   "tut_m03_wizard": "Wizards, Majesty. Their fireballs splash, so one shot hurts a whole cluster.",
   "tut_m03_wagon": "Here comes a wagon. Fire-oil burns fast; let the wizards light it up.",
   "tut_m03_crowd": "They're bunching up. That's exactly what a wizard wants.",
   "tut_m03_cover": "Wizards break easily. Keep pawns in front and archers beside them.",
   "tut_m04_brute": "Brutes are slow and tough, and magic barely scratches them. Send them where it's thickest.",
   "tut_m04_combo": "Wizard fire scorches, and brutes hit scorched foes harder. Burn first, then smash.",
   "tut_m04_hero": "My best rider's yours today. A hero comes once per fight and charges straight through the line.",
   "tut_m04_fireline": "Fire-line coming! Pull out of the glowing strip or lose the whole wave.",
   "tut_m04_hold": "Every card's in your hand now. Pawns hold, archers mark, wizards burn, brutes break. Take the farm.",
   "tut_m05_pads": "Those glowing pads take turrets. The mill needs every one we can build.",
   "tut_m05_turret": "A turret pulls enemies onto itself and buys the army time.",
   "tut_m05_limits": "A turret alone won't hold, Majesty. It can't march and it can't win. Soldiers do that.",
   "tut_m06_guide": "Lost track of the goal? ☰, then Mission Guide. Garrow's cage is the target.",
   "tut_m06_cagehint": "Garrow's in that wagon. March troops onto it and keep enemies clear for 3 seconds to break the lock.",
   "tut_m06_freed": "Garrow's free! His Cavalier fights under his own name now.",
   "tut_m06_counter": "They're beating us the same way every time. Mix in something they can't handle.",
   "tut_m07_shield": "His nexus is shielded while Felix stands. Break Felix first, then the walls.",
   "tut_m07_phase2": "He's falling back to the second line. He's hurt, but he'll hit harder now.",
   "tut_m07_phase3": "Last stand, Majesty. One more break and he's done.",
   "tut_m07_splash": "Careful near their nexus. When it's hit, the blast catches anything close.",
   "tip_pawn": "Pawns: free every wave, they hold the front. Weak alone.",
   "tip_archer": "Archers: hit hard from range. Fragile, so keep pawns in front.",
   "tip_wizard": "Wizards: fireballs splash crowds. Fragile, and slow to fire.",
   "tip_brute": "Brutes: slow and tough, they shrug off magic. Archers wear them down.",
   "tip_worker": "Workers: mine gold, and run home when hit. Farther mines pay more.",
   "tip_cavalier": "The Cavalier: one per fight. He charges straight through the line.",
   "tip_turret": "Turrets: hold a pad and taunt nearby foes. They never march.",
   "fg_pawn": "Pawn. Free with every wave. Holds the front and marks foes for archers. Weak against wizard splash.",
   "fg_archer": "Archer. Ranged damage from behind the pawns, bonus damage to marked foes. Dies fast if reached.",
   "fg_wizard": "Wizard. Splash fireballs that scorch. Best against crowds, worst against brutes.",
   "fg_brute": "Brute. Slow, high health, resists magic. Hits scorched foes harder.",
   "fg_worker": "Worker. Mines gold at SAFE, MID or FAR. Drops its load and flees when hit.",
   "fg_hero": "Hero. One per match. The Cavalier charges through the enemy line.",
   "fg_combo_pawn_archer": "Pawn + Archer: pawns mark foes, and archers deal extra damage to marked foes.",
   "fg_combo_wizard_brute": "Wizard + Brute: wizards scorch foes, and brutes hit scorched foes harder.",
   "fg_turret": "Turret. Built on a pad near your side and taunts nearby enemies. Doesn't march, can't win alone.",
   "fg_bar": "Tug-of-war bar. Shows where the fighting is. More blue means you're pushing toward their nexus.",
   "fg_bar_symbols": "Bar symbols. Each mark is a unit, worker or turret at its spot in the lane.",
   "fg_ctl_speed": "Speed. Tap 1x / 2x to switch game speed.",
   "fg_ctl_menu": "Menu ☰. Pauses the game. Restart, sound, voices, music, the Field Guide and the Mission Guide.",
   "fg_ctl_camera": "Camera. Far, Mid and Home jump the view; drag to look around.",
   "fg_ctl_zones": "Mine zones. SAFE 10g, MID 50g, FAR 180g per trip. The farther the mine, the closer the enemy.",
   "fg_ctl_batch": "Batching. Tap a card again to add one more of that unit to every wave it joins."
  };
  const line = id => TUT_LINES[id] || ('[PLACEHOLDER ' + id + ']');
  S.TUT_LINES = TUT_LINES; S.setTutLines = o => Object.assign(TUT_LINES, o || {});
  // Steps run in order. trigger: {k:'time',t} mission secs | {k:'delay',t} secs after previous step | {k:'event',e} | {k:'cond',c,v}
  //  forceAfter + force: if the trigger hasn't happened that long after the previous step, do the force once.
  //  pause: true (freeze) | 'slow' | false. point: CSS selector | {unit:type, team} | {node:'FAR'}. Resume on tap.
  const TUT = {
    P0: { steps: [
      { id: 'goal', line: 'tut_p0_goal', speaker: 'Garrow', voiced: true, trigger: { k: 'time', t: 1.5 }, pause: true, point: '#hud-strip' },
      { id: 'bar', line: 'tut_p0_bar', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 2 }, pause: true, point: '#tension-rail' },
      { id: 'symbols', line: 'tut_p0_symbols', speaker: 'Garrow', trigger: { k: 'delay', t: 0.5 }, pause: true, point: '#rail-glyph-layer' },
      { id: 'speed', line: 'tut_p0_speed', speaker: 'Garrow', trigger: { k: 'delay', t: 2 }, pause: true, point: '#btn-speed' },
      { id: 'menu', line: 'tut_p0_menu', speaker: 'Garrow', trigger: { k: 'delay', t: 0.5 }, pause: true, point: '#btn-pause' },
      { id: 'fieldguide', line: 'tut_p0_fieldguide', speaker: 'Garrow', trigger: { k: 'delay', t: 0.5 }, pause: true, point: '#btn-pause' },   // Cut: #btn-fieldguide -> lives in the ☰ menu (#pm-guide)
      { id: 'guide', line: 'tut_p0_guide', speaker: 'Garrow', trigger: { k: 'delay', t: 0.5 }, pause: true, point: '#btn-pause' },             // Cut: #btn-guide -> ☰ menu (#pm-mission)
      { id: 'sound', line: 'tut_p0_sound', speaker: 'Garrow', trigger: { k: 'delay', t: 0.5 }, pause: true, point: '#btn-pause' },
      { id: 'buy', line: 'tut_p0_buy', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 2 }, pause: true, point: '#btn-buy-archer' },
      { id: 'batch', line: 'tut_p0_batch', speaker: 'Garrow', trigger: { k: 'event', e: 'unitBought' }, forceAfter: 25, pause: true, point: '#btn-buy-archer' },
      { id: 'camera', line: 'tut_p0_camera', speaker: 'Garrow', trigger: { k: 'delay', t: 3 }, pause: true, point: '#snap-far' },
      { id: 'miners', line: 'tut_p0_miners', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 3 }, pause: true, point: '#btn-buy-worker' },
      { id: 'zones', line: 'tut_p0_zones', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 1 }, pause: true, point: '#node-mid' },
      { id: 'turret', line: 'tut_p0_turret', speaker: 'Garrow', trigger: { k: 'delay', t: 4 }, pause: true, point: '#btn-buy-turret' },
      { id: 'lantern', line: 'tut_p0_lantern', speaker: 'Garrow', voiced: true, trigger: { k: 'event', e: 'lanternLit' }, forceAfter: 60, pause: 'slow' },
      { id: 'stats', line: 'tut_p0_stats', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 4 }, pause: 'slow' }
    ] },
    M01: { steps: [
      { id: 'miners', line: 'tut_m01_miners', speaker: 'Garrow', voiced: true, trigger: { k: 'time', t: 4 }, pause: true, point: { unit: 'worker', team: 'blue' } },
      { id: 'attack', line: 'tut_m01_attack', speaker: 'Garrow', voiced: true, trigger: { k: 'event', e: 'workerHit' }, forceAfter: 20, force: { k: 'attackMiner' }, pause: 'slow', point: { unit: 'worker', team: 'blue', hit: true } },
      { id: 'why', line: 'tut_m01_why', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 0.3 }, pause: true, point: '#node-safe' },
      { id: 'advance', line: 'tut_m01_advance', speaker: 'Garrow', voiced: true, trigger: { k: 'cond', c: 'pushing', v: 60 }, forceAfter: 40, pause: true, point: '#node-far' },
      { id: 'retreat', line: 'tut_m01_retreat', speaker: 'Garrow', voiced: true, trigger: { k: 'cond', c: 'pushedBack', v: 90 }, forceAfter: 45, force: { k: 'enemyPush', n: 3 }, pause: true, point: '#node-mid' },
      { id: 'killed', line: 'tut_m01_killed', speaker: 'Garrow', voiced: true, trigger: { k: 'event', e: 'workerKilled' }, forceAfter: 40, force: { k: 'killMiner' }, pause: true, point: '#btn-buy-worker' }
    ] },
    M02: { steps: [
      { id: 'pawns', line: 'tut_m02_pawns', speaker: 'Garrow', voiced: true, trigger: { k: 'time', t: 4 }, pause: true, point: { unit: 'pawn', team: 'blue' } },
      { id: 'archers', line: 'tut_m02_archers', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 1 }, pause: true, point: '#btn-buy-archer' },
      { id: 'batch', line: 'tut_m02_batch', speaker: 'Garrow', trigger: { k: 'event', e: 'batched' }, forceAfter: 30, pause: true, point: '#btn-buy-archer' },
      { id: 'combo', line: 'tut_m02_combo', speaker: 'Garrow', voiced: true, trigger: { k: 'event', e: 'comboHit' }, forceAfter: 45, pause: 'slow' },
      { id: 'fieldguide', line: 'tut_m02_fieldguide', speaker: 'Garrow', trigger: { k: 'delay', t: 1 }, pause: false, point: '#btn-pause' }
    ] },
    M03: { steps: [
      { id: 'wizard', line: 'tut_m03_wizard', speaker: 'Garrow', voiced: true, trigger: { k: 'time', t: 4 }, pause: true, point: '#btn-buy-wizard' },
      { id: 'wagon', line: 'tut_m03_wagon', speaker: 'Garrow', voiced: true, trigger: { k: 'cond', c: 'time', v: 20 }, pause: 'slow' },
      { id: 'crowd', line: 'tut_m03_crowd', speaker: 'Garrow', trigger: { k: 'delay', t: 15 }, pause: 'slow' },
      { id: 'cover', line: 'tut_m03_cover', speaker: 'Garrow', trigger: { k: 'delay', t: 20 }, pause: false }
    ] },
    M04: { steps: [
      { id: 'brute', line: 'tut_m04_brute', speaker: 'Garrow', voiced: true, trigger: { k: 'time', t: 4 }, pause: true, point: '#btn-buy-brute' },
      { id: 'combo', line: 'tut_m04_combo', speaker: 'Garrow', voiced: true, trigger: { k: 'event', e: 'scorchHit' }, forceAfter: 40, pause: 'slow' },
      { id: 'hero', line: 'tut_m04_hero', speaker: 'Garrow', voiced: true, trigger: { k: 'delay', t: 5 }, pause: true, point: '#btn-buy-hero' },   // Cut: #btn-hero
      { id: 'fireline', line: 'tut_m04_fireline', speaker: 'Rufus', voiced: true, trigger: { k: 'event', e: 'firelineWarn' }, forceAfter: 30, pause: 'slow' },
      { id: 'hold', line: 'tut_m04_hold', speaker: 'Garrow', trigger: { k: 'delay', t: 10 }, pause: false }
    ] },
    M05: { steps: [
      { id: 'pads', line: 'tut_m05_pads', speaker: 'Rufus', voiced: true, trigger: { k: 'time', t: 3 }, pause: true, point: { pad: 'blue' } },
      { id: 'turret', line: 'tut_m05_turret', speaker: 'Farmer', voiced: true, trigger: { k: 'event', e: 'turretBuilt' }, forceAfter: 30, pause: 'slow', point: '#btn-buy-turret' },
      { id: 'limits', line: 'tut_m05_limits', speaker: 'Vesper', voiced: true, trigger: { k: 'event', e: 'turretDown' }, forceAfter: 90, pause: true }
    ] },
    M06: { steps: [
      { id: 'guide', line: 'tut_m06_guide', speaker: 'Vesper', trigger: { k: 'time', t: 5 }, pause: false, point: '#btn-pause' },
      { id: 'freed', line: 'tut_m06_freed', speaker: 'Rufus', voiced: true, trigger: { k: 'event', e: 'cageFreed' }, forceAfter: 150, force: { k: 'freeCage' }, pause: true },   // v36.0.1: hint at 150s, staged rescue 15s later
      { id: 'counter', line: 'tut_m06_counter', speaker: 'Rufus', trigger: { k: 'cond', c: 'pushedBack', v: 90 }, forceAfter: 120, pause: false }
    ] },
    M07: { steps: [
      { id: 'shield', line: 'tut_m07_shield', speaker: 'Garrow', voiced: true, trigger: { k: 'time', t: 3 }, pause: true },
      { id: 'phase2', line: 'tut_m07_phase2', speaker: 'Garrow', voiced: true, trigger: { k: 'event', e: 'bossPhase2' }, pause: 'slow' },
      { id: 'phase3', line: 'tut_m07_phase3', speaker: 'Rufus', voiced: true, trigger: { k: 'event', e: 'bossPhase3' }, pause: 'slow' },
      { id: 'splash', line: 'tut_m07_splash', speaker: 'Garrow', trigger: { k: 'cond', c: 'pushing', v: 8 }, forceAfter: 15, pause: 'slow' }
    ] }
  };
  S.heroLabel = k => k === 'cavalier' ? (won('M06') || (S.m && S.m.id === 'M06' && S.R && Object.values(S.R.obj).some(st => st.cages && st.cages.every(c => c.freed))) ? 'General Garrow' : 'Garrow\u2019s Outrider') : null;
  S.TUT = TUT; const TUT_VO = S.TUT_VO = {};
  const blueWorkers = () => state.units.filter(u => !u.dead && u.team === 'blue' && u.type === 'worker');
  const lineFrac = () => { const y = calculateBattlelineY(), b = state.cores.blue.y, r = state.cores.red.y; return (b - y) / (b - r); };   // 0 = at our nexus, 1 = at theirs
  const EV = {   // polled each frame; the first true starts the step
    workerHit: () => S.T.workerHit,
    unitBought: () => (state.blueCadence.archers + state.blueCadence.wizards + state.blueCadence.brutes) > 0,
    batched: () => Math.max(state.blueCadence.archers, state.blueCadence.wizards, state.blueCadence.brutes) >= 2,
    turretBuilt: () => state.turretPads.some(p => p.team === 'blue' && p.turret && !p.turret.dead),
    workerKilled: () => S.T.workerKilled,
    comboHit: () => !!(S.R && S.R.tComboHit), scorchHit: () => !!(S.R && S.R.tScorchHit),
    lanternLit: () => Object.values(S.R.obj).some(st => st.lit && st.lit.some(Boolean)),
    cageFreed: () => Object.values(S.R.obj).some(st => st.cages && st.cages.some(c => c.freed)),
    bossPhase2: () => Math.max(S.R.phase || 0, S.R.bossFlee || 0) >= 2, bossPhase3: () => Math.max(S.R.phase || 0, S.R.bossFlee || 0) >= 3,   // v36.0: fire as he flees, not only on rally
    turretDown: () => S.R.turretsLost > 0,
    heroDeployed: () => state.units.some(u => !u.dead && u.team === 'blue' && u.type === 'cavalier'),
    firelineWarn: () => (S.R.hazards || []).some(h => h && h.lines.some(l => l.warn > 0)),
    farZone: () => { const b = $('node-far'); return !!b && b.getAttribute('aria-pressed') === 'true'; }
  };
  const COND = {   // {k:'cond', c, v}
    gold: v => state.blueGold >= v, workers: v => blueWorkers().length >= v, time: v => S.R.t >= v,
    pushing: v => lineFrac() > 0.55 && S.R.t >= (v || 0), pushedBack: v => lineFrac() < 0.42 && S.R.t >= (v || 0),
    event: v => !!(EV[v] && EV[v]())
  };
  const FORCE = {
    attackMiner() {   // spawn one enemy pawn right next to the miner that is farthest up the lane
      const ws = blueWorkers().sort((a, b) => a.y - b.y); let w = ws[0];
      if (!w) { spawnWorker('blue', 'MID'); return; }
      const u = spawnUnit('pawn', 'red', 'C', 0); u.x = w.x + 18; u.y = w.y - 50; u.tutForced = true;
    },
    enemyPush(f) { for (let i = 0; i < (f.n || 3); i++) { const u = spawnUnit('pawn', 'red', 'C', 0); u.y += i * 12; u.tutForced = true; } },
    killMiner() {   // a forced miner death: one enemy pawn finishes the farthest miner
      const w = blueWorkers().sort((a, b) => a.y - b.y)[0]; if (!w) return;
      const u = spawnUnit('pawn', 'red', 'C', 0); u.x = w.x + 18; u.y = w.y - 30; u.tutForced = true; dealDamage(w, w.hp + 1, u, 'physical');
    },
    spawnWorker() { spawnWorker('blue', 'MID'); },
    freeCage() {   // v36.0.1: point at Garrow's wagon with how-to; if still caged 15s later, stage the rescue (clear the guards, free him)
      const st = Object.values(S.R.obj).find(s => s.cages); if (!st) return; const cg = st.cages.find(c => !c.freed); if (!cg) return;
      const T = S.T; T.box = true; const ps = state.paused; state.paused = true;
      tipBox('Vesper', line('tut_m06_cagehint'), unitPoint({ at: cg.u }), 'cagehint', () => { state.paused = ps; T.box = false; T.log.push('cagehint'); });
      T.stageAt = T.since + 15; T.stageCage = cg;
    },
    camera(f) { const b = $('snap-' + (f.v || 'mid')); if (b) b.click(); }
  };
  S.tutForce = FORCE; S.tutEvents = EV; S.tutConds = COND;
  // On unless the player switched it off; a replay of a mission already won always runs with tutorials OFF.
  const tipsOn = () => !(typeof SETTINGS !== 'undefined' && SETTINGS.tutTips === false);
  S.tipsOn = tipsOn;
  S.setTips = on => { SETTINGS.tutTips = !!on; try { localStorage.setItem('rb-settings', JSON.stringify(SETTINGS)); } catch (e) {} };
  function tutStart(m) {
    const replay = won(m.id), data = m.tutorial === false ? null : (m.tutorial || TUT[m.id]);
    S.T = { on: tipsOn() && !replay && !!data, tipsOn: tipsOn(), replay, steps: data ? data.steps : [], i: 0, since: 0, forced: false, workerHit: false, box: false, log: [] };
  }
  function tutTick(dt) {
    const T = S.T; if (!T) return;
    const ws = blueWorkers();
    if (!T.workerHit && ws.some(w => w.workerState === 'FLEEING')) T.workerHit = true;
    if (T.wk && T.wk.some(w => w.dead || !state.units.includes(w))) T.workerKilled = true;
    T.wk = ws;
    if (T.tipsOn) firstTips();
    if (!T.on || T.box || T.i >= T.steps.length) return;
    const st = T.steps[T.i], tr = st.trigger || { k: 'delay', t: 0 }; T.since += dt;
    if (T.stageCage && T.since >= T.stageAt) { const cg = T.stageCage; T.stageCage = null;
      if (!cg.freed) { state.units.forEach(u => { if (u.team === 'red' && !u.dead && !u.story && Math.hypot(u.x - cg.u.x, u.y - cg.u.y) < 90) u.y = Math.max(0, u.y - 160); }); cg.prog = 3.5; cg.staged = true; T.log.push('stage:freed'); } }
    let go = tr.k === 'time' ? S.R.t >= tr.t : tr.k === 'delay' ? T.since >= tr.t : tr.k === 'event' ? !!(EV[tr.e] && EV[tr.e]()) : tr.k === 'cond' ? !!(COND[tr.c] && COND[tr.c](tr.v)) : true;
    if (!go && st.forceAfter != null && T.since >= st.forceAfter && !T.forced) { T.forced = true; if (st.force && FORCE[st.force.k]) FORCE[st.force.k](st.force); else go = !st.force; T.log.push('force:' + st.id); }
    if (!go && T.since >= (st.forceAfter != null ? st.forceAfter + 20 : 1e9)) go = true;   // safety: never stall the script
    if (go) showStep(st);
  }
  function unitPoint(p) {
    const list = p.at ? [p.at] : state.units.filter(u => !u.dead && u.type === p.unit && (!p.team || u.team === p.team) && (!p.hit || u.workerState === 'FLEEING'));
    const u = list.sort((a, b) => a.y - b.y)[0] || state.units.find(u => !u.dead && u.type === p.unit); if (!u) return null;
    const c = document.getElementById('gameCanvas'), rc = c.getBoundingClientRect(), s = rc.width / WORLD_W;
    const vh = rc.height / s; state.targetCameraY = state.cameraY = Math.max(0, Math.min(WORLD_H - vh, (isFlipped() ? WORLD_H - u.y : u.y) - vh / 2)); try { render(); } catch (e) {}
    const wx = isFlipped() ? WORLD_W - u.x : u.x, wy = isFlipped() ? WORLD_H - u.y : u.y;
    const x = rc.left + wx * s, y = rc.top + (wy - state.cameraY) * s; return { left: x - 28, top: y - 28, width: 56, height: 56 };
  }
  function showStep(st) {
    const T = S.T; T.box = true;
    const prevSpeed = state.timeSpeed;
    if (st.pause === 'slow') state.timeSpeed = 0.25; else if (st.pause !== false) state.paused = true;
    T.log.push(st.id);
    let r = null;
    if (typeof st.point === 'string') { const e = document.querySelector(st.point); if (e) r = e.getBoundingClientRect(); }
    else if (st.point && st.point.unit) r = unitPoint(st.point);
    else if (st.point && st.point.pad) { const pd = state.turretPads.find(p => p.team === st.point.pad); if (pd) r = unitPoint({ at: pd }); }
    else if (st.point && st.point.node) { const e = $('node-' + st.point.node.toLowerCase()); if (e) r = e.getBoundingClientRect(); }
    let vo = null;   // voice hook: Cut's <lineId>.m4a in assets/vo/, enabled per id via Story.TUT_VO[lineId] = true (or 'file.m4a')
    if (st.voiced && TUT_VO[st.line] && !S.voMuted()) { try { vo = new Audio('assets/vo/' + (typeof TUT_VO[st.line] === 'string' ? TUT_VO[st.line] : st.line + '.m4a')); vo.play().catch(() => {}); } catch (e) {} }
    tipBox(st.speaker || 'Garrow', line(st.line), r, st.id, () => { if (vo) vo.pause();
      if (st.pause === 'slow') state.timeSpeed = prevSpeed; else if (st.pause !== false) state.paused = false;
      T.box = false; T.i++; T.since = 0; T.forced = false;
    });
  }
  // dialogue/tip box under the safe area; ring + dim around the pointed element; tap anywhere to resume
  function tipBox(who, text, r, id, done) {
    let el = $('rb-tut'); if (!el) { el = document.createElement('div'); el.id = 'rb-tut'; el.className = 'fixed inset-0 z-[75]'; document.body.appendChild(el); }
    const ring = r ? `<div id="rb-tut-ring" class="absolute rounded-xl border-4 border-amber-300 pointer-events-none" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;box-shadow:0 0 0 9999px rgba(0,0,0,.5);animation:rbtut 1s ease-in-out infinite"></div>
      <div class="absolute pointer-events-none text-3xl" style="left:${r.left + r.width / 2 - 12}px;top:${r.top + r.height + 6}px;animation:rbtut 1s infinite">\u261D\uFE0F</div>` : '<div class="absolute inset-0 bg-black/45"></div>';
    const low = r && r.top < window.innerHeight * 0.45;
    el.innerHTML = ring + `<div data-tut="${esc(id)}" class="absolute left-1/2 -translate-x-1/2 w-[92%] max-w-sm flex gap-2 items-start bg-white text-slate-900 rounded-2xl border-[3px] border-slate-900 shadow-2xl p-2" style="${low ? 'bottom:calc(var(--sab, 0px) + 150px)' : 'top:calc(var(--sat, 0px) + 64px)'}">
      <div class="shrink-0 flex flex-col items-center">${portraitHtml(who, 52)}<div class="mt-0.5 px-1.5 rounded bg-amber-400 text-[9px] font-black uppercase">${esc(who)}</div></div>
      <div class="flex-1 text-[13px] font-bold leading-snug">${esc(text)}<div class="text-right text-[10px] text-slate-500 font-black mt-1">tap to continue \u25B6</div></div></div>
      <style>@keyframes rbtut{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}</style>`;
    el.classList.remove('hidden');
    setTimeout(() => { el.onclick = e => { e.stopPropagation(); el.onclick = null; el.classList.add('hidden'); el.innerHTML = ''; done(); }; }, 250);
  }
  // first-time tips: one line the first time each unit type shows up on the field; stored in SAVE.seen ('tip:type')
  const TIP_TYPES = ['pawn', 'archer', 'wizard', 'brute', 'worker', 'cavalier'];
  function firstTips() {
    const T = S.T; if ((T.tipT = (T.tipT || 0) - 1) > 0) return; T.tipT = 20;
    let k = null;
    for (const t of TIP_TYPES) if (!SAVE.seen.includes('tip:' + t) && state.units.some(u => !u.dead && u.type === t && !u.story)) { k = t; break; }
    if (!k && !SAVE.seen.includes('tip:turret') && state.turretPads.some(p => p.turret && !p.turret.dead)) k = 'turret';
    if (!k) return;
    SAVE.seen.push('tip:' + k); persist(); (T.tips = T.tips || []).push(k);
    let el = $('rb-tip'); if (!el) { el = document.createElement('div'); el.id = 'rb-tip'; el.className = 'fixed left-1/2 -translate-x-1/2 z-[61] pointer-events-none w-[86%] max-w-sm'; el.style.top = 'calc(var(--sat, 0px) + 168px)'; document.body.appendChild(el); }
    el.innerHTML = `<div class="rounded-xl bg-slate-900/90 border border-amber-400 text-amber-100 text-[12px] font-bold px-3 py-1.5 text-center shadow-xl">\u{1F4A1} ${esc(line('tip_' + k))}</div>`;
    el.classList.remove('hidden'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }
  S.tutStart = tutStart; S.tutTick = tutTick;
  S.tutStop = () => { const T = S.T; if (T && T.box) { state.paused = false; } ['rb-tut', 'rb-tip'].forEach(i => { const e = $(i); if (e) { e.classList.add('hidden'); e.innerHTML = ''; } }); S.lastT = T; S.T = null; };

  // ---- Field Guide + Mission guide (Options and the in-match menu)
  const GUIDE = [
    ['Units', [['\u{1F5E1}', 'Pawn', 'fg_pawn'], ['\u{1F3F9}', 'Archer', 'fg_archer'], ['\u{1F52E}', 'Wizard', 'fg_wizard'], ['\u{1F4AA}', 'Brute', 'fg_brute'], ['\u26CF', 'Worker', 'fg_worker'], ['\u{1F40E}', 'Hero', 'fg_hero']]],
    ['Combo pairs', [['\u{1F5E1}+\u{1F3F9}', 'Pawn + Archer', 'fg_combo_pawn_archer'], ['\u{1F52E}+\u{1F4AA}', 'Wizard + Brute', 'fg_combo_wizard_brute']]],
    ['Turrets', [['\u{1F3F0}', 'Turret', 'fg_turret']]],
    ['Tug-of-war bar', [['\u2195', 'The bar', 'fg_bar'], ['\u2022', 'Bar symbols', 'fg_bar_symbols']]],
    ['Controls', [['2x', 'Game speed', 'fg_ctl_speed'], ['\u2630', 'Menu / pause', 'fg_ctl_menu'], ['\u{1F3A5}', 'Camera Far / Mid / Home', 'fg_ctl_camera'], ['\u26CF', 'Mine zones', 'fg_ctl_zones'], ['\u00D7N', 'Batching', 'fg_ctl_batch']]]
  ];
  S.GUIDE = GUIDE;
  function overlay(id, title, html) {
    let el = $(id); if (!el) { el = document.createElement('div'); el.id = id; el.className = 'fixed inset-0 z-[90] bg-black/90 flex flex-col items-center p-4 overflow-y-auto'; document.body.appendChild(el); }
    el.style.paddingTop = 'calc(var(--sat, 0px) + 16px)'; el.style.paddingBottom = 'calc(var(--sab, 0px) + 16px)';
    el.innerHTML = `<div class="w-full max-w-sm"><h2 class="text-xl font-black text-amber-300 uppercase tracking-wider text-center mb-2">${title}</h2>${html}
      <button data-close class="w-full mt-3 py-3 rounded-xl bg-amber-500 text-slate-950 font-black text-sm uppercase">Close</button></div>`;
    el.classList.remove('hidden'); el.querySelector('[data-close]').onclick = () => el.classList.add('hidden');
    return el;
  }
  S.openGuide = () => overlay('rb-guide', '\u{1F4D6} Field Guide', GUIDE.map(([h, rows]) => `<div class="text-[11px] font-black text-slate-300 uppercase mt-2 mb-1">${h}</div>` + rows.map(([ic, nm, lid]) =>
    `<div data-line="${lid}" class="flex gap-2 items-start rounded-lg bg-slate-800/90 border border-slate-700 p-2 mb-1"><div class="w-9 shrink-0 text-center text-lg">${ic}</div><div class="text-[12px] text-slate-100 leading-snug"><b class="text-amber-200">${nm}</b><br>${esc(line(lid))}</div></div>`).join('')).join(''));
  S.openMissionGuide = () => {
    const m = S.m; if (!m) return;
    const g = m.guide || {}, goal = g.goal ? line(g.goal) : m.brief, hints = g.hints ? g.hints.map(line) : (m.tips || []);
    overlay('rb-mguide', '\u{1F3AF} Mission guide', `<div class="rounded-xl bg-slate-800/90 border border-slate-700 p-3 text-left"><div class="text-amber-200 font-black text-sm">${esc(m.name)}</div>
      <div class="text-[12px] text-slate-100 mt-1">${esc(goal)}</div>${hints.length ? '<ul class="mt-2 text-[11px] text-slate-300 list-disc pl-4">' + hints.map(h => `<li>${esc(h)}</li>`).join('') + '</ul>' : ''}
      <div class="text-[10px] text-slate-400 mt-2">Stars: ${m.stars.map(esc).join(' \u00B7 ')}</div></div>`);
  };
  S.menuExtras = () => `<div class="grid grid-cols-2 gap-2"><button id="pm-guide" class="w-full py-3 rounded-xl font-black text-xs uppercase bg-slate-800 text-slate-100 active:scale-95">\u{1F4D6} Field Guide</button>` +
    (S.active && S.m ? `<button id="pm-mission" class="w-full py-3 rounded-xl font-black text-xs uppercase bg-slate-800 text-slate-100 active:scale-95">\u{1F3AF} Mission guide</button>` : '') + '</div>';
  S.bindMenu = () => { const a = $('pm-guide'), b = $('pm-mission'); if (a) a.onclick = S.openGuide; if (b) b.onclick = S.openMissionGuide; };
  function injectTutOptions() {
    const done = $('settings-done'); if (!done || $('set-tut-row')) return;
    const row = document.createElement('div'); row.id = 'set-tut-row'; row.className = 'w-full max-w-xs mt-3 grid grid-cols-2 gap-2 shrink-0';
    row.innerHTML = `<button id="set-tut" class="py-3 rounded-xl border-2 border-slate-600 font-black text-[11px] uppercase text-slate-100"></button><button id="set-guide" class="py-3 rounded-xl bg-slate-700 font-black text-[11px] uppercase text-slate-100">\u{1F4D6} Field Guide</button>
      <p class="col-span-2 text-[10px] text-slate-400 leading-snug">Tutorial tips: staged lessons in Act 1 and first-time unit tips. Replays of missions you already won always skip the lessons.</p>`;
    done.before(row);
    const paint = () => { const b = $('set-tut'), on = tipsOn(); b.textContent = 'Tutorial tips: ' + (on ? 'On' : 'Off'); b.classList.toggle('bg-amber-500', on); b.classList.toggle('text-slate-950', on); b.classList.toggle('bg-slate-900', !on); };
    $('set-tut').onclick = () => { S.setTips(!tipsOn()); paint(); }; $('set-guide').onclick = S.openGuide; paint();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(injectTutOptions, 50)); else setTimeout(injectTutOptions, 50);
  S.save = () => SAVE; S.setDiff = d => { SAVE.diff = d; persist(); }; S.missions = M; S.regions = REGIONS; S.regionColor = regionColor; S.exportSave = exportSave; S.importSave = importSave;
  S.reset = () => { SAVE = freshSave(); persist(); };
  S.setSave = o => { SAVE = migrate(o); persist(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI); else injectUI();
})();
