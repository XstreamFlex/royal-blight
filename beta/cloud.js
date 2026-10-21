// Royal Blight — optional Account / Cloud Save (v27+). The local save (localStorage) stays the source of truth;
// the cloud is only a backup/sync target while signed in. Everything here is best-effort and works offline.
(function () {
  'use strict';
  // ======== the ONE place to configure the API ========
  const RB_API_BASE = window.RB_API_BASE_OVERRIDE || 'https://xmg.xstreamflex.com/rbapi';
  // =====================================================
  const KEY = 'rb-cloud', AUTOSYNC_MS = 4000;
  const st = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })();
  // st: { token, user, version (last synced cloud version), syncedHash, lastSync, localTs, conflict }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };
  const S = () => window.Story;
  const h32 = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const localStr = () => (S() && S().exportSave) ? S().exportSave() : null;
  const isFresh = () => { const sv = S() && S().save && S().save(); return !sv || (!sv.xp && !sv.gold && !Object.keys(sv.missions || {}).length); };
  const dirty = () => { const l = localStr(); return !!l && h32(l) !== st.syncedHash; };
  let status = st.token ? 'idle' : 'signedout', busy = false, timer = null, msg = '';

  async function api(method, path, body) {
    const r = await fetch(RB_API_BASE + '/index.php?r=' + path, {
      method, mode: 'cors', cache: 'no-store', credentials: 'omit',
      headers: Object.assign({ 'Content-Type': 'application/json' }, st.token ? { Authorization: 'Bearer ' + st.token } : {}),
      body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && st.token && !/^(login|register)$/.test(path)) { signedOut('Session expired — please sign in again.'); }
    return { status: r.status, j: j || { ok: false, error: 'bad_response' } };
  }
  function signedOut(m) { delete st.token; delete st.user; st.version = 0; st.syncedHash = null; st.conflict = null; save(); status = 'signedout'; msg = m || ''; render(); }
  function markSynced(version, ts) { st.version = version; st.syncedHash = h32(localStr() || ''); st.lastSync = Date.now(); st.localTs = ts; st.conflict = null; save(); status = 'synced'; }
  function applyCloud(sv) {
    const r = S().importSave(sv.data);
    if (r !== true) { status = 'error'; msg = 'Cloud save could not be loaded: ' + r; return false; }
    markSynced(sv.version, sv.updatedAt);
    try { const scr = document.getElementById('story-screen') || document.getElementById('screen-story'); if (scr && !scr.classList.contains('hidden')) S().openMap(); } catch (e) {}
    return true;
  }
  async function push(force) {
    const data = localStr(); if (!data) return;
    const ts = st.localTs || Date.now();
    const { status: s, j } = await api('PUT', 'save', { data, baseVersion: st.version | 0, updatedAt: ts, force: !!force });
    if (s === 200) { markSynced(j.save.version, j.save.updatedAt); if (j.conflict) msg = 'Replaced an older cloud copy (newest wins).'; }
    else if (s === 409) { st.conflict = j.save; save(); status = 'conflict'; }
    else throw new Error(j.error || 'http ' + s);
  }

  // Main sync step. Decides pull / push / conflict from (cloud version vs. last synced version) x (local dirty?).
  async function sync(reason) {
    if (!st.token || busy || !S()) return render();
    if (!navigator.onLine) { status = 'offline'; return render(); }
    busy = true; status = 'syncing'; render();
    try {
      const g = await api('GET', 'save');
      if (g.status !== 200) throw new Error(g.j.error || 'http ' + g.status);
      const cloud = g.j.save, ld = dirty();
      if (!cloud) await push(false);
      else if (cloud.version === (st.version | 0)) { if (ld) await push(false); else status = 'synced', st.lastSync = Date.now(), save(); }
      else if (!ld || (isFresh() && !st.syncedHash)) applyCloud(cloud);           // cloud moved on, local untouched: pull
      else if (h32(cloud.data) === h32(localStr())) markSynced(cloud.version, cloud.updatedAt);
      else { st.conflict = cloud; save(); status = 'conflict'; }                     // both changed: ask the player
    } catch (e) { status = navigator.onLine ? 'error' : 'offline'; msg = status === 'error' ? 'Sync failed (' + (e.message || 'network') + '). Your local save is safe.' : ''; }
    busy = false; render();
  }
  async function resolve(choice) {   // 'local' | 'cloud' | 'newest'
    const c = st.conflict; if (!c) return;
    if (choice === 'newest') choice = (st.localTs || 0) >= (c.updatedAt || 0) ? 'local' : 'cloud';
    busy = true; status = 'syncing'; render();
    try { if (choice === 'cloud') applyCloud(c); else { st.version = c.version; await push(true); } msg = choice === 'cloud' ? 'Loaded the cloud save.' : 'Uploaded this device\'s save.'; }
    catch (e) { status = 'error'; msg = 'Sync failed. Your local save is safe.'; }
    busy = false; render();
  }

  // ------------------------------------------------------------ hooks: local save changes -> debounced autosync
  function onLocalChange() {
    if (!dirty()) return;   // e.g. our own cloud import
    st.localTs = Date.now(); save();
    if (!st.token) return;
    status = 'pending'; render();
    clearTimeout(timer); timer = setTimeout(() => sync('autosave'), AUTOSYNC_MS);
  }
  function wrapPersist() {   // story.js calls persist() via setDiff / mission end; we observe localStorage writes of its key
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { const r = orig.apply(this, arguments); if (this === window.localStorage && k === 'royalBlight.story') setTimeout(onLocalChange, 0); return r; };
  }

  // ------------------------------------------------------------ UI
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString(); };
  const LABEL = { signedout: 'Not signed in — saves stay on this device', idle: 'Signed in', syncing: 'Syncing…', synced: 'Synced ✓', pending: 'Changes waiting to sync', offline: 'Offline — will sync when back online', error: 'Sync error', conflict: '⚠ Cloud and device saves differ' };
  const btn = (id, txt, cls) => `<button id="${id}" class="w-full py-2 rounded-lg font-black text-xs uppercase active:scale-95 ${cls || 'bg-slate-700 text-slate-100'}">${txt}</button>`;
  const inp = (id, type, ph, ac) => `<input id="${id}" type="${type}" placeholder="${ph}" autocomplete="${ac}" class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-slate-100 text-sm" maxlength="200">`;
  let modal = null;
  function render() {
    const badge = document.getElementById('cloud-summary');
    if (badge) badge.textContent = st.token ? '(' + (LABEL[status] || '').replace(/ —.*/, '') + ')' : '(off)';
    if (!modal || modal.classList.contains('hidden')) return;
    const u = st.user || {}, c = st.conflict;
    let html = `<div class="text-[11px] font-bold ${status === 'conflict' || status === 'error' ? 'text-amber-300' : 'text-slate-300'}">${esc(LABEL[status] || status)}</div>`;
    if (msg) html += `<div class="text-[10px] text-slate-400">${esc(msg)}</div>`;
    if (!st.token) {
      html += inp('cl-login', 'text', 'Email or username', 'username') + inp('cl-pass', 'password', 'Password (8+ characters)', 'current-password') +
        `<div class="grid grid-cols-2 gap-2">${btn('cl-signin', 'Sign in', 'bg-amber-500 text-slate-950')}${btn('cl-signup', 'Create account')}</div>` +
        `<p class="text-[10px] text-slate-400 leading-snug">Optional. Back up your Story progress and continue on another device. Without an account everything stays on this device.</p>`;
    } else {
      html += `<div class="text-xs text-slate-100">Account: <b>${esc(u.email || u.username || 'device account')}</b></div>` +
        `<div class="text-[10px] text-slate-400">Last sync: ${esc(ago(st.lastSync))} · cloud version ${st.version | 0}</div>`;
      if (c) html += `<div class="rounded-lg border border-amber-500/60 p-2 space-y-2"><div class="text-[10px] text-slate-200 leading-snug">This device: changed ${esc(ago(st.localTs))}.<br>Cloud: saved ${esc(ago(c.updatedAt))} (version ${c.version}).</div>` +
        btn('cl-newest', 'Keep newest', 'bg-amber-500 text-slate-950') + `<div class="grid grid-cols-2 gap-2">${btn('cl-keeplocal', 'Keep this device')}${btn('cl-keepcloud', 'Keep cloud')}</div></div>`;
      else html += btn('cl-sync', 'Sync now', 'bg-amber-500 text-slate-950');
      html += `<details class="text-left"><summary class="text-[10px] text-slate-400 cursor-pointer">Account options</summary><div class="space-y-2 mt-2">` +
        inp('cl-cur', 'password', 'Current password', 'current-password') + inp('cl-new', 'password', 'New password', 'new-password') + btn('cl-chpw', 'Change password') +
        btn('cl-logout', 'Sign out (keeps local save)') + btn('cl-del', 'Delete account + cloud save', 'bg-red-800 text-white') + `</div></details>`;
    }
    modal.querySelector('#cl-body').innerHTML = html;
    const on = (id, f) => { const e = modal.querySelector('#' + id); if (e) e.onclick = f; };
    const val = id => (modal.querySelector('#' + id) || {}).value || '';
    const auth = async path => {
      const login = val('cl-login').trim(), password = val('cl-pass');
      if (!login || password.length < 8) { msg = 'Enter email/username and a password of 8+ characters.'; return render(); }
      if (!navigator.onLine) { msg = 'You are offline.'; return render(); }
      const body = path === 'login' ? { login, password } : (login.includes('@') ? { email: login, password } : { username: login, password });
      try {
        const { status: s, j } = await api('POST', path, body);
        if (j.ok) { st.token = j.token; st.user = j.user; st.version = 0; st.syncedHash = null; save(); msg = ''; status = 'idle'; sync('signin'); }
        else msg = ({ invalid_credentials: 'Wrong email/username or password.', account_exists: 'That account already exists — sign in instead.', rate_limited: 'Too many attempts, try again later.', invalid_username: 'Username: 3-24 letters, numbers, _ . -', invalid_email: 'That email looks invalid.', invalid_password: 'Password must be 8+ characters.' })[j.error] || 'Error: ' + j.error;
      } catch (e) { msg = 'Could not reach the server.'; }
      render();
    };
    on('cl-signin', () => auth('login')); on('cl-signup', () => auth('register'));
    on('cl-sync', () => sync('manual'));
    on('cl-newest', () => resolve('newest')); on('cl-keeplocal', () => resolve('local')); on('cl-keepcloud', () => resolve('cloud'));
    on('cl-logout', async () => { try { await api('POST', 'logout'); } catch (e) {} signedOut('Signed out. Your progress stays on this device.'); });
    on('cl-chpw', async () => {
      try { const { j } = await api('POST', 'password', { currentPassword: val('cl-cur'), newPassword: val('cl-new') });
        msg = j.ok ? 'Password changed (other devices signed out).' : ({ invalid_credentials: 'Current password is wrong.', invalid_password: 'New password must be 8+ characters.' })[j.error] || 'Error: ' + j.error; } catch (e) { msg = 'Could not reach the server.'; }
      render();
    });
    on('cl-del', async () => {
      if (!confirm('Delete your account and cloud save? Your progress on THIS device is kept.')) return;
      const password = st.user && st.user.anonymous ? '' : prompt('Enter your password to confirm:');
      if (password === null) return;
      try { const { j } = await api('DELETE', 'account', { password, confirm: 'DELETE' }); if (j.ok) return signedOut('Account deleted. Local save kept.'); msg = j.error === 'invalid_credentials' ? 'Wrong password.' : 'Error: ' + j.error; } catch (e) { msg = 'Could not reach the server.'; }
      render();
    });
  }
  function buildUI() {
    const settings = document.getElementById('modal-settings'), done = document.getElementById('settings-done');
    if (!settings || !done) return;
    const b = document.createElement('button');
    b.id = 'btn-cloud'; b.className = 'w-full max-w-xs mt-3 py-2 rounded-xl bg-slate-700 text-slate-100 font-black text-xs uppercase tracking-wider active:scale-95';
    b.innerHTML = '☁️ Account / Cloud Save <span id="cloud-summary" class="normal-case font-bold text-[10px] text-slate-300"></span>';
    settings.insertBefore(b, done);
    modal = document.createElement('div');
    modal.id = 'modal-cloud'; modal.className = 'hidden absolute inset-0 z-[57] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center';
    modal.innerHTML = '<h2 class="text-2xl font-black text-amber-300 uppercase tracking-wider mb-3">Cloud Save</h2>' +
      '<div id="cl-body" class="w-full max-w-xs bg-slate-800/90 rounded-xl p-3 border border-slate-700 space-y-2 text-left"></div>' +
      '<button id="cloud-done" class="w-full max-w-xs mt-4 py-3 rounded-xl bg-amber-500 text-slate-950 font-black text-sm uppercase">Done</button>';
    settings.parentNode.appendChild(modal);
    b.onclick = () => { modal.classList.remove('hidden'); msg = ''; render(); sync('open'); };
    modal.querySelector('#cloud-done').onclick = () => modal.classList.add('hidden');
    render();
  }

  window.Cloud = { sync, resolve, state: () => Object.assign({ status }, st, { token: st.token ? '***' : null }), API: RB_API_BASE };
  wrapPersist();
  const init = () => { buildUI(); if (st.token) sync('startup'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.addEventListener('online', () => sync('online'));
  window.addEventListener('offline', () => { if (st.token) { status = 'offline'; render(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && st.token && (dirty() || Date.now() - (st.lastSync || 0) > 60000)) sync('resume'); });
})();
