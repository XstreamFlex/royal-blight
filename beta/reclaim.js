// Evermarch v39.0 — RECLAMATION mode: 4 pirate forts, army-draft auto-battle, breach stats, unit abilities.
// Self-contained; talks to story.js only through Story.save()/Story.persist(). Assets lazy-load (not precached).
(function () {
  'use strict';
  const A = 'assets/reclamation/', $ = id => document.getElementById(id);
  const RC = window.Reclaim = { dev: false };
  try { if (/[?&]rcdev=1/.test(location.search)) localStorage.setItem('evermarch.rcdev', '1'); RC.dev = localStorage.getItem('evermarch.rcdev') === '1'; } catch (e) {}
  const SV = () => window.Story && Story.save(), rc = () => SV().rc, save = () => Story.persist();
  const unlocked = () => RC.dev || !!(SV() && SV().missions.M07 && SV().missions.M07.wins);
  const IC = n => '<img src="assets/reclamation/icons/' + n + '.webp" alt="" style="display:inline-block;width:1.25em;height:1.25em;vertical-align:-0.25em">';   // v39.4 Cut's icons replace the emoji placeholders
  const RES_ICON = { grain: IC('icon_res_grain'), wood: IC('icon_res_wood'), metal: IC('icon_res_metal'), gold: IC('icon_res_gold') };
  const resTxt = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${RES_ICON[k]}${v}`).join(' ');

  // ---------------------------------------------------------------- DATA
  const POOLS = {   // base stats from the game's UNIT_STATS (design doc §3)
    inf:    { name: 'Infantry', cost: 1,   cap: 30, hp: 140, atk: 18, rng: 22, spd: 40, r: 9,  melee: true,  me: 'knight_blue_back.png', foe: 'pirate_deckhand_front.webp' },
    archer: { name: 'Archers',  cost: 1.5, cap: 20, hp: 90,  atk: 22, rng: 140, spd: 34, r: 9, melee: false, me: 'archer_blue_back.png', foe: 'pirate_crossbow_front.webp' },
    brute:  { name: 'Brutes',   cost: 4,   cap: 5,  hp: 500, atk: 28, rng: 26, spd: 28, r: 14, melee: true,  mres: 0.7, me: 'brute_blue_back.png', foe: 'pirate_brute_front.webp' },
    wiz:    { name: 'Wizards',  cost: 6,   cap: 1,  hp: 175, atk: 38, rng: 120, spd: 30, r: 10, melee: false, magic: true, splash: 45, meleeX: 2, me: 'wizard_blue_back.png', foe: 'pirate_seawitch_front.webp' },
  };
  const CAP_UP = { inf: 10, archer: 7, brute: 2, wiz: 1 };
  const BEATS = { brute: 'inf', archer: 'brute', wiz: 'archer' };   // ×1.5 (blitzing infantry > wizards handled in-sim)
  const ABIL = {
    rain:    { name: 'Rain',    icon: IC('icon_abil_rain'), unit: 'archer', cd: 12, desc: 'Archers rain arrows on their front line for 3 s.' },
    turtle:  { name: 'Turtle',  icon: IC('icon_abil_turtle'), unit: 'brute', cd: 15, desc: 'Brutes lock shields: no damage taken, no attacks, 3 s.' },
    blitz:   { name: 'Blitz',   icon: IC('icon_abil_blitz'), unit: 'inf', cd: 18, desc: 'Infantry charge their back row. They take double damage while charging.' },
    repel:   { name: 'Repel',   icon: IC('icon_abil_repel'), unit: 'wiz', cd: 14, desc: 'Wizards blast nearby foes back and burn them.' },
    barrier: { name: 'Barrier', icon: IC('icon_abil_barrier'), unit: 'wiz', cd: 25, desc: 'A bubble on every ally worth 10% of their HP. Lasts until broken.' },
  };
  const FORTS = {
    1: { name: 'Farm Stockade', where: 'Eastmarch farms', bg: 'bg/bg_reclaim_fort1.webp', g: { inf: 8, archer: 4 }, sc: 0.9, hp: 1600, towers: 0, dem: {}, budget: 40,
         pay: { grain: 40, gold: 60 }, teach: [], unlockAb: ['rain'], perk: ['gold5', '+5% gold from story missions'], note: 1,
         noteText: "Found in the pirate captain's chest... a ledger. Grain, taken from the Eastmarch stores every season for six years. No wonder Felix could never meet the tithe. And every page was paid in coins no kingdom of the realm has ever minted." },
    2: { name: 'Road Gatehouse', where: 'Eastmarch road', bg: 'bg/bg_reclaim_fort2.webp', g: { inf: 12, archer: 6, brute: 2 }, sc: 1.0, hp: 2200, towers: 0, dem: { ram: 1 }, budget: 50,
         pay: { grain: 70, wood: 40, gold: 90 }, teach: ['rain'], unlockAb: ['turtle'], perk: ['banner', 'Eastmarch banner flies over your camp'], note: 2,
         noteText: 'A letter, sealed in black wax and silver. Just one line. Take the grain... and leave the king his shame. No name. No crest anyone in the realm has ever seen.' },
    3: { name: 'Ridge Watch', where: 'Eastmarch ridge', bg: 'bg/bg_reclaim_fort3.webp', g: { inf: 14, archer: 9, brute: 4, wiz: 1 }, sc: 1.1, hp: 3000, towers: 2, dem: { ram: 1, siege: 1 }, budget: 60,
         pay: { grain: 100, wood: 70, gold: 120 }, teach: ['turtle'], unlockAb: ['blitz', 'repel', 'barrier'], perk: ['cd10', '-10% ability recharge in Reclamation'], note: 3,
         noteText: "Sketched in the margin of the captain's map, a tall, slender figure with long, pointed ears. Beneath it, two words. Our patron. Not even the scholars have a name for such a people." },
    4: { name: "Captain's Wharf", where: 'Eastmarch coast', bg: 'bg/bg_reclaim_fort4.webp', g: { inf: 20, archer: 12, brute: 5, wiz: 2 }, sc: 1.0, hp: 4500, towers: 2, barrier: true,
         dem: { ram: 2, siege: 1, arcane: 1, army: 45 }, budget: 90, pay: { grain: 180, wood: 120, metal: 60, gold: 250 }, teach: ['blitz', 'repel', 'barrier'], unlockAb: [], perk: ['draft10', '+10 draft points in Reclamation'], note: 4,
         noteText: '[PLACEHOLDER, Cut to write + voice] The captain\u2019s cabin is stripped bare. Only a silver seal remains, pressed into black wax.' },
  };
  // v39.6 siege layer: battle length, star par, march supplies, reinforcement waves, courtyard + keep garrisons, captain, fort counter-abilities, weak/strong
  const RCX = {
    1: { time: 150, par: 110, supply: { grain: 15 }, wave: { every: 30, g: { inf: 3 } }, court: { inf: 5, archer: 3 }, keep: { cap: { k: 'brute', hp: 900, atk: 30 }, g: { inf: 3 } },
         fa: [['volley', 26]], vol: 14, bomb: 0, mod: { brute: 1.25, inf: 0.85 }, weak: 'Brutes: deckhands scatter (+25%)', strong: 'Infantry: crossbows behind palisades (-15%)' },
    2: { time: 180, par: 135, supply: { grain: 25, gold: 20 }, wave: { every: 28, g: { inf: 3, archer: 1 } }, court: { inf: 6, archer: 4, brute: 1 }, keep: { cap: { k: 'brute', hp: 1400, atk: 34 }, g: { inf: 3, brute: 1 } },
         fa: [['volley', 24], ['charge', 32]], vol: 16, bomb: 0, mod: { archer: 1.25, brute: 0.85 }, weak: 'Archers: gate brutes have no cover (+25%)', strong: 'Brutes: the gate guards brace (-15%)' },
    3: { time: 210, par: 160, supply: { grain: 35, wood: 20 }, wave: { every: 26, g: { inf: 3, archer: 2 } }, court: { inf: 7, archer: 5, brute: 2 }, keep: { cap: { k: 'wiz', hp: 1300, atk: 42 }, g: { archer: 3, brute: 1 } },
         fa: [['volley', 22], ['bombard', 28]], vol: 18, bomb: 70, mod: { inf: 1.25, archer: 0.85 }, weak: 'Infantry: crossbows on the ridge break if rushed (+25%)', strong: 'Archers: high ground covers them (-15%)' },
    4: { time: 240, par: 185, supply: { grain: 50, wood: 30, metal: 15 }, wave: { every: 24, g: { inf: 4, archer: 2, brute: 1 } }, court: { inf: 9, archer: 5, brute: 2, wiz: 1 }, keep: { cap: { k: 'brute', hp: 2400, atk: 44 }, g: { inf: 4, brute: 2, wiz: 1 } },
         fa: [['volley', 22], ['charge', 30], ['ward', 36]], vol: 18, bomb: 0, mod: { wiz: 1.25, brute: 0.85 }, weak: 'Wizards: the wharf is packed tight (+25%)', strong: 'Brutes: the captain\u2019s guard is drilled (-15%)' },
  };
  const ABIL_CHG = { rain: 3, turtle: 3, blitz: 2, repel: 3, barrier: 2 };
  Object.entries(ABIL_CHG).forEach(([k, n]) => ABIL[k].chg = n);
  [1, 2, 3, 4].forEach(n => { const P = FORTS[n].pay; for (const k in P) P[k] = Math.round(P[k] * 2); });
  const BR = {   // breach costs (doc §7)
    ram:    { name: 'Ram',    icon: '\u{1FAB5}', what: 'Breaks gates', cost: [{ grain: 60 }, { grain: 100 }, { grain: 170 }] },
    siege:  { name: 'Siege',  icon: '\u{1F3F0}', what: 'Silences towers', cost: [{ grain: 40, wood: 40 }, { grain: 70, wood: 70 }, { grain: 120, wood: 120 }] },
    arcane: { name: 'Arcane', icon: '\u2728', what: 'Pierces barriers', cost: [{ wood: 60, gold: 100 }, { wood: 100, gold: 200 }, { wood: 170, gold: 350 }] },
    army:   { name: 'Army',   icon: '\u{1F465}', what: '+10 army size (from 40)', cost: [{ grain: 40 }, { grain: 70 }, { grain: 120 }] },
  };
  const UPS = {   // Reclamation upgrades (replace the cut Support Team)
    caps: { name: 'Pool caps', what: '+10 inf, +7 archers, +2 brutes, +1 wizard', cost: [{ grain: 50, gold: 50 }, { grain: 90, gold: 100 }, { grain: 150, gold: 200 }] },
    hp:   { name: 'Unit HP',   what: '+10% HP per tier', cost: [{ grain: 60, gold: 75 }, { grain: 100, gold: 150 }, { grain: 170, gold: 250 }] },
    atk:  { name: 'Unit attack', what: '+10% attack per tier', cost: [{ grain: 60, gold: 75 }, { grain: 100, gold: 150 }, { grain: 170, gold: 250 }] },
    cd:   { name: 'Ability recharge', what: '-10% recharge per tier', cost: [{ wood: 40, gold: 100 }, { wood: 70, gold: 200 }, { wood: 120, gold: 300 }] },
  };
  const have = k => k === 'gold' ? SV().gold : rc().res[k];
  const canPay = c => Object.entries(c).every(([k, v]) => have(k) >= v);
  const pay = c => { for (const [k, v] of Object.entries(c)) { if (k === 'gold') SV().gold -= v; else rc().res[k] -= v; } };
  const give = c => { for (const [k, v] of Object.entries(c)) { if (k === 'gold') SV().gold += v; else rc().res[k] += v; } };
  const armyCap = () => 40 + 10 * rc().br.army;
  const poolCap = k => k === 'wiz' && !wizOpen() ? 0 : Math.max(0, POOLS[k].cap + CAP_UP[k] * rc().up.caps - ((rc().wounded || {})[k] || 0));
  const wizOpen = () => cleared(3) || RC._fort === 4;
  const cleared = n => !!(rc().forts[n] && rc().forts[n].clears);
  const fortOpen = n => n === 1 || cleared(n - 1);
  const budgetOf = f => FORTS[f].budget + (rc().perks.includes('draft10') ? 10 : 0);
  function missing(f, total) {
    const d = FORTS[f].dem, b = rc().br, o = {};
    for (const k of ['ram', 'siege', 'arcane']) if (d[k]) o[k] = Math.max(0, d[k] - b[k]);
    if (d.army) o.army = Math.max(0, Math.ceil((d.army - total) / 10));
    return o;
  }
  const missSum = m => Object.values(m).reduce((a, b) => a + b, 0);

  // ---------------------------------------------------------------- UI shell
  let root;
  function shell(html) {
    if (!root) { root = document.createElement('div'); root.id = 'rc-root'; document.body.appendChild(root); }
    root.className = 'fixed inset-0 z-[90] bg-slate-950 text-slate-100 flex flex-col overflow-hidden select-none';
    root.style.paddingTop = 'var(--sat, env(safe-area-inset-top))'; root.style.fontFamily = 'inherit';
    root.innerHTML = html; root.classList.remove('hidden');
    const x = root.querySelector('[data-close]'); if (x) x.onclick = close;
    return root;
  }
  function close() { stopBattle(); if (root) { root.classList.add('hidden'); root.innerHTML = ''; } }
  const resBar = () => `<div class="flex gap-2 text-[11px] font-black">${['grain', 'wood', 'metal', 'gold'].map(k => `<span>${RES_ICON[k]}${have(k)}</span>`).join('')}</div>`;
  const top = (title, back) => `<div class="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-700">
    <button ${back ? 'data-back' : 'data-close'} class="px-2 py-1 rounded bg-slate-700 text-xs font-black">${back ? '\u2190' : '\u2715'}</button>
    <div class="text-sm font-black uppercase tracking-wider text-amber-300">${title}</div>${resBar()}</div>`;

  // ---------------------------------------------------------------- GUIDES (prologue standard: announce, pause, explain, prompt, every control)
  let guideQ = null; const waiters = {};
  RC.ev = name => { const w = waiters[name]; if (w) { delete waiters[name]; w(); } };
  function guide(steps) {
    return new Promise(res => {
      let i = 0; const ov = document.createElement('div'); ov.id = 'rc-guide'; ov.className = 'fixed inset-0 z-[95] pointer-events-none';
      root.appendChild(ov); guideQ = ov; RC.paused = true;
      const end = () => { ov.remove(); guideQ = null; RC.paused = false; document.querySelectorAll('.rc-hl').forEach(e => e.classList.remove('rc-hl')); res(); };
      const next = () => {
        document.querySelectorAll('.rc-hl').forEach(e => e.classList.remove('rc-hl'));
        if (i >= steps.length) return end(); const s = steps[i++];
        if (s.announce) {
          ov.className = 'fixed inset-0 z-[95] flex items-center justify-center bg-black/50 pointer-events-auto';
          ov.innerHTML = `<div class="rc-ann text-center"><div class="text-[11px] font-black tracking-[0.3em] text-amber-200">NEW</div><div class="text-3xl font-black text-amber-300 drop-shadow">${s.announce}</div></div>`;
          ov.onclick = null; setTimeout(next, 1100); return;   // brief pause, like the prologue's event beats
        }
        const wait = s.wait; RC.paused = !wait || s.pause !== false;
        if (s.hl) { const el = root.querySelector(s.hl); if (el) el.classList.add('rc-hl'); }
        ov.className = 'fixed inset-0 z-[95] flex items-end ' + (wait ? 'pointer-events-none' : 'pointer-events-auto bg-black/30');
        ov.innerHTML = `<div class="m-2 mb-24 w-full flex items-end gap-2 pointer-events-auto" id="rc-bub"><div class="text-center shrink-0"><img src="assets/portraits/${(s.sp || 'garrow').toLowerCase()}.webp" class="w-14 h-14 rounded-xl border-2 border-amber-400 bg-slate-800 object-cover"><div class="text-[9px] font-black bg-amber-400 text-slate-900 rounded px-1 mt-0.5 uppercase">${s.sp || 'Garrow'}</div></div>
          <div class="flex-1 bg-white text-slate-900 rounded-2xl rounded-bl-none p-3 text-[13px] font-bold leading-snug shadow-xl">${s.say}${wait ? '<div class="text-[10px] text-amber-600 font-black mt-1">\u{1F449} ' + (s.cta || 'Your move') + '</div>' : '<div class="text-[10px] text-slate-400 text-right mt-1">tap \u25B6</div>'}</div></div>`;
        if (wait) { ov.onclick = null; waiters[wait] = next; } else ov.onclick = next;
      };
      next();
    });
  }
  const G = { // two new things per fort (forts 1-3); fort 4 = full suite + the remaining abilities
    1: { draft: [
        { announce: 'THE DRAFT' }, { say: "No mines out here, Majesty. No turrets either. You get a budget of points, and that's your whole army." },
        { say: 'Spin a wheel to pick how many of each. Or tap the little + and \u2212. Go on, add some archers.', wait: 'draft-change', hl: '[data-pool="archer"]', cta: 'Spin or tap + on Archers' },
        { say: 'Points left are up top. Spend them all. Unspent points never swung a sword.' },
        { announce: 'COUNTERS' }, { say: 'Brutes flatten infantry. Archers shred brutes. Wizards scorch archer clumps. And infantry who charge will catch a wizard.' },
        { say: "The scouting card says what's in the fort. This one's deckhands and crossbows. Pick what beats them, then tap MARCH.", wait: 'march', hl: '#rc-march', cta: 'Tap MARCH' }],
      battle: [{ say: "From here they fight on their own. Break the wall, then the courtyard, then their captain in the keep." },
        { say: "When a red warning flashes, the fort is about to fire a volley. Lose too many and they're wounded for the next march. Retreat, top left, saves the survivors." }] },
    2: { draft: [
        { announce: 'BREACH POWER' }, { say: "See that gate? Pirates wall up every fort they steal. Gates need Ram. Towers need Siege. Barriers need Arcane. Big garrisons need Army." },
        { say: "Red on the scouting card means you're short. A fort you can't breach stays fortified: it barely scratches, and it hits back." },
        { say: 'Buy breach levels at camp with grain, wood and gold. Grain comes from Eastmarch missions, wood from Westreach, metal from Northcrag.' }],
      battle: [{ announce: 'RAIN' }, { say: 'Your archers have a new trick. One volley, straight onto their front line, three seconds of arrows.' },
        { say: 'Tap RAIN now, while they bunch up.', wait: 'abil-rain', hl: '[data-ab="rain"]', cta: 'Tap RAIN' },
        { say: 'Good. It recharges, but you only get three a battle. The number on the button is what you have left.' },
        { say: "This gate's crew charge when their horn sounds. Save something for the captain at the keep." }] },
    3: { draft: [
        { announce: 'SCOUTING' }, { say: 'Read the card before you pick. Tap any line on it to hear what it means.', wait: 'scout-tap', hl: '#rc-scout', cta: 'Tap a line on the scouting card' },
        { say: "Two towers on this ridge, and a sea-witch in the yard. Bring Siege, or those towers pick you apart. Archers will want to spread out." }],
      battle: [{ announce: 'TURTLE' }, { say: 'Brutes can lock shields. Three seconds of no damage at all. But they stop swinging while they do it.' },
        { say: 'Arrows incoming. Tap TURTLE.', wait: 'abil-turtle', hl: '[data-ab="turtle"]', cta: 'Tap TURTLE' },
        { say: "Time it to the red warning. Turtle at the wrong moment and you've just stood there." },
        { say: 'Their cannon bombards in threes. Fast clears earn a third star, and stars pay more.' }] },
    4: { draft: [
        { announce: 'WIZARDS JOIN' }, { say: 'The scholars sent us a wizard. Deadly from range, made of paper up close. Every demand is on the card. Meet them all, or this wharf eats you.' }],
      battle: [{ announce: 'BLITZ' }, { say: "Infantry can charge straight for their back row. They take double damage on the way, so pick the moment." },
        { say: 'Tap BLITZ. Go for the sea-witches.', wait: 'abil-blitz', hl: '[data-ab="blitz"]', cta: 'Tap BLITZ' },
        { announce: 'REPEL' }, { say: 'Your wizards can blast anyone too close. It knocks them back and burns.' },
        { say: 'Tap REPEL.', wait: 'abil-repel', hl: '[data-ab="repel"]', cta: 'Tap REPEL' },
        { announce: 'MAGIC BARRIER' }, { say: 'And a bubble on every ally. It holds until something breaks it.' },
        { say: 'Tap BARRIER. Then use everything. This is the whole kit.', wait: 'abil-barrier', hl: '[data-ab="barrier"]', cta: 'Tap BARRIER' }] },
  };
  const guided = (f, part) => rc().seen.includes(`g${f}${part}`);
  const markGuided = (f, part) => { if (!guided(f, part)) { rc().seen.push(`g${f}${part}`); save(); } };

  // ---------------------------------------------------------------- MAP (fort select) + CAMP (breach + upgrades)
  // v39.5 Reclamation lives on the story map: forts + camp are map nodes (Story.openMap calls RC.mapNodes / RC.bindMap)
  RC.open = function () { close(); if (window.Story && Story.openMap) Story.openMap(); };
  const MAP_POS = { 1: [76, 64], 2: [68, 44], 3: [90, 36], 4: [92, 72] }, CAMP_POS = [72, 80];
  RC.mapNodes = function () {
    const on = unlocked(), all = [1, 2, 3, 4].every(cleared);
    const fort = n => { const f = FORTS[n], ok = on && fortOpen(n), done = cleared(n);
      const ring = all ? '#fbbf24' : done ? '#3b82f6' : ok ? '#e11d48' : '#64748b';
      const glow = all ? 'filter:drop-shadow(0 0 4px #fbbf24) drop-shadow(0 0 2px #fde68a)' : done ? 'filter:hue-rotate(190deg) saturate(1.3) drop-shadow(0 2px 3px #000a)' : 'filter:drop-shadow(0 2px 3px #000a)';
      return `<button data-rcfort="${n}" ${ok ? '' : 'disabled'} class="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center ${ok ? '' : 'opacity-50 grayscale'}" style="left:${MAP_POS[n][0]}%;top:${MAP_POS[n][1]}%;z-index:2">
        <div class="rounded-lg flex items-center justify-center" style="width:34px;height:34px;background:#0f172acc;border:2px solid ${ring};${all ? 'box-shadow:0 0 8px #fbbf24' : ''}"><img src="${A}props/${done ? 'prop_fort_breached' : 'prop_fort_fortified'}.webp" style="width:30px;height:30px;object-fit:contain;${glow}">${done ? '' : `<img src="${A}icon_pirate_flag.webp" style="position:absolute;width:12px;height:12px;right:-4px;top:-4px">`}</div>
        <div class="mt-0.5 px-1 rounded bg-black/70 text-[8px] font-black leading-tight" style="color:${all ? '#fde68a' : done ? '#93c5fd' : '#fecdd3'}">${f.name}${done ? ' \u2714' : ok ? '' : ' \u{1F512}'}</div></button>`; };
    return [1, 2, 3, 4].map(fort).join('') + `<button data-rccamp ${on ? '' : 'disabled'} class="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center ${on ? '' : 'opacity-50 grayscale'}" style="left:${CAMP_POS[0]}%;top:${CAMP_POS[1]}%;z-index:2">
      <div class="rounded-lg flex items-center justify-center text-base" style="width:30px;height:30px;background:#0f172acc;border:2px solid ${all ? '#fbbf24' : '#f59e0b'}">\u26FA</div>
      <div class="mt-0.5 px-1 rounded bg-black/70 text-[8px] font-black text-amber-200 leading-tight">${on ? 'Camp ' + ['grain', 'wood', 'metal', 'gold'].map(k => RES_ICON[k].replace('1.25em', '0.9em').replace('1.25em', '0.9em') + (have(k) || 0)).join('') : 'Reclamation \u{1F512} M07'}</div></button>`;
  };
  RC.bindMap = function (map) {
    map.querySelectorAll('[data-rcfort]').forEach(b => b.onclick = e => { e.stopPropagation(); scout(+b.dataset.rcfort); });
    const c = map.querySelector('[data-rccamp]'); if (c) c.onclick = e => { e.stopPropagation(); camp(RC.open); };
  };
  function camp(back) {
    const row = (grp, k, def, lvl) => { const c = def.cost[lvl]; return `<div class="flex items-center gap-2 bg-slate-800 rounded-lg p-2 mb-1.5">
      <div class="flex-1"><div class="text-xs font-black">${def.icon || ''} ${def.name} <span class="text-amber-300">${lvl}/3</span></div><div class="text-[10px] text-slate-400">${def.what}</div></div>
      ${c ? `<button data-buy="${grp}:${k}" ${canPay(c) ? '' : 'disabled'} class="px-2 py-1.5 rounded-lg text-[11px] font-black ${canPay(c) ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700 text-slate-500'}">${resTxt(c)}</button>` : '<span class="text-[10px] font-black text-emerald-300">MAX</span>'}</div>`; };
    shell(`${top('Camp', true)}<div class="flex-1 overflow-y-auto p-3">
      <div class="text-[11px] font-black text-amber-300 uppercase mb-1">Breach power</div>${Object.entries(BR).map(([k, d]) => row('br', k, d, rc().br[k])).join('')}
      ${(() => { const W = rc().wounded || {}, n = Object.values(W).reduce((x, v) => x + v, 0), c = { grain: 3 * n }; return n ? `<div class="flex items-center gap-2 bg-rose-950/60 rounded-lg p-2 mt-2"><div class="flex-1 text-xs font-black">\u{1FA79} Wounded: ${Object.entries(W).filter(([, v]) => v).map(([k, v]) => v + ' ' + POOLS[k].name).join(', ')}<div class="text-[10px] text-slate-400 font-normal">Out of your draft pools until tended.</div></div><button data-heal ${canPay(c) ? '' : 'disabled'} class="px-2 py-1.5 rounded-lg text-[11px] font-black ${canPay(c) ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700 text-slate-500'}">Tend ${resTxt(c)}</button></div>` : ''; })()}
      <div class="text-[11px] font-black text-amber-300 uppercase mt-3 mb-1">Reclamation upgrades</div>${Object.entries(UPS).map(([k, d]) => row('up', k, d, rc().up[k])).join('')}
      <div class="text-[11px] font-black text-amber-300 uppercase mt-3 mb-1">Abilities</div><div class="grid grid-cols-5 gap-1">${Object.entries(ABIL).map(([k, a]) => `<div class="text-center rounded-lg p-1 ${rc().abil.includes(k) ? 'bg-slate-700' : 'bg-slate-900 opacity-40'}"><div class="text-xl">${a.icon}</div><div class="text-[9px] font-black">${a.name}</div></div>`).join('')}</div>
      <div class="text-[11px] font-black text-amber-300 uppercase mt-3 mb-1">Prosperity perks</div><div class="text-[11px] text-slate-300">${[1, 2, 3, 4].map(n => `<div>${rc().perks.includes(FORTS[n].perk[0]) ? '\u2705' : '\u2B1C'} Fort ${n}: ${FORTS[n].perk[1]}</div>`).join('')}</div></div>`);
    root.querySelector('[data-back]').onclick = back;
    const hb = root.querySelector('[data-heal]'); if (hb) hb.onclick = () => { const W = rc().wounded, c = { grain: 3 * Object.values(W).reduce((x, v) => x + v, 0) }; if (canPay(c)) { pay(c); for (const k in W) W[k] = 0; save(); } camp(back); };
    root.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => { const [g, k] = b.dataset.buy.split(':'), T = g === 'br' ? BR : UPS, c = T[k].cost[rc()[g][k]]; if (c && canPay(c)) { pay(c); rc()[g][k]++; save(); } camp(back); });
  }

  // ---------------------------------------------------------------- SCOUT + DRAFT (scroll-wheel pools, points)
  let draft = {};
  function scout(f) {
    RC._fort = f; const F = FORTS[f];
    draft = draft._f === f ? draft : { _f: f, inf: 0, archer: 0, brute: 0, wiz: 0 };
    const total = () => ['inf', 'archer', 'brute', 'wiz'].reduce((a, k) => a + draft[k], 0);
    const spent = () => ['inf', 'archer', 'brute', 'wiz'].reduce((a, k) => a + draft[k] * POOLS[k].cost, 0);
    const B = budgetOf(f);
    const demRows = () => { const m = missing(f, total()), d = F.dem; const L = [];
      if (d.ram) L.push(['ram', `Gate: Ram ${rc().br.ram}/${d.ram}`, m.ram]); if (d.siege) L.push(['siege', `${F.towers} towers: Siege ${rc().br.siege}/${d.siege}`, m.siege]);
      if (d.arcane) L.push(['arcane', `Barrier: Arcane ${rc().br.arcane}/${d.arcane}`, m.arcane]); if (d.army) L.push(['army', `Garrison: Army ${total()}/${d.army} units`, m.army]);
      return L; };
    const tips = { ram: 'Gates need Ram. Buy it at camp with grain.', siege: 'Towers need Siege, or they shoot your army to pieces.', arcane: 'A magic barrier soaks hits unless you bring Arcane.', army: 'A big garrison needs a big army. Draft enough units (Army raises your size cap).', phase: 'Break the wall, clear the courtyard wave, then kill the captain in the keep. More pirates arrive while the wall stands.', fa: 'The fort fights back on a timer. A warning flashes 2 s before: answer it with the ability named.', mod: 'Units this fort is weak to deal +25%. Units it resists deal -15%.', foes: 'These are the pirates inside. Counter them: archers beat brutes, brutes beat infantry, wizards beat archers.' };
    shell(`${top(`Fort ${f}: ${F.name}`, true)}<div class="flex-1 overflow-y-auto p-3 pb-24">
      <div id="rc-scout" class="bg-slate-800 rounded-xl p-2 mb-2 border border-slate-600"><div class="flex justify-between text-[11px] font-black text-amber-300 uppercase"><span>\u{1F50D} Scouting</span><span class="text-slate-400 normal-case">${F.where}</span></div>
        <div data-tip="foes" class="text-[12px] mt-1">\u{1F3F4}\u200D\u2620\uFE0F ${Object.entries(F.g).map(([k, v]) => `${v} ${({ inf: 'deckhands', archer: 'crossbows', brute: 'brutes', wiz: 'sea-witches' })[k]}`).join(', ')}</div>
        <div id="rc-dem"></div><div id="rc-tip" class="text-[11px] text-sky-200 mt-1"></div>
        <div data-tip="phase" class="text-[11px] mt-1 text-slate-200">\u{1F3F0} Wall \u2192 Courtyard \u2192 Keep (\u265B captain) \u00B7 ${RCX[f].time}s limit \u00B7 waves every ${RCX[f].wave.every}s</div>
        <div data-tip="fa" class="text-[11px] mt-0.5 text-rose-300">\u26A0\uFE0F Counters: ${RCX[f].fa.map(([k]) => FA[k].name.toLowerCase() + ' (' + FA[k].hint.replace('!', '').toLowerCase() + ')').join(', ')}</div>
        <div data-tip="mod" class="text-[11px] mt-0.5"><span class="text-emerald-300">\u2B06 Weak to ${RCX[f].weak}</span><br><span class="text-rose-300">\u2B07 Resists ${RCX[f].strong}</span></div>
        <div class="text-[10px] text-slate-400 mt-1">March supplies: ${resTxt(RCX[f].supply)} (lost on defeat, half back on retreat)<br>First clear: ${resTxt(F.pay)} \u00B7 \u2605\u2605 +25% \u00B7 \u2605\u2605\u2605 +60%${cleared(f) ? ` \u00B7 best ${'\u2605'.repeat(rc().forts[f].stars || 1)} (replays pay 25%)` : ''}</div></div>
      <div class="flex justify-between items-center mb-1"><span class="text-[11px] font-black uppercase text-amber-300">Draft</span><span id="rc-pts" class="text-sm font-black"></span></div>
      <div class="grid grid-cols-2 gap-2">${['inf', 'archer', 'brute', 'wiz'].map(k => { const P = POOLS[k], cap = poolCap(k); return `<div data-pool="${k}" class="bg-slate-800 rounded-xl p-2 ${cap ? '' : 'opacity-40'}">
        <div class="flex items-center gap-1"><img src="assets/${P.me.replace('_back', '')}" class="w-8 h-8 object-contain"><div><div class="text-[11px] font-black">${P.name}</div><div class="text-[9px] text-slate-400">${P.cost} pt \u00B7 cap ${cap}</div></div></div>
        <div class="flex items-center gap-1 mt-1"><button data-m="${k}" class="w-8 h-8 rounded-lg bg-slate-700 font-black">\u2212</button>
        <div class="rc-wheel flex-1 h-[84px] overflow-y-scroll rounded-lg bg-slate-950 border border-slate-600 text-center" data-w="${k}" style="scroll-snap-type:y mandatory;scrollbar-width:none">
          <div style="height:28px"></div>${Array.from({ length: cap + 1 }, (_, i) => `<div style="height:28px;line-height:28px;scroll-snap-align:center" class="text-lg font-black">${i}</div>`).join('')}<div style="height:28px"></div></div>
        <button data-p="${k}" class="w-8 h-8 rounded-lg bg-slate-700 font-black">+</button></div></div>`; }).join('')}</div>
      <div class="text-[10px] text-slate-400 mt-2">Army size cap ${armyCap()} \u00B7 abilities: ${[...new Set([...rc().abil, ...F.teach])].map(k => ABIL[k].icon + ABIL[k].name).join(' ') || 'none yet'}</div></div>
      <div class="absolute left-0 right-0 bottom-0 p-3 bg-slate-950/95 grid grid-cols-3 gap-2"><button id="rc-camp2" class="py-3 rounded-xl bg-slate-700 font-black text-xs uppercase">\u26FA Camp</button><button id="rc-march" class="col-span-2 py-3 rounded-xl bg-gradient-to-r from-rose-600 to-amber-500 font-black text-sm uppercase">\u2694\uFE0F March</button></div>`);
    root.querySelector('[data-back]').onclick = RC.open; $('rc-camp2').onclick = () => camp(() => scout(f));
    const refresh = () => {
      const left = B - spent(); $('rc-pts').innerHTML = `<span class="${left < 0 ? 'text-rose-400' : 'text-emerald-300'}">${left}</span> / ${B} pts \u00B7 ${total()}/${armyCap()} units`;
      $('rc-dem').innerHTML = demRows().map(([k, t, m]) => `<div data-tip="${k}" class="text-[12px] font-black ${m ? 'text-rose-400' : 'text-emerald-400'}">${m ? '\u2716' : '\u2714'} ${t}${m ? ` (short ${m})` : ''}</div>`).join('') || '<div class="text-[12px] text-emerald-400 font-black">\u2714 No defenses: breach freely</div>';
      const mm = missSum(missing(f, total())); $('rc-march').textContent = mm ? `\u2694\uFE0F March (fortified!)` : '\u2694\uFE0F March';
    };
    const setV = (k, v, fromWheel) => {
      v = Math.max(0, Math.min(poolCap(k), v));
      const others = spent() - draft[k] * POOLS[k].cost, otherN = total() - draft[k];
      while (v > 0 && (others + v * POOLS[k].cost > B || otherN + v > armyCap())) v--;
      const ch = v !== draft[k]; draft[k] = v; const w = root.querySelector(`[data-w="${k}"]`);
      if (w && (!fromWheel || Math.round(w.scrollTop / 28) !== v)) { w._lock = true; w.scrollTop = v * 28; setTimeout(() => w._lock = false, 120); }
      refresh(); if (ch) RC.ev('draft-change');
    };
    root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => setV(b.dataset.m, draft[b.dataset.m] - 1));
    root.querySelectorAll('[data-p]').forEach(b => b.onclick = () => setV(b.dataset.p, draft[b.dataset.p] + 1));
    root.querySelectorAll('[data-w]').forEach(w => { const k = w.dataset.w; w.scrollTop = draft[k] * 28; let t; w.onscroll = () => { if (w._lock) return; clearTimeout(t); t = setTimeout(() => setV(k, Math.round(w.scrollTop / 28), true), 90); }; });
    $('rc-scout').onclick = e => { const t = e.target.closest('[data-tip]'); if (t) { $('rc-tip').textContent = tips[t.dataset.tip]; RC.ev('scout-tap'); } };
    $('rc-march').onclick = () => { if (!total()) return; RC.ev('march'); battle(f, { ...draft }); };
    RC.setDraft = o => { for (const k in o) if (POOLS[k]) setV(k, o[k]); };   // test hook
    refresh();
    if (!guided(f, 'd')) guide(G[f].draft).then(() => markGuided(f, 'd'));
  }

  // ---------------------------------------------------------------- BATTLE (v39.6: phased siege - WALL, COURTYARD, KEEP; fort counter-abilities; charges)
  let B = null, raf = 0;
  const img = {}; const I = src => { if (!img[src] && typeof Image !== 'undefined') { const im = new Image(); im.src = src; img[src] = im; } return img[src]; };
  function stopBattle() { cancelAnimationFrame(raf); raf = 0; B = null; RC.paused = false; }
  const PH_NAME = { 1: 'THE WALL', 2: 'THE COURTYARD', 3: 'THE KEEP' };
  function makeB(f, d, W, H, headless) {
    const F = FORTS[f], X = RCX[f], ab = [...new Set([...rc().abil, ...F.teach])].filter(k => ABIL[k]);
    const total = Object.entries(d).filter(([k]) => POOLS[k]).reduce((a, [, v]) => a + v, 0);
    const miss = missing(f, total), ms = missSum(miss), up = rc().up, fortY = 92;
    const b = { f, F, X, W, H, t: 0, units: [], fx: [], fortHp: F.hp, fortMax: F.hp, fortMult: ms === 0 ? 1 : ms === 1 ? 0.1 : 0, miss, ms, towerT: 0, cds: {}, cdMax: {}, chg: {}, act: {}, done: false, headless, ab,
      stats: { lost: { me: {}, foe: {} }, kills: {}, sent: { ...d } }, fortY, barrierHp: F.barrier ? 600 * (miss.arcane ? 3 : 0.4) : 0, guideBattle: !headless && !guided(f, 'b') && G[f].battle.length, contactT: -1,
      ph: 1, waveT: X.wave.every, waves: 0, fa: X.fa.map(([k, every], i) => ({ k, every, t: every * 0.6 + i * 6, warn: 0, on: 0 })), msg: null, sent: total };
    const cdMul = (1 - 0.1 * up.cd) * (rc().perks.includes('cd10') ? 0.9 : 1);
    ab.forEach(k => { b.cds[k] = 0; b.cdMax[k] = ABIL[k].cd * cdMul; b.chg[k] = ABIL[k].chg; });
    b.meSc = { hp: 1 + 0.1 * up.hp, atk: 1 + 0.1 * up.atk }; b.foeSc = { hp: F.sc, atk: F.sc };
    B = b;
    let y = H - 150; ['brute', 'inf', 'archer', 'wiz'].forEach(k => { const n = d[k] || 0; if (n) { place('me', k, n, y, 1); y += 20 * Math.ceil(n / 12) + 4; } });
    spawnGroup(F.g, fortY + 150);
    b.units.filter(u => u.team === 'me').forEach(u => u.y = Math.min(u.y, H - 14));
    return b;
  }
  const mkU = (team, k, x, y, sc) => { const P = POOLS[k]; const hp = P.hp * sc.hp; return { team, k, x, y, hp, max: hp, atk: P.atk * sc.atk, rng: P.rng, spd: P.spd, r: P.r, t: Math.random(), shield: 0, inv: 0, blitz: 0 }; };
  function place(team, k, n, row0, dir) { const b = B, per = 12; for (let i = 0; i < n; i++) { const c = i % per, r = Math.floor(i / per), cnt = Math.min(per, n - r * per);
    b.units.push(mkU(team, k, b.W / 2 + (c - (cnt - 1) / 2) * (b.W * 0.84 / per) + (Math.random() - 0.5) * 6, row0 + dir * r * 20 + (Math.random() - 0.5) * 6, team === 'me' ? b.meSc : b.foeSc)); } }
  function spawnGroup(g, y0) { let y = y0; ['brute', 'inf', 'archer', 'wiz'].forEach(k => { const n = g[k] || 0; if (n) { place('foe', k, n, y, -1); y -= 20 * Math.ceil(n / 12) + 2; } });
    B.units.filter(u => u.team === 'foe').forEach(u => u.y = Math.max(u.y, B.fortY + 28)); }
  function say(txt, col) { if (B) B.msg = { txt, col: col || '#fde68a', t: 2.6 }; }
  function battle(f, d) {
    const F = FORTS[f];
    if (!payMarch(f)) return;
    const ab = [...new Set([...rc().abil, ...F.teach])].filter(k => ABIL[k]);
    shell(`<div class="flex items-center justify-between px-3 py-1.5 bg-slate-900 text-[11px] font-black"><button id="rc-retreat" class="px-2 py-1 rounded bg-slate-700">\u{1F3F3}\uFE0F Retreat</button>
      <span class="text-amber-300 uppercase">Fort ${f}: ${F.name}</span><span id="rc-time">0s</span></div>
      <div class="relative flex-1"><canvas id="rc-cv" class="absolute inset-0 w-full h-full"></canvas><div id="rc-fort" class="absolute left-0 right-0 top-1 text-center text-[10px] font-black"></div><div id="rc-msg" class="absolute left-0 right-0 text-center pointer-events-none" style="top:38%"></div></div>
      <div class="flex gap-1.5 p-2 bg-slate-900 justify-center" id="rc-abs" style="padding-bottom:calc(8px + env(safe-area-inset-bottom))">${ab.length ? ab.map(k => `<button data-ab="${k}" class="relative w-16 h-14 rounded-xl bg-slate-700 overflow-hidden"><div class="absolute inset-x-0 bottom-0 bg-amber-500/60" data-fill></div><div class="relative text-xl leading-none">${ABIL[k].icon}</div><div class="relative text-[9px] font-black uppercase">${ABIL[k].name} <span data-chg></span></div></button>`).join('') : '<span class="text-[11px] text-slate-400 py-4">No abilities yet: they unlock as you free forts.</span>'}</div>`);
    const cv = $('rc-cv'), dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    makeB(f, d, W, H, false); say(PH_NAME[1] + ': BREAK IT');
    $('rc-retreat').onclick = () => { if (B && !B.done && !RC.paused) finish(false, true); };
    root.querySelectorAll('[data-ab]').forEach(b => b.onclick = () => useAb(b.dataset.ab));
    I(A + F.bg); ['prop_fort_fortified', 'prop_fort_breached', 'prop_breach_gate', 'prop_breach_tower', 'prop_breach_barrier'].forEach(n => I(A + 'props/' + n + '.webp')); I(A + 'units/rogue_brute_front.webp'); I(A + 'units/rogue_seawitch_front.webp');
    Object.values(POOLS).forEach(P => { I('assets/' + P.me); I(A + 'units/' + P.foe); });
    let last = performance.now();
    const loop = now => { if (!B) return; const dt = Math.min(0.05, (now - last) / 1000); last = now; if (!RC.paused) step(dt); if (B) draw(ctx); if (B && !B.done) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
  }
  function payMarch(f) { const c = RCX[f].supply; if (!canPay(c)) { alert('Not enough supplies to march: ' + Object.entries(c).map(([k, v]) => v + ' ' + k).join(', ')); return false; } pay(c); save(); return true; }
  function useAb(k) {
    if (B && B.cds && B.cds[k] != null && waiters['abil-' + k]) { B.cds[k] = 0; B.chg[k] = Math.max(1, B.chg[k]); }
    if (!B || B.done || !B.cds || B.cds[k] == null || B.cds[k] > 0 || B.chg[k] <= 0) return false;
    const mine = B.units.filter(u => u.team === 'me' && u.hp > 0 && u.k === ABIL[k].unit);
    if (!mine.length) { RC.ev('abil-' + k); return false; }
    B.cds[k] = B.cdMax[k]; B.chg[k]--; B.act[k] = 3; RC.ev('abil-' + k);
    if (k === 'blitz') mine.forEach(u => u.blitz = 6);
    if (k === 'turtle') mine.forEach(u => u.inv = 3);
    if (k === 'repel') { mine.forEach(w => { B.fx.push({ k: 'ring', x: w.x, y: w.y, t: 0.5 }); B.units.forEach(e => { if (e.team === 'foe' && e.hp > 0 && Math.hypot(e.x - w.x, e.y - w.y) < 110) { hurt(w, e, 60); e.y = Math.max(B.fortY + 20, e.y - 60); e.fblitz = 0; } }); }); }
    if (k === 'barrier') B.units.forEach(u => { if (u.team === 'me' && u.hp > 0) u.shield = Math.max(u.shield, u.max * 0.10 * Math.min(3, mine.length)); });
    return true;
  }
  RC.useAb = useAb;
  RC.TEMPO = 4;   // v39.6 siege pace: every Reclamation swing/volley is 2.5x slower (unit stats unchanged), so a siege lasts minutes, not seconds
  function hurt(src, v, dmg) {
    if (v.hp <= 0) return; const SP = POOLS[src.k] || {}, VP = POOLS[v.k];
    if (v.inv > 0) return;
    if (BEATS[src.k] === v.k || (src.k === 'inf' && src.blitz > 0 && (v.k === 'wiz' || v.k === 'archer'))) dmg *= 1.5;
    if (SP.melee && VP.meleeX) dmg *= VP.meleeX;
    if (SP.magic && VP.mres) dmg *= 1 - VP.mres * 0.6;
    if (src.team === 'me' && B.X.mod[src.k]) dmg *= B.X.mod[src.k];
    if (src.fblitz > 0) dmg *= 1.5;
    if (v.blitz > 0) dmg *= 2;
    if (v.shield > 0) { const a = Math.min(v.shield, dmg); v.shield -= a; dmg -= a; }
    v.hp -= dmg;
    if (v.hp <= 0) { const S = B.stats, side = v.team === 'me' ? 'me' : 'foe'; S.lost[side][v.k] = (S.lost[side][v.k] || 0) + 1; const key = `${src.team}:${src.k}>${v.k}`; S.kills[key] = (S.kills[key] || 0) + 1; }
  }
  // fort counter-abilities: telegraphed 2 s, then fire. Answer with Turtle / Barrier / Repel / Rain.
  const FA = {
    volley: { name: 'CROSSBOW VOLLEY', hint: 'TURTLE or BARRIER!', dur: 3 },
    charge: { name: 'PIRATE CHARGE', hint: 'REPEL or TURTLE!', dur: 5 },
    bombard: { name: 'CANNON BOMBARD', hint: 'BARRIER!', dur: 0.1 },
    ward: { name: 'SEA-WITCH WARD', hint: 'RAIN or REPEL to break it!', dur: 0.1 },
  };
  // only name counters this battle actually has
  const hintFor = (b, k) => { const h = FA[k].hint, own = (b.ab || []).filter(x => h.includes(x.toUpperCase())); return own.length ? own.map(x => x.toUpperCase()).join(' or ') + '!' : 'BRACE!'; };
  function fortAbil(b, a, dt, mine, foes) {
    const ramp = 1 + 0.2 * (b.ph - 1);
    if (a.warn > 0) { a.warn -= dt; if (a.warn <= 0) { a.on = FA[a.k].dur; fireFA(b, a, mine, foes); } return; }
    if (a.on > 0) { a.on -= dt;
      if (a.k === 'volley' && mine.length) { const front = Math.min(...mine.map(m => m.y)); mine.forEach(m => { if (m.y < front + 90) hurt({ team: 'foe', k: 'tower' }, m, b.X.vol * ramp * dt); }); }
      return; }
    a.t -= dt; if (a.t <= 0 && foes.length) { a.t = a.every / ramp; a.warn = 2; say('\u26A0\uFE0F ' + FA[a.k].name + '! ' + hintFor(b, a.k), '#fca5a5'); }
  }
  function fireFA(b, a, mine, foes) {
    if (a.k === 'charge') foes.forEach(e => { if (POOLS[e.k].melee) e.fblitz = 5; });
    if (a.k === 'bombard') { for (let i = 0; i < 3 && mine.length; i++) { const t = mine[Math.floor(Math.random() * mine.length)]; b.fx.push({ k: 'boom', x: t.x, y: t.y, t: 0.4 }); mine.forEach(m => { if (Math.hypot(m.x - t.x, m.y - t.y) < 55) hurt({ team: 'foe', k: 'tower' }, m, b.X.bomb * (b.miss.siege ? 1.5 : 1)); }); } }
    if (a.k === 'ward') foes.forEach(e => { e.shield = Math.max(e.shield, e.max * (b.miss.arcane ? 0.35 : 0.2)); });
  }
  function nextPhase(b) {
    b.ph++; (b.pt = b.pt || []).push(Math.round(b.t)); say(PH_NAME[b.ph] + (b.ph === 3 ? ': THE CAPTAIN!' : ': CLEAR IT'), b.ph === 3 ? '#fbbf24' : '#fde68a');
    if (b.ph === 2) spawnGroup(b.X.court, b.fortY + 60);
    if (b.ph === 3) { spawnGroup(b.X.keep.g, b.fortY + 70); const C = b.X.keep.cap;
      const u = mkU('foe', C.k, b.W / 2, b.fortY + 34, { hp: 1, atk: 1 }); u.hp = u.max = C.hp; u.atk = C.atk; u.r = 18; u.cap = true; b.units.push(u); b.cap = u; }
  }
  function hitFort(u) {
    const b = B; let dmg = u.atk * (u.k === 'brute' ? 1.5 : 1) * b.fortMult * (b.X.mod[u.k] || 1);
    if (b.barrierHp > 0) { const a = Math.min(b.barrierHp, dmg * 3); b.barrierHp -= a; return; }
    b.fortHp -= dmg;
  }
  RC._ff = secs => { for (let i = 0; i < secs * 30 && B && !B.done; i++) { if (!RC.paused) step(1 / 30); } };
  function step(dt) {
    const b = B; b.t += dt; let live = b.units.filter(u => u.hp > 0);
    if (b.msg && (b.msg.t -= dt) <= 0) b.msg = null;
    for (const k in b.cds) b.cds[k] = Math.max(0, b.cds[k] - dt);
    for (const k in b.act) b.act[k] = Math.max(0, b.act[k] - dt);
    let foes = live.filter(u => u.team === 'foe'); const mine = live.filter(u => u.team === 'me');
    if (b.contactT < 0 && mine.some(m => foes.some(e => Math.abs(e.y - m.y) < 170))) { b.contactT = b.t; if (b.guideBattle) { b.guideBattle = 0; guide(G[b.f].battle).then(() => markGuided(b.f, 'b')); } }
    if (b.ph === 1 && b.fortHp <= 0) nextPhase(b);
    else if (b.ph === 2 && foes.length <= 1) nextPhase(b);
    if (b.ph === 1 && b.waves < (b.X.wave.max || 4) && (b.waveT -= dt) <= 0) { b.waveT = b.X.wave.every; b.waves++; spawnGroup(b.X.wave.g, b.fortY + 40); say('REINFORCEMENTS FROM THE FORT', '#fca5a5'); }
    if (b.contactT >= 0) b.fa.forEach(a => fortAbil(b, a, dt, mine, foes));
    live = b.units.filter(u => u.hp > 0); foes = live.filter(u => u.team === 'foe');
    if (b.act.rain > 0 && foes.length) { const front = Math.max(...foes.map(e => e.y)); const src = { team: 'me', k: 'archer' }; const nA = mine.filter(u => u.k === 'archer').length; foes.forEach(e => { if (e.y > front - 70) { if (e.shield > 0) e.shield = Math.max(0, e.shield - 40 * dt); hurt(src, e, (4 + nA * 0.9) * dt / RC.TEMPO * 1.6 * (1 + 0.1 * rc().up.atk)); } }); }
    for (const u of live) {
      u.inv = Math.max(0, u.inv - dt); u.blitz = Math.max(0, u.blitz - dt); u.fblitz = Math.max(0, (u.fblitz || 0) - dt); u.t -= dt;
      const P = POOLS[u.k], opp = u.team === 'me' ? foes : mine;
      let tgt = null, best = 1e9;
      if (u.blitz > 0 && u.team === 'me') { for (const e of opp) { const s = e.y - (e.cap ? 300 : e.k === 'wiz' ? 200 : e.k === 'archer' ? 100 : 0); if (s < best) { best = s; tgt = e; } } best = tgt ? Math.hypot(tgt.x - u.x, tgt.y - u.y) : 1e9; }
      else for (const e of opp) { const dd = Math.hypot(e.x - u.x, e.y - u.y); if (dd < best) { best = dd; tgt = e; } }
      const holding = u.team === 'foe' && !u.fblitz && (!tgt || best > (u.cap ? 140 : 230));
      if (u.team === 'me' && b.ph === 1 && (!tgt || (best > 260 && u.y - b.fortY < 150))) {
        const dy = u.y - (b.fortY + 30); if (dy > P.rng) u.y -= P.spd * dt; else if (u.t <= 0 && u.inv <= 0) { u.t = RC.TEMPO; hitFort(u); }
        continue;
      }
      if (!tgt || holding) continue;
      const rng = u.cap ? P.rng + 10 : P.rng;
      if (best > rng + (P.melee ? tgt.r : 0)) { const sp = P.spd * (u.blitz > 0 ? 2.2 : 1) * (u.fblitz > 0 ? 1.8 : 1); u.x += (tgt.x - u.x) / best * sp * dt; u.y += (tgt.y - u.y) / best * sp * dt; }
      else if (u.t <= 0 && u.inv <= 0) {
        u.t = (0.9 + Math.random() * 0.2) * RC.TEMPO; if (Math.random() > 0.88) continue;
        if (P.splash || u.cap) { const sp = P.splash || 40; opp.forEach(e => { if (Math.hypot(e.x - tgt.x, e.y - tgt.y) < sp) hurt(u, e, u.atk * (e === tgt ? 1 : 0.6)); }); b.fx.push({ k: 'boom', x: tgt.x, y: tgt.y, t: 0.25 }); }
        else { hurt(u, tgt, u.atk); if (!P.melee) b.fx.push({ k: 'shot', p: u.k === 'wiz' ? 'fireball' : 'arrow', team: u.team, x: u.x, y: u.y, x2: tgt.x, y2: tgt.y, t: 0.3, t0: 0.3 }); }
      }
    }
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) { const a = live[i], c = live[j]; const dx = c.x - a.x, dy = c.y - a.y, dd = Math.hypot(dx, dy) || 0.01, m = (a.r + c.r) * 0.8; if (dd < m) { const p = (m - dd) / 2 / dd; a.x -= dx * p; a.y -= dy * p; c.x += dx * p; c.y += dy * p; } }
    for (const u of live) { u.x = Math.max(8, Math.min(b.W - 8, u.x)); u.y = Math.max(b.fortY + 20, Math.min(b.H - 8, u.y)); }
    if (b.F.towers && mine.length) { b.towerT -= dt; if (b.towerT <= 0) { b.towerT = 1.2 * RC.TEMPO; const dmg = 26 * (b.miss.siege ? 1 + 1.5 * b.miss.siege : 0.4) * (b.ms ? 1.5 : 1);
      for (let i = 0; i < b.F.towers; i++) { const tx = b.W * (i ? 0.85 : 0.15), ty = b.fortY + 10; let t = null, bd = 300; for (const m of mine) { const dd = Math.hypot(m.x - tx, m.y - ty); if (dd < bd) { bd = dd; t = m; } } if (t) { hurt({ team: 'foe', k: 'tower' }, t, dmg); b.fx.push({ k: 'shot', x: tx, y: ty, x2: t.x, y2: t.y, t: 0.3, t0: 0.3 }); } } } }
    if (b.ms && mine.length && Math.floor(b.t) !== Math.floor(b.t - dt)) { const near = mine.filter(m => m.y - b.fortY < 160); near.forEach(m => hurt({ team: 'foe', k: 'fort' }, m, 14 * b.ms / RC.TEMPO)); }
    const alive = b.units.some(u => u.team === 'me' && u.hp > 0), won = b.ph === 3 && b.cap && b.cap.hp <= 0;
    if (won || !alive || b.t >= b.X.time) finish(won);
  }
  RC.sim = function (f, d, policy) {
    makeB(f, d, 390, 620, true); const b = B;
    for (let i = 0; i < 400 * 30 && !b.done; i++) {
      if (policy === 'spam') b.ab.forEach(k => useAb(k));
      else if (policy === 'good') {
        const warn = b.fa.find(a => a.warn > 0 && a.warn < 0.6), k = warn && warn.k, foes = b.units.filter(u => u.team === 'foe' && u.hp > 0);
        if (k === 'volley' || k === 'bombard') { useAb('barrier') || useAb('turtle'); }
        if (k === 'charge') useAb('turtle');
        if (b.fa.some(a => a.k === 'charge' && a.on > 4)) useAb('repel');
        if (b.fa.some(a => a.k === 'ward' && a.on > 0)) useAb('rain');
        const near = foes.filter(e => b.units.some(m => m.team === 'me' && m.hp > 0 && Math.hypot(m.x - e.x, m.y - e.y) < 150)).length;
        if (near >= 6 && (b.chg.rain > 1 || b.ph === 3)) useAb('rain');
        if (b.ph === 3 && b.cap && b.cap.hp > 0) { useAb('blitz'); if (near >= 4) useAb('repel'); }
      }
      step(1 / 30);
    }
    return RC.last;
  };
  function draw(c) {
    const b = B; if (!b) return; const { W, H } = b;
    const bg = img[A + b.F.bg]; if (bg && bg.complete && bg.naturalWidth) { const s = Math.max(W / bg.naturalWidth, H / bg.naturalHeight); c.drawImage(bg, (W - bg.naturalWidth * s) / 2, 0, bg.naturalWidth * s, bg.naturalHeight * s); } else { c.fillStyle = '#3b3a32'; c.fillRect(0, 0, W, H); }
    if (b.F.tint) { c.fillStyle = b.F.tint; c.fillRect(0, 0, W, H); }
    const dr = (src, x, y, w, h) => { const im = img[src]; if (im && im.complete && im.naturalWidth) c.drawImage(im, x - w / 2, y - h / 2, w, h); };
    dr(A + 'props/' + (b.fortHp <= 0 ? 'prop_fort_breached' : 'prop_fort_fortified') + '.webp', W / 2, b.fortY - 20, 110, 110);
    if (b.F.dem.ram) dr(A + 'props/prop_breach_gate.webp', W / 2, b.fortY + 22, 44, 44);
    for (let i = 0; i < b.F.towers; i++) dr(A + 'props/prop_breach_tower.webp', W * (i ? 0.85 : 0.15), b.fortY - 10, 46, 70);
    if (b.barrierHp > 0) { c.globalAlpha = 0.55; dr(A + 'props/prop_breach_barrier.webp', W / 2, b.fortY - 6, 180, 120); c.globalAlpha = 1; }
    if (b.ms && b.fortHp > 0) { c.strokeStyle = 'rgba(244,63,94,0.8)'; c.lineWidth = 3; c.setLineDash([6, 4]); c.beginPath(); c.arc(W / 2, b.fortY - 10, 70, 0, Math.PI * 2); c.stroke(); c.setLineDash([]); }
    if (b.act.rain > 0) { const foes = b.units.filter(u => u.team === 'foe' && u.hp > 0); if (foes.length) { const fy = Math.max(...foes.map(e => e.y)); c.lineWidth = 2; for (let i = 0; i < 26; i++) { const x = Math.random() * W, y = fy - 70 + Math.random() * 80; c.strokeStyle = '#e2e8f0'; c.beginPath(); c.moveTo(x + 2, y - 7); c.lineTo(x - 2, y + 7); c.stroke(); c.fillStyle = '#f59e0b'; c.fillRect(x + 1, y - 8, 3, 3); } /* v39.5 falling arrows, story-style */ } }
    b.fa.forEach(a => { if (a.k === 'volley' && (a.warn > 0 || a.on > 0)) { const mine = b.units.filter(u => u.team === 'me' && u.hp > 0); if (mine.length) { const fy = Math.min(...mine.map(m => m.y)); c.fillStyle = a.on > 0 ? 'rgba(244,63,94,0.28)' : `rgba(244,63,94,${0.1 + 0.12 * Math.abs(Math.sin(b.t * 8))})`; c.fillRect(0, fy - 14, W, 104);
        if (a.on > 0) { c.lineWidth = 2; for (let i = 0; i < 22; i++) { const x = Math.random() * W, y = fy - 10 + Math.random() * 96; c.strokeStyle = '#fecaca'; c.beginPath(); c.moveTo(x - 2, y - 7); c.lineTo(x + 2, y + 7); c.stroke(); } } } } });
    const us = b.units.filter(u => u.hp > 0).sort((p, q) => p.y - q.y);
    for (const u of us) { const P = POOLS[u.k], s = u.k === 'brute' ? 38 : 28;
      if (u.cap) { const cs = 50; c.fillStyle = 'rgba(251,191,36,0.25)'; c.beginPath(); c.arc(u.x, u.y, cs / 2 + 4, 0, 7); c.fill(); dr(A + 'units/' + (u.k === 'wiz' ? 'rogue_seawitch_front' : 'rogue_brute_front') + '.webp', u.x, u.y, cs, cs); c.fillStyle = '#fbbf24'; c.font = 'bold 9px sans-serif'; c.textAlign = 'center'; c.fillText('\u265B CAPTAIN', u.x, u.y - cs / 2 - 8); c.fillStyle = '#111'; c.fillRect(u.x - 22, u.y - cs / 2 - 5, 44, 4); c.fillStyle = '#f59e0b'; c.fillRect(u.x - 22, u.y - cs / 2 - 5, 44 * Math.max(0, u.hp / u.max), 4); if (u.shield > 0) { c.fillStyle = 'rgba(167,139,250,0.3)'; c.beginPath(); c.arc(u.x, u.y, cs / 2 + 2, 0, 7); c.fill(); } continue; }
      if (u.fblitz > 0) { c.fillStyle = 'rgba(248,113,113,0.35)'; c.beginPath(); c.arc(u.x, u.y, s / 2 + 3, 0, 7); c.fill(); }
      if (u.team === 'me') dr('assets/' + P.me, u.x, u.y, s, s); else dr(A + 'units/' + P.foe, u.x, u.y, s, s);
      if (u.inv > 0) { c.strokeStyle = '#fbbf24'; c.lineWidth = 2; c.beginPath(); c.arc(u.x, u.y, s / 2, 0, 7); c.stroke(); }
      if (u.shield > 0) { c.fillStyle = 'rgba(167,139,250,0.3)'; c.beginPath(); c.arc(u.x, u.y, s / 2 + 2, 0, 7); c.fill(); }
      if (u.blitz > 0) { c.fillStyle = 'rgba(250,204,21,0.5)'; c.fillRect(u.x - 2, u.y + s / 2 - 2, 4, 6); }
      c.fillStyle = '#111'; c.fillRect(u.x - 9, u.y - s / 2 - 4, 18, 3); c.fillStyle = u.team === 'me' ? '#38bdf8' : '#f43f5e'; c.fillRect(u.x - 9, u.y - s / 2 - 4, 18 * Math.max(0, u.hp / u.max), 3); }
    b.fx = b.fx.filter(f => (f.t -= 1 / 60) > 0);
    for (const f of b.fx) { if (f.k === 'shot') { const q = 1 - f.t / (f.t0 || 0.3), px = f.x + (f.x2 - f.x) * q, py = f.y + (f.y2 - f.y) * q;   // v39.5 travelling projectile drawn like story mode (was a full-length laser line)
      c.save(); c.translate(px, py);
      if (f.p === 'fireball') { c.fillStyle = f.team === 'me' ? '#38bdf8' : '#c084fc'; c.beginPath(); c.arc(0, 0, 4.5, 0, 7); c.fill(); }
      else { c.rotate(Math.atan2(f.y2 - f.y, f.x2 - f.x)); c.strokeStyle = '#e2e8f0'; c.lineWidth = 2; c.beginPath(); c.moveTo(-7, 0); c.lineTo(7, 0); c.stroke(); c.fillStyle = '#f59e0b'; c.fillRect(-7, -2, 3, 4); }
      c.restore(); } else { c.strokeStyle = f.k === 'ring' ? '#a78bfa' : '#5eead4'; c.lineWidth = 3; c.beginPath(); c.arc(f.x, f.y, f.k === 'ring' ? 110 * (1 - f.t * 2) : 20, 0, 7); c.stroke(); } }
    const fe = $('rc-fort'); if (fe && b.ph > 1) fe.innerHTML = `<span class="text-amber-200">${b.ph === 2 ? 'Courtyard: ' + b.units.filter(u => u.team === 'foe' && u.hp > 0).length + ' defenders' : 'Keep: defeat the captain'}</span>`; else if (fe) fe.innerHTML = `<div class="mx-auto w-40 h-2 bg-slate-900 rounded"><div class="h-2 rounded ${b.ms ? 'bg-rose-500' : 'bg-amber-400'}" style="width:${Math.max(0, b.fortHp / b.fortMax * 100)}%"></div></div>${b.ms ? '<span class="text-rose-300">FORTIFIED: breach power too low</span>' : b.barrierHp > 0 ? '<span class="text-violet-300">Barrier up</span>' : ''}`;
    const me = $('rc-msg'); if (me) me.innerHTML = b.msg ? `<span class="inline-block px-3 py-1.5 rounded-xl bg-black/70 text-[13px] font-black" style="color:${b.msg.col};border:1px solid ${b.msg.col}">${b.msg.txt}</span>` : '';
    root.querySelectorAll('[data-chg]').forEach(el => { const k = el.closest('[data-ab]').dataset.ab; el.textContent = '\u00D7' + b.chg[k]; el.closest('[data-ab]').style.opacity = b.chg[k] > 0 ? 1 : 0.4; });
    const te = $('rc-time'); if (te) te.textContent = `${PH_NAME[b.ph]} \u00B7 ${Math.floor(b.t)}s / ${b.X.time}s`;
    root.querySelectorAll('[data-ab]').forEach(el => { const k = el.dataset.ab, f = el.querySelector('[data-fill]'); if (f) f.style.height = `${(1 - b.cds[k] / b.cdMax[k]) * 100}%`; el.classList.toggle('ring-2', b.cds[k] <= 0); el.classList.toggle('ring-amber-300', b.cds[k] <= 0); });
  }

  // ---------------------------------------------------------------- RESULTS (stats + decisive matchup) + REWARDS + STORY NOTE
  const NOUN = { inf: 'infantry', archer: 'archers', brute: 'brutes', wiz: 'wizards', tower: 'towers', fort: 'walls' };
  const VERB = { 'archer>brute': 'shredded', 'brute>inf': 'flattened', 'wiz>archer': 'scorched', 'inf>wiz': 'ran down', 'inf>archer': 'ran down' };
  function finish(win, retreat) {
    const b = B; if (!b || b.done) return; b.done = true; if (!b.headless) cancelAnimationFrame(raf);
    const f = b.f, F = b.F, X = b.X, rec = rc().forts[f] = rc().forts[f] || { clears: 0, best: 0, stars: 0 }, first = win && !rec.clears;
    const lostN = Object.values(b.stats.lost.me).reduce((a, v) => a + v, 0), surv = b.sent ? 1 - lostN / b.sent : 0;
    const stars = win ? 1 + (surv >= 0.5 ? 1 : 0) + (b.t <= X.par ? 1 : 0) : 0;
    let reward = {}, unlockedAb = [], perk = null, refund = {};
    // v39.6 risk: fallen draftees are wounded (out of the pools until tended at camp). A win patches up half; a retreat saves the survivors and half the supplies.
    const W = rc().wounded = rc().wounded || { inf: 0, archer: 0, brute: 0, wiz: 0 };
    for (const [k, n] of Object.entries(b.stats.lost.me)) if (k in W) W[k] = Math.min(99, W[k] + (win ? Math.floor(n / 2) : n));
    if (retreat) { for (const [k, v] of Object.entries(X.supply)) refund[k] = Math.floor(v / 2); give(refund); }
    if (win) {
      rec.clears++; rec.best = rec.best ? Math.min(rec.best, Math.round(b.t)) : Math.round(b.t);
      const bonus = [0, 0, 0.25, 0.6][stars], newStar = stars > (rec.stars || 0);
      for (const [k, v] of Object.entries(F.pay)) reward[k] = Math.round(v * (1 + bonus) * (first ? 1 : newStar ? 0.6 : 0.25));
      rec.stars = Math.max(rec.stars || 0, stars);
      give(reward);
      if (first) { F.unlockAb.forEach(k => { if (!rc().abil.includes(k)) { rc().abil.push(k); unlockedAb.push(k); } }); if (!rc().perks.includes(F.perk[0])) { rc().perks.push(F.perk[0]); perk = F.perk[1]; } }
    }
    save();
    const top3 = Object.entries(b.stats.kills).sort((p, q) => q[1] - p[1]);
    const dec = top3.find(([k]) => k.startsWith(win ? 'me:' : 'foe:')) || top3[0];
    let decTxt = 'No clear winner in the matchups.';
    if (dec) { const [side, pair] = dec[0].split(':'), [a, v] = pair.split('>'); decTxt = `${side === 'me' ? 'Your' : 'Their'} ${NOUN[a] || a} ${VERB[pair] || 'cut down'} ${side === 'me' ? 'their' : 'your'} ${NOUN[v] || v} (${dec[1]}).`; }
    RC.last = { kills: b.stats.kills, win, retreat: !!retreat, t: Math.round(b.t), ph: b.ph, pt: b.pt || [], alive: b.units.filter(u => u.team === "me" && u.hp > 0).length, stars, surv: Math.round(surv * 100), fortHpPct: Math.round(Math.max(0, b.fortHp) / b.fortMax * 100), lost: b.stats.lost, reward, refund, dec: decTxt, fortified: b.ms > 0 };
    if (b.headless) { B = null; return; }
    const L = b.stats.lost, foeN = k => (F.g[k] || 0) + (X.court[k] || 0) + (X.keep.g[k] || 0) + b.waves * (X.wave.g[k] || 0), row = k => `<tr><td class="text-left">${POOLS[k].name}</td><td>${b.stats.sent[k] || 0}</td><td class="text-rose-300">${L.me[k] || 0}</td><td>${foeN(k)}</td><td class="text-emerald-300">${L.foe[k] || 0}</td></tr>`;
    const why = retreat ? 'You sounded the retreat. Survivors are safe; half the supplies came back.' : !win ? (b.ms ? 'The fort was fortified. Raise your breach power at camp.' : b.t >= X.time ? `Out of time at ${PH_NAME[b.ph].toLowerCase()}. The garrison held.` : 'Your army fell. Try a different mix, and answer their volleys.') + ' Supplies lost.' : '';
    const st = n => `<span style="color:${n <= stars ? '#fbbf24' : '#475569'}">\u2605</span>`;
    const wn = Object.values(L.me).reduce((a, v) => a + v, 0);
    shell(`${top(win ? 'Fort freed!' : retreat ? 'Retreat' : 'Repelled', true)}<div class="flex-1 overflow-y-auto p-3">
      <div class="text-center text-2xl font-black ${win ? 'text-emerald-300' : 'text-rose-400'}">${win ? '\u{1F3F3}\uFE0F VICTORY' : retreat ? '\u{1F3F3}\uFE0F RETREAT' : '\u2620\uFE0F DEFEAT'} <span class="text-sm text-slate-300">${Math.round(b.t)}s</span></div>
      ${win ? `<div class="text-center text-4xl leading-none mt-1">${st(1)}${st(2)}${st(3)}</div><div class="text-center text-[10px] text-slate-400">\u2605 Freed \u00B7 ${surv >= 0.5 ? '\u2714' : '\u2716'} \u2605 half your troops alive (${Math.round(surv * 100)}%) \u00B7 ${b.t <= X.par ? '\u2714' : '\u2716'} \u2605 under ${X.par}s</div>` : ''}
      ${why ? `<p class="text-center text-[12px] text-amber-200">${why}</p>` : ''}
      <div class="bg-slate-800 rounded-xl p-2 mt-2 text-center text-[12px] font-black text-amber-200">\u2694\uFE0F Decisive matchup: ${decTxt}</div>
      <table class="w-full text-[12px] text-center mt-2"><tr class="text-slate-400 text-[10px] uppercase"><th class="text-left">Unit</th><th>Sent</th><th>Lost</th><th>Pirates</th><th>Killed</th></tr>${['inf', 'archer', 'brute', 'wiz'].map(row).join('')}</table>
      <div class="text-[11px] text-slate-300 mt-1">Reached: ${PH_NAME[b.ph]} \u00B7 ${wn ? `\u{1FA79} ${win ? Math.ceil(wn / 2) + ' patched up, ' + Math.floor(wn / 2) : wn} wounded (tend them at camp)` : 'no wounded'}</div>
      ${win ? `<div class="mt-2 bg-emerald-900/50 rounded-xl p-2 text-[12px] font-black">Reward: ${resTxt(reward) || 'none'}${stars > 1 ? ` <span class="text-amber-300">(+${[0, 0, 25, 60][stars]}% star bonus)</span>` : ''}${unlockedAb.length ? `<br>New ability: ${unlockedAb.map(k => ABIL[k].icon + ' ' + ABIL[k].name).join(', ')}` : ''}${perk ? `<br>Prosperity perk: ${perk}` : ''}</div>` : retreat ? `<div class="mt-2 bg-slate-800 rounded-xl p-2 text-[12px] font-black">Refund: ${resTxt(refund)}</div>` : ''}
      <div class="grid grid-cols-2 gap-2 mt-3"><button id="rc-again" class="py-3 rounded-xl bg-slate-700 font-black text-xs uppercase">Redraft</button><button id="rc-map" class="py-3 rounded-xl bg-amber-500 text-slate-950 font-black text-xs uppercase">Map</button></div></div>`);
    root.querySelector('[data-back]').onclick = RC.open; $('rc-map').onclick = RC.open; $('rc-again').onclick = () => scout(f);
    B = null; if (first) note(f);
  }
  function note(f) {
    const F = FORTS[f], ov = document.createElement('div');
    ov.className = 'fixed inset-0 z-[96] bg-black/80 flex items-center justify-center p-5';
    ov.innerHTML = `<div class="bg-amber-50 text-slate-900 rounded-xl p-4 max-w-xs shadow-2xl" style="font-family:Georgia,serif"><div class="text-[10px] font-black uppercase tracking-widest text-amber-700 mb-1">\u{1F4DC} Story note ${f}/4</div><p class="text-[14px] leading-snug italic">${F.noteText}</p><div class="text-right text-[10px] text-slate-500 mt-2">tap to close</div></div>`;
    root.appendChild(ov); let au = null;
    if (F.note <= 3) { try { au = new Audio(A + `voice/reclaim_note_fort${F.note}.mp3`); if (!(Story.voMuted && Story.voMuted())) au.play().catch(() => {}); RC._noteAudio = au; } catch (e) {} }
    ov.onclick = () => { if (au) au.pause(); ov.remove(); };
  }

  // ---------------------------------------------------------------- menu entry (after Story), unlocked by beating M07
  const css = document.createElement('style'); css.textContent = '.rc-hl{outline:3px solid #fbbf24!important;outline-offset:2px;animation:rcp 1s infinite}@keyframes rcp{50%{outline-color:#fff}}.rc-wheel::-webkit-scrollbar{display:none}.rc-ann{animation:rca .35s ease-out}@keyframes rca{from{transform:scale(1.6);opacity:0}}';
  document.head.appendChild(css);
  setTimeout(() => { const b = $('btn-reclaim'); if (b) b.remove(); }, 50);   // v39.5 no main-menu button: Reclamation is on the story map
  // v39.6 tuned balance (sim: tune.js)
  const TUNE = {"1":{"F":{"hp":10000},"X":{"wave":{"every":20,"max":6,"g":{"inf":3,"archer":1}},"court":{"inf":8,"archer":4},"keep":{"cap":{"k":"brute","hp":2800,"atk":22},"g":{"inf":4}},"vol":5,"time":220,"par":150,"fa":[["volley",35]],"bomb":25}},"2":{"F":{"hp":12000},"X":{"wave":{"every":20,"max":6,"g":{"inf":3,"archer":2}},"court":{"inf":7,"archer":4,"brute":1},"keep":{"cap":{"k":"brute","hp":3800,"atk":34},"g":{"inf":4,"brute":1}},"vol":5,"time":240,"par":160,"fa":[["volley",32],["charge",45]],"bomb":25}},"3":{"F":{"hp":8000,"sc":0.9,"g":{"inf":10,"archer":6,"brute":2,"wiz":1}},"X":{"wave":{"every":22,"max":6,"g":{"inf":3,"archer":2}},"court":{"inf":5,"archer":3,"brute":1},"keep":{"cap":{"k":"wiz","hp":1700,"atk":16},"g":{"archer":1,"brute":1}},"vol":5,"bomb":25,"time":260,"par":85,"fa":[["volley",30],["bombard",40]]}},"4":{"F":{"hp":9000,"sc":0.7,"g":{"inf":15,"archer":9,"brute":4,"wiz":1}},"X":{"wave":{"every":22,"max":7,"g":{"inf":3,"archer":1,"brute":1}},"court":{"inf":6,"archer":6,"brute":2},"keep":{"cap":{"k":"brute","hp":3000,"atk":28},"g":{"inf":4,"brute":2}},"vol":5,"time":290,"par":75,"fa":[["volley",30],["charge",42],["ward",50]],"bomb":25}}};
  for (const f in TUNE) { if (TUNE[f].F) Object.assign(FORTS[f], TUNE[f].F); if (TUNE[f].X) Object.assign(RCX[f], TUNE[f].X); }
  RC.B = () => B;   // test hook
  RC.FORTS = FORTS; RC.RCX = RCX; RC.unlocked = unlocked; RC.scout = scout; RC.camp = camp; RC.missing = missing;
})();
