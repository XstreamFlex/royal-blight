// Royal Blight - Play vs Friend.
// WebRTC DataChannel, paired by QR code / copy-paste (no signaling server), host-authoritative:
//   host = King (blue) runs the whole simulation and streams ~12 snapshots/s;
//   guest = Necromancer (red) renders interpolated snapshots and sends its orders as commands.
// Shares the global scope of the engine script in index.html (state, VIEW, startMatch, ...).
const MP = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // used only when internet exists
  const CODE_PREFIX = 'RB1';
  const SNAP_HZ = 12;
  const INTERP_DELAY = 110; // ms behind the newest snapshot (smooths jitter)

  let pc = null, dc = null, role = null, open = false;
  let sendAcc = 0, fxQueue = [], snaps = [], dropTimer = null, leaving = false;
  const walk = new Map(); // guest: per-unit walk-cycle phase

  const $ = id => document.getElementById(id);
  const status = t => { const el = $('mp-status'); if (el) el.textContent = t || ''; };

  // ---------- SDP <-> short code ----------
  // Only what a data-channel needs survives: ICE ufrag/pwd, DTLS fingerprint, setup role and the
  // UDP candidates. The other side rebuilds a minimal SDP from it. Typical code: 150-350 chars.
  const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const SETUP = { actpass: 'p', active: 'a', passive: 's' }, SETUP_R = { p: 'actpass', a: 'active', s: 'passive' };
  const TYP = { host: 'h', srflx: 's', relay: 'r', prflx: 'x' }, TYP_R = { h: 'host', s: 'srflx', r: 'relay', x: 'prflx' };

  function pack(sdp, type) {
    const L = sdp.split(/\r?\n/);
    const get = p => (L.find(l => l.startsWith(p)) || '').slice(p.length).trim();
    const [alg, fp] = get('a=fingerprint:').split(' ');
    const fpBytes = fp.split(':').map(h => parseInt(h, 16));
    const seen = new Set();
    const cands = L.filter(l => l.startsWith('a=candidate:')).map(l => l.slice(12).split(' '))
      .filter(c => c[1] === '1' && c[2].toLowerCase() === 'udp')
      .map(c => [c[4], c[5], TYP[c[7]] || 'h', c[3]].join(','))
      .filter(c => !seen.has(c) && seen.add(c)).slice(0, 6);
    return CODE_PREFIX + [type === 'offer' ? 'O' : 'A', get('a=ice-ufrag:'), get('a=ice-pwd:'),
      alg, b64u(fpBytes), SETUP[get('a=setup:')] || 'p', cands.join(';')].join('|');
  }
  function unpack(code) {
    code = (code || '').trim().replace(/\s+/g, '');
    if (!code.startsWith(CODE_PREFIX)) throw new Error('Not a Royal Blight code');
    const [t, ufrag, pwd, alg, fp, setup, cands] = code.slice(CODE_PREFIX.length).split('|');
    const fpHex = Array.from(unb64u(fp), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const lines = ['v=0', 'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
      'a=msid-semantic: WMS', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0'];
    (cands ? cands.split(';') : []).forEach((c, i) => {
      const [ip, port, ty, prio] = c.split(',');
      const typ = TYP_R[ty] || 'host';
      lines.push(`a=candidate:${i + 1} 1 udp ${prio} ${ip} ${port} typ ${typ}` + (typ === 'host' ? '' : ' raddr 0.0.0.0 rport 0'));
    });
    lines.push('a=end-of-candidates', 'a=ice-ufrag:' + ufrag, 'a=ice-pwd:' + pwd, 'a=ice-options:trickle',
      `a=fingerprint:${alg} ${fpHex}`, 'a=setup:' + (SETUP_R[setup] || 'actpass'), 'a=mid:0',
      'a=sctp-port:5000', 'a=max-message-size:262144');
    return { type: t === 'O' ? 'offer' : 'answer', sdp: lines.join('\r\n') + '\r\n' };
  }

  function gatherDone(conn, ms = 3500) {
    return new Promise(res => {
      if (conn.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, ms); // offline: STUN can't answer, go with what we have
      conn.addEventListener('icegatheringstatechange', () => {
        if (conn.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
  }

  // ---------- connection ----------
  function newPC() {
    teardown();
    leaving = false;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.addEventListener('connectionstatechange', () => {
      const st = pc && pc.connectionState;
      if (st === 'connected') { clearTimeout(dropTimer); dropTimer = null; }
      if (st === 'failed' || st === 'closed') lost('The connection to the other phone failed.');
      if (st === 'disconnected') { clearTimeout(dropTimer); dropTimer = setTimeout(() => lost('The other phone stopped responding.'), 5000); }
    });
    return pc;
  }
  function wire(channel) {
    dc = channel;
    dc.onopen = () => {
      open = true;
      status('Connected!');
      if (role === 'host') startHostMatch();
    };
    dc.onclose = () => { open = false; lost('The other phone disconnected.'); };
    dc.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.warn('MP message', err); } };
  }
  async function hostCreate() {
    role = 'host';
    newPC();
    wire(pc.createDataChannel('rb', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await gatherDone(pc);
    return pack(pc.localDescription.sdp, 'offer');
  }
  async function hostAccept(code) {
    const d = unpack(code);
    if (d.type !== 'answer') throw new Error('That is an invite code, not an answer');
    await pc.setRemoteDescription(d);
  }
  async function guestJoin(code) {
    const d = unpack(code);
    if (d.type !== 'offer') throw new Error('That is an answer code, not an invite');
    role = 'guest';
    newPC();
    pc.ondatachannel = e => wire(e.channel);
    await pc.setRemoteDescription(d);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherDone(pc);
    return pack(pc.localDescription.sdp, 'answer');
  }
  function send(msg) {
    if (dc && open && dc.bufferedAmount < 512 * 1024) dc.send(JSON.stringify(msg));
  }
  function teardown() {
    clearTimeout(dropTimer); dropTimer = null;
    open = false;
    try { if (dc) { dc.onclose = null; dc.close(); } } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    dc = null; pc = null; snaps = []; fxQueue = []; walk.clear();
  }
  function leave() { leaving = true; send({ k: 'bye' }); setTimeout(teardown, 150); role = null; }
  function lost(msg) {
    if (leaving || !role) return;
    if (!state.started || (state.mode !== 'host' && state.mode !== 'guest')) { status(msg); return; }
    state.paused = true;
    $('mpdrop-msg').textContent = msg + ' The match is paused.';
    $('modal-mpdrop').classList.remove('hidden');
  }

  // ---------- match flow ----------
  function startHostMatch() {
    startMatch('host');
    sendAcc = 1; // snapshot right away
    send({ k: 'start' });
  }
  function rematch() {
    const btn = $('btn-restart');
    if (role === 'host') startHostMatch();
    else { send({ k: 'rematch' }); btn.textContent = 'Waiting for host…'; btn.disabled = true; }
  }
  function onMessage(m) {
    if (m.k === 'bye') { lost('Your friend left the match.'); return; }
    if (role === 'host') {
      if (m.k === 'cmd') applyCommand('red', m.c);
      else if (m.k === 'rematch' && state.gameOver) startHostMatch();
    } else {
      if (m.k === 'start') { snaps = []; walk.clear(); startMatch('guest'); }
      else if (m.k === 's') {
        snaps.push({ t: performance.now(), s: m });
        if (snaps.length > 30) snaps.shift();
        (m.fx || []).forEach(applyFx);
      }
    }
  }

  // ---------- host: snapshots ----------
  const UT = ['pawn', 'archer', 'wizard', 'brute', 'worker'];
  const PT = ['arrow', 'fireball', 'turret_bolt', 'core_bolt'];
  const r1 = v => Math.round(v * 10) / 10;
  function fx(e) { if (state.mode === 'host' && open) { fxQueue.push(e); if (fxQueue.length > 120) fxQueue.shift(); } }
  function snapshot() {
    const core = c => [Math.ceil(c.hp), c.flash > 0 ? 1 : 0, r1(c.pulse || 0), r1(c.aimX || 0), r1(c.aimY || 0)];
    return {
      k: 's', gt: r1(state.gameTime), w: state.waveCount, wt: r1(state.waveTimer),
      g: [Math.floor(state.blueGold), Math.floor(state.redGold)],
      c: [state.blueCadence, state.redCadence], n: [state.playerNode, state.aiNode],
      u: state.units.filter(u => !u.dead).map(u => [u.id, UT.indexOf(u.type), u.team === 'blue' ? 0 : 1,
        Math.round(u.x), Math.round(u.y), Math.ceil(u.hp), u.effectiveMaxHp, u.flash > 0 ? 1 : 0, u.radius,
        u.type === 'worker' ? (u.workerState === 'FLEEING' ? 1 : 0) : 0, u.carriedGold || 0]),
      p: state.projectiles.map(p => [PT.indexOf(p.type), p.team === 'blue' ? 0 : 1, Math.round(p.x), Math.round(p.y),
        Math.round(p.targetX || 0), Math.round(p.targetY || 0)]),
      co: [core(state.cores.blue), core(state.cores.red)],
      tp: state.turretPads.map(p => (p.turret && !p.turret.dead)
        ? [Math.ceil(p.turret.hp), p.turret.maxHp, p.turret.charge, p.turret.flash > 0 ? 1 : 0, r1(p.turret.rotation)] : 0),
      go: state.gameOver ? state.winner : 0,
      fx: fxQueue.splice(0)
    };
  }
  function hostTick(realDt) {
    if (!open || role !== 'host') return;
    sendAcc += realDt;
    if (sendAcc >= 1 / SNAP_HZ) { sendAcc = 0; send(snapshot()); }
  }

  // ---------- guest: apply + interpolate ----------
  function applyFx(e) {
    if (e.f) state.floatingTexts.push({ x: e.f[0], y: e.f[1], text: e.f[2], color: e.f[3], size: e.f[4], life: 0.85, maxLife: 0.85 });
    if (e.n) notify(myTeam(), e.n[0], e.n[1], e.n[2]);
    if (e.w) state.particles.push({ type: 'shockwave', team: e.w[2], x: e.w[0], y: e.w[1], radius: 12, maxRadius: 120, life: 0.45, maxLife: 0.45 });
    if (e.s && sound[e.s]) sound[e.s]();
  }
  function guestFrame(dt) {
    // camera (same feel as the host)
    state.cameraY += (state.targetCameraY - state.cameraY) * (1 - Math.pow(0.85, dt * 60));
    clampCamera();
    updateEffects(dt);
    if (!snaps.length) return;
    const rt = performance.now() - INTERP_DELAY;
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].t <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
    }
    const k = b.t > a.t ? Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t))) : 1;
    const S = b.s, prev = new Map(a.s.u.map(u => [u[0], u]));
    state.units = S.u.map(u => {
      const p = prev.get(u[0]) || u;
      const w = (walk.get(u[0]) || Math.random() * 10) + dt * 8; walk.set(u[0], w);
      return {
        id: u[0], type: UT[u[1]], team: u[2] ? 'red' : 'blue',
        x: p[3] + (u[3] - p[3]) * k, y: p[4] + (u[4] - p[4]) * k,
        hp: u[5], lagHp: u[5], effectiveMaxHp: u[6], maxHp: u[6], flash: u[7] ? 0.05 : 0, radius: u[8],
        workerState: u[9] ? 'FLEEING' : 'TRAVEL', carriedGold: u[10], walkAnim: w, attackAnimTimer: 0, dead: false
      };
    });
    if (walk.size > 400) { const live = new Set(S.u.map(u => u[0])); [...walk.keys()].forEach(id => live.has(id) || walk.delete(id)); }
    state.projectiles = S.p.map(p => ({ type: PT[p[0]], team: p[1] ? 'red' : 'blue', x: p[2], y: p[3], targetX: p[4], targetY: p[5] }));
    ['blue', 'red'].forEach((t, i) => {
      const c = state.cores[t], v = S.co[i];
      c.hp = v[0]; c.flash = v[1] ? 0.05 : 0; c.pulse = v[2]; c.aimX = v[3]; c.aimY = v[4];
    });
    state.turretPads.forEach((pad, i) => {
      const v = S.tp[i];
      pad.turret = v ? { pad, team: pad.team, x: pad.x, y: pad.y, radius: 24, hp: v[0], lagHp: v[0], maxHp: v[1], charge: v[2],
        flash: v[3] ? 0.05 : 0, rotation: v[4], dead: false } : null;
    });
    state.gameTime = S.gt; state.waveCount = S.w; state.waveTimer = S.wt;
    state.blueGold = S.g[0]; state.redGold = S.g[1];
    state.blueCadence = S.c[0]; state.redCadence = S.c[1];
    state.playerNode = S.n[0]; state.aiNode = S.n[1];
    updateHUD();
    updateMiniMap();
    if (S.go && !state.gameOver) { state.gameOver = true; state.winner = S.go; showGameOver(S.go === myTeam()); }
  }

  // Forward combat sounds from the host simulation to the guest (purchase sounds are local)
  ['playSwordSlash', 'playArrowShoot', 'playMagicBurst', 'playHammerSlam', 'playShockwave', 'playHorn'].forEach(name => {
    const orig = sound[name].bind(sound);
    let last = 0;
    sound[name] = function () {
      orig();
      const now = performance.now();
      if (state.mode === 'host' && now - last > 60) { last = now; fx({ s: name }); }
    };
  });

  // ---------- QR ----------
  function showQR(elId, text) {
    const q = qrcode(0, 'L');
    q.addData(text, 'Byte');
    q.make();
    const n = q.getModuleCount();
    const cell = Math.max(2, Math.floor(224 / (n + 8)));
    $(elId).innerHTML = q.createSvgTag({ cellSize: cell, margin: cell * 4, scalable: true });
    const svg = $(elId).querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; }
  }
  let scanStream = null, scanRaf = 0;
  async function startScan(targetId, onDone) {
    const video = $('mp-video');
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) { status('Camera not available (' + e.name + '). Paste the code instead.'); return; }
    $('mp-scanner').classList.remove('hidden');
    video.srcObject = scanStream;
    await video.play().catch(() => {});
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    const loop = () => {
      if (!scanStream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const sc = Math.min(1, 720 / video.videoWidth);
        cv.width = video.videoWidth * sc; cv.height = video.videoHeight * sc;
        cx.drawImage(video, 0, 0, cv.width, cv.height);
        const img = cx.getImageData(0, 0, cv.width, cv.height);
        const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (hit && hit.data && hit.data.startsWith(CODE_PREFIX)) {
          stopScan(); $(targetId).value = hit.data; onDone && onDone(); return;
        }
      }
      scanRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
    $('mp-scanner').classList.add('hidden');
  }

  // ---------- UI ----------
  function showStep(name) {
    ['choose', 'host', 'guest'].forEach(n => $('mp-step-' + n).classList.toggle('hidden', n !== name));
  }
  function openMenu() {
    teardown(); role = null; status('');
    showStep('choose');
    $('mp-host-qr').textContent = 'Creating invite…'; $('mp-host-code').value = '';
    $('mp-answer-in').value = ''; $('mp-offer-in').value = '';
    $('mp-guest-answer').classList.add('hidden');
    $('modal-menu').classList.add('hidden');
    $('modal-mp').classList.remove('hidden');
  }
  function init() {
    if (!window.RTCPeerConnection) { $('btn-friend').disabled = true; $('btn-friend').textContent = 'Play vs Friend (not supported here)'; return; }
    $('btn-friend').addEventListener('click', openMenu);
    $('mp-back').addEventListener('click', () => { stopScan(); teardown(); role = null; $('modal-mp').classList.add('hidden'); $('modal-menu').classList.remove('hidden'); });
    $('mp-host').addEventListener('click', async () => {
      showStep('host'); status('Preparing invite…');
      try {
        const code = await hostCreate();
        $('mp-host-code').value = code; showQR('mp-host-qr', code);
        status('Waiting for your friend’s answer…');
      } catch (e) { status('Could not create invite: ' + e.message); }
    });
    $('mp-connect').addEventListener('click', async () => {
      try { await hostAccept($('mp-answer-in').value); status('Connecting…'); }
      catch (e) { status('Bad answer code: ' + e.message); }
    });
    $('mp-join').addEventListener('click', () => { showStep('guest'); status('Scan or paste the host’s invite.'); });
    $('mp-guest-go').addEventListener('click', async () => {
      status('Creating answer…');
      try {
        const code = await guestJoin($('mp-offer-in').value);
        $('mp-guest-code').value = code; showQR('mp-guest-qr', code);
        $('mp-guest-answer').classList.remove('hidden');
        status('Show this to the host. The game starts when they connect.');
      } catch (e) { status('Bad invite code: ' + e.message); }
    });
    document.querySelectorAll('.mp-scan').forEach(b => b.addEventListener('click', () => {
      const target = b.dataset.scan;
      startScan(target, () => (target === 'mp-answer-in' ? $('mp-connect') : $('mp-guest-go')).click());
    }));
    $('mp-scan-cancel').addEventListener('click', stopScan);
    document.querySelectorAll('.mp-copy').forEach(b => b.addEventListener('click', async () => {
      const ta = $(b.dataset.copy);
      try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copied'; }
      catch (e) { ta.select(); document.execCommand && document.execCommand('copy'); b.textContent = 'Copied'; }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    }));
    $('mpdrop-menu').addEventListener('click', () => { leave(); backToMenu(); });
  }
  init();

  // Test hook: plug in any message channel with the RTCDataChannel shape (send/close +
  // onopen/onclose/onmessage). Used by the headless test to relay between two browser contexts.
  function attachChannel(channel, asRole) { teardown(); leaving = false; role = asRole; wire(channel); }
  return { send, fx, hostTick, guestFrame, rematch, leave, pack, unpack,
           _debug: { hostCreate, hostAccept, guestJoin, attachChannel, get role() { return role; }, get open() { return open; } } };
})();
window.MP = MP;
