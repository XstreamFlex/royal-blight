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
  const status = t => { const el = $('mp-status'); if (el) el.textContent = t || ''; if (t) log('status: ' + t); };

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

  // ---------- debug log + visible status/errors ----------
  const LOG = [];
  const t0 = Date.now();
  function log(msg) {
    const line = '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's ' + msg;
    LOG.push(line); if (LOG.length > 400) LOG.shift();
    try { console.log('[MP] ' + msg); } catch (e) {}
  }
  function showError(msg) {
    log('ERROR: ' + msg);
    const el = $('mp-error'); if (!el) return;
    el.textContent = '⚠ ' + msg; el.classList.remove('hidden');
  }
  function clearError() { const el = $('mp-error'); if (el) { el.textContent = ''; el.classList.add('hidden'); } }
  const errMsg = e => (e && (e.name ? e.name + ': ' : '') + (e.message || e.type || String(e))) || 'unknown error';

  // Camera permission doubles as the key that makes iOS Safari expose real host IP candidates
  // (otherwise only mDNS ".local" names, which often fail between two iPhones). Kept alive until connected.
  let permStream = null;
  async function ensureCamera(why) {
    if (permStream && permStream.getTracks().some(t => t.readyState === 'live')) return permStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { log('getUserMedia unavailable (' + why + ')'); return null; }
    status('Starting camera…');
    try {
      permStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      log('camera granted (' + why + ')');
      return permStream;
    } catch (e) {
      log('camera refused (' + why + '): ' + errMsg(e));
      permStream = null; return null;
    }
  }
  function releaseCamera() {
    if (permStream) { permStream.getTracks().forEach(t => t.stop()); log('camera released'); }
    permStream = null;
  }

  function gatherDone(conn, ms = 3000) {
    return new Promise(res => {
      const counts = {};
      const done = why => { clearTimeout(t); log('ICE gathering ' + why + ': ' + JSON.stringify(counts)); res(counts); };
      conn.addEventListener('icecandidate', e => {
        if (!e.candidate || !e.candidate.candidate) return;
        const c = e.candidate.candidate.split(' ');
        const typ = c[7] || '?', ip = c[4] || '';
        const k = typ + (ip.endsWith('.local') ? '(mdns)' : '');
        counts[k] = (counts[k] || 0) + 1;
        const n = Object.values(counts).reduce((a, b) => a + b, 0);
        log('candidate ' + typ + ' ' + (ip.endsWith('.local') ? 'mdns' : ip) + ' ' + (c[2] || ''));
        status('Gathering network candidates (' + n + ')…');
      });
      if (conn.iceGatheringState === 'complete') return done('already complete');
      const t = setTimeout(() => done('timeout ' + ms + 'ms'), ms); // offline: STUN can't answer, go with what we have
      conn.addEventListener('icegatheringstatechange', () => {
        if (conn.iceGatheringState === 'complete') done('complete');
      });
    });
  }

  // ---------- connection ----------
  function newPC() {
    teardown();
    leaving = false;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    try { answerTaken = false; } catch (e) {}
    log('RTCPeerConnection created');
    pc.addEventListener('iceconnectionstatechange', () => {
      const st = pc && pc.iceConnectionState; log('ICE state: ' + st);
      if (!open && st) status('Connecting… (network: ' + st + ')');
      if (!open && st === 'failed') showError('Could not reach the other phone (ICE failed). Same Wi-Fi/hotspot? Try Online (room code) instead.');
    });
    pc.addEventListener('connectionstatechange', () => {
      const st = pc && pc.connectionState; log('connection state: ' + st);
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
      log('data channel open (' + role + ')');
      status('Connected!'); clearError();
      releaseCamera(); stopScan();
      if (role === 'host') startHostMatch();
    };
    dc.onclose = () => { log('data channel closed'); open = false; lost('The other phone disconnected.'); };
    dc.onerror = e => log('data channel error: ' + errMsg(e && e.error || e));
    dc.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.warn('MP message', err); } };
  }
  async function hostCreate() {
    role = 'host';
    await ensureCamera('host: expose host candidates');
    newPC();
    wire(pc.createDataChannel('rb', { ordered: true }));
    status('Creating invite…');
    await pc.setLocalDescription(await pc.createOffer());
    const counts = await gatherDone(pc);
    const code = pack(pc.localDescription.sdp, 'offer');
    log('invite ready: ' + code.length + ' chars');
    if (!Object.keys(counts).length) log('warning: no candidates gathered');
    return code;
  }
  async function hostAccept(code) {
    const d = unpack(code);
    if (d.type !== 'answer') throw new Error('That is an invite code, not an answer');
    if (!pc || role !== 'host') throw new Error('No invite is open on this phone. Tap Host first.');
    if (pc.signalingState === 'stable') { log('answer already applied'); return; }
    log('applying answer (' + code.length + ' chars)');
    await pc.setRemoteDescription(d);
    status('Connecting…');
  }
  async function guestJoin(code) {
    const d = unpack(code);
    if (d.type !== 'offer') throw new Error('That is an answer code, not an invite');
    role = 'guest';
    await ensureCamera('guest: expose host candidates'); // usually already live from scanning
    newPC();
    pc.ondatachannel = e => { log('data channel received'); wire(e.channel); };
    status('Creating answer…');
    await pc.setRemoteDescription(d);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherDone(pc);
    const ans = pack(pc.localDescription.sdp, 'answer');
    log('answer ready: ' + ans.length + ' chars');
    return ans;
  }
  function send(msg) {
    if (dc && open && (dc.bufferedAmount || 0) < 512 * 1024) dc.send(JSON.stringify(msg));
  }
  function teardown() {
    clearTimeout(dropTimer); dropTimer = null;
    open = false;
    try { if (dc) { dc.onclose = null; dc.close(); } } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    dc = null; pc = null; peer = null; snaps = []; fxQueue = []; walk.clear();
  }

  // ---------- Online mode: PeerJS cloud broker (signaling only), same message protocol ----------
  let peer = null;
  const ROOM_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const roomId = code => 'royalblight-' + code.toUpperCase();
  function adaptConn(conn) {
    // Give a PeerJS DataConnection the RTCDataChannel shape that wire() expects.
    const ch = { onopen: null, onclose: null, onmessage: null, onerror: null,
      get bufferedAmount() { return (conn.dataChannel && conn.dataChannel.bufferedAmount) || 0; },
      send: s => conn.send(s), close: () => conn.close() };
    conn.on('open', () => ch.onopen && ch.onopen());
    conn.on('data', d => ch.onmessage && ch.onmessage({ data: d }));
    conn.on('close', () => ch.onclose && ch.onclose());
    conn.on('error', e => ch.onerror && ch.onerror(e));
    return ch;
  }
  function onlineHost(tries = 0) {
    if (!window.Peer) throw new Error('Online library failed to load.');
    teardown(); leaving = false; role = 'host';
    const code = Array.from({ length: 5 }, () => ROOM_ABC[Math.floor(Math.random() * ROOM_ABC.length)]).join('');
    status('Contacting the online broker…');
    log('online host: requesting room ' + code);
    peer = new Peer(roomId(code), { debug: 1 });
    peer.on('open', id => { log('broker registered ' + id); $('mp-room-code').textContent = code; status('Room ready. Waiting for your friend to join…'); });
    peer.on('connection', conn => {
      if (dc) { log('extra connection refused'); conn.close(); return; }
      log('guest connecting via broker');
      status('Friend found, connecting…');
      wire(adaptConn(conn));
      watchIce(conn);
    });
    peer.on('disconnected', () => log('broker disconnected (match keeps running if already connected)'));
    peer.on('error', e => {
      log('peer error: ' + e.type + ' ' + (e.message || ''));
      if (e.type === 'unavailable-id' && tries < 4) return onlineHost(tries + 1);
      if (!open) showError(peerErr(e));
    });
  }
  function onlineJoin(code) {
    if (!window.Peer) throw new Error('Online library failed to load.');
    code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) throw new Error('Type the room code shown on the host phone.');
    teardown(); leaving = false; role = 'guest';
    status('Contacting the online broker…');
    log('online join: room ' + code);
    peer = new Peer({ debug: 1 });
    peer.on('open', id => {
      log('broker registered ' + id + ', connecting to room');
      status('Joining room ' + code + '…');
      const conn = peer.connect(roomId(code), { reliable: true, serialization: 'raw' });
      wire(adaptConn(conn));
      watchIce(conn);
      setTimeout(() => { if (!open && role === 'guest' && peer) showError('Still not connected after 20 s. Check both phones have internet, or try again.'); }, 20000);
    });
    peer.on('error', e => { log('peer error: ' + e.type + ' ' + (e.message || '')); if (!open) showError(peerErr(e, code)); });
  }
  function watchIce(conn) {
    const pcx = conn.peerConnection;
    if (!pcx) return;
    pcx.addEventListener('iceconnectionstatechange', () => { log('online ICE state: ' + pcx.iceConnectionState); if (!open) status('Connecting… (network: ' + pcx.iceConnectionState + ')'); });
  }
  function peerErr(e, code) {
    if (e.type === 'peer-unavailable') return 'Room ' + (code || '') + ' not found. Check the code, and keep the host on the room-code screen.';
    if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') return 'Can’t reach the online broker. Is this phone online?';
    if (e.type === 'browser-incompatible') return 'This browser does not support online play.';
    return 'Online error: ' + e.type + (e.message ? ' (' + e.message + ')' : '');
  }
  function leave() { releaseCamera(); leaving = true; send({ k: 'bye' }); setTimeout(teardown, 150); role = null; }
  function lost(msg) {
    if (leaving || !role) return;
    if (!state.started || (state.mode !== 'host' && state.mode !== 'guest')) { status(msg); return; }
    state.paused = true;
    $('mpdrop-msg').textContent = msg + ' The match is paused.';
    $('modal-mpdrop').classList.remove('hidden');
  }

  // ---------- match flow ----------
  function startHostMatch() {
    startMatch('host');   // host plays the army chosen on the main menu (SETTINGS.army)
    sendAcc = 1; // snapshot right away
    send({ k: 'start', team: myTeam() === 'blue' ? 'red' : 'blue', rules: state.rules });
  }
  function rematch() {
    const btn = $('btn-restart');
    if (role === 'host') startHostMatch();
    else { send({ k: 'rematch' }); btn.textContent = 'Waiting for host…'; btn.disabled = true; }
  }
  function onMessage(m) {
    if (m.k === 'bye') { lost('Your friend left the match.'); return; }
    if (role === 'host') {
      if (m.k === 'cmd') applyCommand(myTeam() === 'blue' ? 'red' : 'blue', m.c);
      else if (m.k === 'rematch' && state.gameOver) startHostMatch();
    } else {
      if (m.k === 'start') { snaps = []; walk.clear(); startMatch('guest', null, { team: m.team || 'red', rules: m.rules }); }
      else if (m.k === 's') {
        snaps.push({ t: performance.now(), s: m });
        if (snaps.length > 30) snaps.shift();
        (m.fx || []).forEach(applyFx);
      }
    }
  }

  // ---------- host: snapshots ----------
  const UT = ['pawn', 'archer', 'wizard', 'brute', 'worker', 'cavalier', 'acolyte'];
  const PT = ['arrow', 'fireball', 'turret_bolt', 'core_bolt', 'soulbolt'];
  const r1 = v => Math.round(v * 10) / 10;
  function fx(e) { if (state.mode === 'host' && open) { fxQueue.push(e); if (fxQueue.length > 120) fxQueue.shift(); } }
  function snapshot() {
    const core = c => [Math.ceil(c.hp), c.flash > 0 ? 1 : 0, r1(c.pulse || 0), r1(c.aimX || 0), r1(c.aimY || 0)];
    return {
      k: 's', gt: r1(state.gameTime), w: state.waveCount, wt: r1(state.waveTimer),
      g: [Math.floor(state.blueGold), Math.floor(state.redGold)],
      c: [state.blueCadence, state.redCadence], n: [state.playerNode, state.aiNode],
      nx: [spawnsAt('blue', state.waveCount + 1), spawnsAt('red', state.waveCount + 1)],
      u: state.units.filter(u => !u.dead).map(u => [u.id, UT.indexOf(u.type), u.team === 'blue' ? 0 : 1,
        Math.round(u.x), Math.round(u.y), Math.ceil(u.hp), u.effectiveMaxHp, u.flash > 0 ? 1 : 0, u.radius,
        u.type === 'worker' ? (u.workerState === 'FLEEING' ? 1 : 0) : u.type === 'cavalier' ? (u.chargeDir < 0 ? 1 : 0) : 0, u.carriedGold || 0]),
      p: state.projectiles.map(p => [PT.indexOf(p.type), p.team === 'blue' ? 0 : 1, Math.round(p.x), Math.round(p.y),
        Math.round(p.targetX || 0), Math.round(p.targetY || 0)]),
      co: [core(state.cores.blue), core(state.cores.red)],
      tp: state.turretPads.map(p => (p.turret && !p.turret.dead)
        ? [Math.ceil(p.turret.hp), p.turret.maxHp, p.turret.charge, p.turret.flash > 0 ? 1 : 0, r1(p.turret.rotation)] : 0),
      go: state.gameOver ? state.winner : 0, tu: state.timeUp ? 1 : 0,
      gm: state.goldMined ? [state.goldMined.blue, state.goldMined.red] : 0,
      sc: state.score ? [Math.floor(state.score.blue), Math.floor(state.score.red)] : 0,
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
        workerState: u[9] ? 'FLEEING' : 'TRAVEL', chargeDir: u[9] ? -1 : 1, carriedGold: u[10], walkAnim: w, attackAnimTimer: 0, dead: false
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
    state.blueCadence = S.c[0]; state.redCadence = S.c[1]; state.netNext = S.nx || null;
    state.playerNode = S.n[0]; state.aiNode = S.n[1];
    updateHUD();
    updateMiniMap();
    if (S.gm) state.goldMined = { blue: S.gm[0], red: S.gm[1] };
    if (S.sc) state.score = { blue: S.sc[0], red: S.sc[1] };
    if (S.tu) state.timeUp = true;
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
  // QR payload = a link to the game, so the iPhone Camera app can open it directly.
  const gameUrl = () => location.origin + location.pathname;
  const linkFor = (kind, code) => gameUrl() + '#' + kind + '=' + encodeURIComponent(code);
  function extractCode(text) {
    text = (text || '').trim();
    const m = text.match(/#(?:join|answer)=([^&\s]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    const i = text.indexOf(CODE_PREFIX);
    return i >= 0 ? text.slice(i).replace(/\s+/g, '') : text;
  }
  function showQR(elId, text) {
    const q = qrcode(0, 'L');
    q.addData(text, 'Byte');
    q.make();
    const n = q.getModuleCount();
    const cell = Math.max(2, Math.floor(224 / (n + 8)));
    $(elId).innerHTML = q.createSvgTag({ cellSize: cell, margin: cell * 4, scalable: true });
    const svg = $(elId).querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; }
    log('QR shown: ' + text.length + ' chars, ' + n + ' modules');
  }
  function beep() {
    try { navigator.vibrate && navigator.vibrate(80); } catch (e) {}
    try {
      const A = window.AudioContext || window.webkitAudioContext; const ac = new A();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 1320; g.gain.value = 0.15; o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.12); setTimeout(() => ac.close && ac.close(), 400);
    } catch (e) {}
  }
  let scanning = false, scanRaf = 0;
  const scanStatus = t => { const el = $('mp-scan-status'); if (el) el.textContent = t; log('scan: ' + t); };
  async function startScan(targetId, onDone) {
    clearError();
    const video = $('mp-video');
    $('mp-scanner').classList.remove('hidden');
    scanStatus('Starting camera…');
    const stream = await ensureCamera('scan');
    if (!stream) { $('mp-scanner').classList.add('hidden'); showError('Camera not available. Allow camera access in Settings › Safari › Camera, or paste the code instead.'); return; }
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.setAttribute('autoplay', '');
    video.muted = true; video.playsInline = true;
    video.srcObject = stream;
    if (!video.videoWidth) await new Promise(r => { video.onloadedmetadata = r; setTimeout(r, 3000); });
    try { await video.play(); } catch (e) { log('video.play failed: ' + errMsg(e)); }
    if (!video.videoWidth) { scanStatus('Camera started but shows no picture. Tap Cancel and paste the code.'); return; }
    scanStatus('Scanning… point at the QR code');
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    scanning = true;
    let frames = 0;
    const loop = () => {
      if (!scanning) return;
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          const sc = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
          const w = Math.round(video.videoWidth * sc), h = Math.round(video.videoHeight * sc);
          if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
          cx.drawImage(video, 0, 0, w, h);
          const img = cx.getImageData(0, 0, w, h);
          const hit = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
          frames++;
          if (frames % 60 === 0) log('scan frames ' + frames + ' (' + w + 'x' + h + ')');
          if (hit && hit.data) {
            const code = extractCode(hit.data);
            if (code.startsWith(CODE_PREFIX)) {
              scanning = false; beep();
              $('mp-scanner').classList.add('hidden'); video.srcObject = null;
              // keep the camera stream itself alive: it keeps real IP candidates exposed until connected
              $(targetId).value = code;
              status('Code scanned ✓ (' + code.length + ' chars)');
              log('decoded ' + code.length + ' chars');
              onDone && onDone();
              return;
            }
            scanStatus('That QR is not a Royal Blight code. Keep trying…');
          }
        }
      } catch (e) { log('scan frame error: ' + errMsg(e)); }
      scanRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopScan() {
    scanning = false;
    cancelAnimationFrame(scanRaf);
    const v = $('mp-video'); if (v) v.srcObject = null;
    $('mp-scanner').classList.add('hidden');
  }

  // ---------- UI ----------
  function showStep(name) {
    ['choose', 'host', 'guest', 'ohost'].forEach(n => $('mp-step-' + n).classList.toggle('hidden', n !== name));
  }
  function openMenu() {
    stopScan(); releaseCamera(); teardown(); role = null; status(''); clearError();
    showStep('choose');
    $('mp-host-qr').textContent = 'Creating invite…'; $('mp-host-code').value = '';
    $('mp-answer-in').value = ''; $('mp-offer-in').value = '';
    $('mp-guest-answer').classList.add('hidden');
    $('mp-room-code').textContent = '…';
    $('modal-menu').classList.add('hidden');
    $('modal-gameover').classList.add('hidden');
    $('modal-mp').classList.remove('hidden');
  }
  // Wrap every handler: errors become visible messages instead of silent failures.
  const guard = (label, fn) => async (...a) => {
    try { await fn(...a); } catch (e) { showError(label + ': ' + errMsg(e)); }
  };
  const doHost = guard('Could not create invite', async () => {
    showStep('host'); clearError();
    const code = await hostCreate();
    const link = linkFor('join', code);
    $('mp-host-code').value = link; showQR('mp-host-qr', link);
    status('Invite ready. Waiting for your friend’s answer…');
  });
  const doConnect = guard('Bad answer code', async () => {
    clearError();
    await hostAccept(extractCode($('mp-answer-in').value));
  });
  const doGuest = guard('Bad invite code', async () => {
    clearError();
    const code = await guestJoin(extractCode($('mp-offer-in').value));
    const link = linkFor('answer', code);
    $('mp-guest-code').value = link; showQR('mp-guest-qr', link);
    $('mp-guest-answer').classList.remove('hidden');
    status('Answer ready ✓ Host: tap “Scan answer QR”. The game starts when they connect.');
    setTimeout(() => $('mp-guest-answer').scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  });

  // Links opened from the iPhone Camera app (or pasted into the address bar).
  // #join=<invite>  -> straight into "Join" with the invite filled in, answer generated.
  // #answer=<answer> -> handed to the host tab that owns the invite (same browser), or applied here.
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('royal-blight-mp') : null;
  let answerTaken = false;
  function deliverAnswer(code, from) {
    log('answer received via ' + from);
    if (role === 'host' && pc && !open) {
      if (answerTaken || pc.signalingState !== 'have-local-offer') { log('duplicate answer ignored'); return true; }
      answerTaken = true;
      $('mp-answer-in').value = code; status('Answer received ✓'); doConnect();
      try { bc && bc.postMessage({ k: 'ack' }); } catch (e) {}
      return true;
    }
    return false;
  }
  if (bc) bc.onmessage = e => {
    const m = e.data || {};
    if (m.k === 'answer') deliverAnswer(m.code, 'other tab');
    if (m.k === 'ack') { status('Answer delivered ✓ Switch back to the tab with the game you are hosting.'); }
  };
  window.addEventListener('storage', e => { if (e.key === 'rb-answer' && e.newValue) { try { deliverAnswer(JSON.parse(e.newValue).code, 'storage'); } catch (er) {} } });
  function handleHash() {
    const h = location.hash || '';
    const m = h.match(/^#(join|answer)=(.+)$/);
    if (!m) return;
    let code; try { code = decodeURIComponent(m[2]); } catch (e) { code = m[2]; }
    history.replaceState(null, '', location.pathname + location.search);
    log('opened from link: ' + m[1] + ' (' + code.length + ' chars)');
    if (m[1] === 'join') {
      if (state.started && state.mode !== 'ai') { log('ignored join link: match running'); return; }
      openMenu(); showStep('guest');
      $('mp-offer-in').value = code;
      status('Invite received ✓ Allow the camera if asked (it helps the phones find each other).');
      doGuest();
    } else {
      if (deliverAnswer(code, 'link in this tab')) return;
      // Probably a new tab opened by the Camera app: pass it to the hosting tab.
      try { bc && bc.postMessage({ k: 'answer', code }); } catch (e) {}
      try { localStorage.setItem('rb-answer', JSON.stringify({ code, t: Date.now() })); } catch (e) {}
      openMenu();
      status('Answer sent to your hosting tab. Switch back to that tab. If nothing happens there, tap “Scan answer QR” in the game instead.');
    }
  }

  function init() {
    if (!window.RTCPeerConnection) { $('btn-friend').disabled = true; $('btn-friend').textContent = 'Play vs Friend (not supported here)'; return; }
    $('btn-friend').addEventListener('click', openMenu);
    $('mp-back').addEventListener('click', () => { stopScan(); releaseCamera(); teardown(); role = null; clearError(); $('modal-mp').classList.add('hidden'); $('modal-menu').classList.remove('hidden'); });
    $('mp-host').addEventListener('click', doHost);
    $('mp-connect').addEventListener('click', doConnect);
    $('mp-join').addEventListener('click', () => { clearError(); showStep('guest'); status('Scan or paste the host’s invite.'); });
    $('mp-guest-go').addEventListener('click', doGuest);
    $('mp-ohost').addEventListener('click', guard('Online room', async () => { clearError(); showStep('ohost'); onlineHost(); }));
    $('mp-ojoin').addEventListener('click', guard('Join room', async () => { clearError(); onlineJoin($('mp-room-in').value); }));
    $('mp-room-in').addEventListener('keydown', e => { if (e.key === 'Enter') $('mp-ojoin').click(); });
    document.querySelectorAll('.mp-scan').forEach(b => b.addEventListener('click', guard('Scanner', async () => {
      const target = b.dataset.scan;
      await startScan(target, target === 'mp-answer-in' ? doConnect : doGuest);
    })));
    $('mp-scan-cancel').addEventListener('click', () => { stopScan(); status('Scan cancelled.'); });
    document.querySelectorAll('.mp-copy').forEach(b => b.addEventListener('click', async () => {
      const ta = $(b.dataset.copy);
      try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copied'; }
      catch (e) { ta.select(); document.execCommand && document.execCommand('copy'); b.textContent = 'Copied'; }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    }));
    $('mp-copylog').addEventListener('click', async () => {
      const txt = 'Royal Blight MP log\n' + navigator.userAgent + '\nstandalone=' + !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches) + '\n' + LOG.join('\n');
      try { await navigator.clipboard.writeText(txt); $('mp-copylog').textContent = 'Log copied ✓'; }
      catch (e) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (er) {} ta.remove(); $('mp-copylog').textContent = 'Log copied ✓'; }
      setTimeout(() => ($('mp-copylog').textContent = 'Copy debug log'), 1800);
    });
    $('mpdrop-menu').addEventListener('click', () => { leave(); backToMenu(); });
    window.addEventListener('error', e => log('window error: ' + e.message));
    window.addEventListener('unhandledrejection', e => log('unhandled rejection: ' + errMsg(e.reason)));
    window.addEventListener('hashchange', handleHash);
    // Handle a link the app was opened with (Safari tab or Home Screen launch), once the engine is ready.
    setTimeout(handleHash, 0);
  }
  init();

  // Test hook: plug in any message channel with the RTCDataChannel shape (send/close +
  // onopen/onclose/onmessage). Used by the headless test to relay between two browser contexts.
  function attachChannel(channel, asRole) { teardown(); leaving = false; role = asRole; wire(channel); }
  return { send, fx, hostTick, guestFrame, rematch, leave, pack, unpack,
           _debug: { log: LOG, handleHash, onlineHost, onlineJoin, extractCode, hostCreate, hostAccept, guestJoin, attachChannel, get role() { return role; }, get open() { return open; } } };
})();
window.MP = MP;
