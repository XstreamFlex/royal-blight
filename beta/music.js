// music.js (v34.5, t89u): background music. Web Audio player with crossfades, per-screen/mission tracks,
// Felix boss phases, victory/defeat stings, ducking under dialogue and cutscenes. Files stream on demand
// from assets/music (OGG Vorbis, AAC .m4a fallback for Safari/iOS) and are not precached by the SW.
(function () {
  const BASE = 'assets/music/';
  const MENU = ['menu_a', 'menu_b', 'menu_c'];
  const MISSION = { P0: 'P0', M01: 'M01', M02: 'M02', M03: 'M03', M04: 'M04', M05: 'M05', M06: 'M06' };
  const a = document.createElement('audio');
  const EXT = a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"') && !/iPad|iPhone|iPod|Macintosh.*Safari/.test(navigator.userAgent.replace(/Chrome|CriOS|Firefox|FxiOS/, 'X')) ? '.ogg' : '.m4a';
  let ctx = null, master = null, duck = null, cur = null, curKey = null, buffers = {}, loading = {}, rot = Math.floor(Math.random() * 3), lastMatch = null, stingFor = null, stingUntil = 0;
  const S = () => (typeof SETTINGS !== 'undefined' ? SETTINGS : {});
  const vol = () => (S().musicOff ? 0 : (S().musicVol == null ? 0.5 : +S().musicVol)) * 0.55;   // low-key under gameplay
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    master = ctx.createGain(); duck = ctx.createGain(); duck.connect(master); master.connect(ctx.destination); master.gain.value = vol();
  }
  ['pointerdown', 'keydown', 'touchend'].forEach(ev => window.addEventListener(ev, init, { passive: true }));
  function load(k) {
    if (buffers[k]) return Promise.resolve(buffers[k]);
    if (!loading[k]) loading[k] = fetch(BASE + k + EXT).then(r => r.arrayBuffer()).then(b => new Promise((ok, no) => ctx.decodeAudioData(b, ok, no)))
      .then(buf => (buffers[k] = buf)).catch(() => { delete loading[k]; return null; });
    return loading[k];
  }
  function play(k, opts) {
    opts = opts || {};
    if (!ctx || k === curKey) return;
    curKey = k; const fade = opts.fade == null ? 1.6 : opts.fade, old = cur; cur = null;
    if (old) { const t = ctx.currentTime; old.g.gain.cancelScheduledValues(t); old.g.gain.setValueAtTime(old.g.gain.value, t); old.g.gain.linearRampToValueAtTime(0, t + fade); setTimeout(() => { try { old.src.stop(); } catch (e) {} }, fade * 1000 + 100); }
    if (!k) return;
    load(k).then(buf => {
      if (!buf || curKey !== k) return;
      const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; src.loop = !opts.once; src.connect(g); g.connect(duck);
      const t = ctx.currentTime; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + (opts.once ? 0.05 : fade));
      let off = 0; if (opts.sync && old && old.src.buffer && old.src.buffer.duration === buf.duration) off = (t - old.t0) % buf.duration;   // boss phases stay in time
      src.start(t, off); cur = { src, g, t0: t - off, k };
      if (opts.once) src.onended = () => { if (cur && cur.src === src) { cur = null; curKey = null; } };
    });
  }
  const shown = id => { const e = document.getElementById(id); return e && !e.classList.contains('hidden') && e.offsetParent !== null; };
  function want() {
    const st = typeof state !== 'undefined' ? state : null, Story = window.Story;
    if (performance.now() < stingUntil) return { k: curKey };
    if (st && st.gameOver && st.winner) {
      const id = 'm';
      if (stingFor !== id) { stingFor = id; stingUntil = performance.now() + 9000; const me = (typeof myTeam === 'function' ? myTeam() : 'blue'); return { k: st.winner === me ? 'victory' : 'defeat', once: true, fade: 0.6 }; }
      return { k: null };
    }
    if (st && st.started && !st.gameOver) {
      if (lastMatch !== st) { lastMatch = st; }
      if (Story && Story.active && Story.m) { const id = Story.m.id; if (id === 'M07') return { k: 'felix_' + Math.min(3, (Story.R && Story.R.phase) || 1), sync: true, fade: 2.5 }; return { k: MISSION[id] || 'M01' }; }
      return { k: MENU[rot % 3] };
    }
    if (shown('modal-story') || shown('modal-brief')) return { k: 'map' };
    return { k: MENU[rot % 3] };
  }
  let wasPlaying = false;
  function tick() {
    if (!ctx) return;
    const st = typeof state !== 'undefined' ? state : null, playing = !!(st && st.started && !st.gameOver);
    if (playing && !wasPlaying) rot++;                      // next quick-match/menu rotation each match
    if (playing && !wasPlaying) stingFor = null;
    wasPlaying = playing;
    const w = want(); if (w.k !== curKey) play(w.k, w);
    const t = ctx.currentTime, cine = shown('rb-cine'), dlg = shown('rb-dialogue'), paused = st && st.paused;
    const d = cine ? 0.0 : dlg ? 0.35 : paused ? 0.45 : 1;   // duck: cutscenes silence the bed, dialogue/pause dip it
    duck.gain.setTargetAtTime(d, t, 0.25); master.gain.setTargetAtTime(vol(), t, 0.1);
  }
  setInterval(tick, 400);
  document.addEventListener('visibilitychange', () => { if (!ctx) return; document.hidden ? ctx.suspend() : ctx.resume(); });
  window.Music = { play, tick, setVol(v) { S().musicVol = v; tick(); }, toggle() { S().musicOff = !S().musicOff; tick(); return !S().musicOff; }, get key() { return curKey; } };
})();
