// Vitrine web app — no build step, no dependencies.
'use strict';

const $ = (s, root = document) => root.querySelector(s);

/* ---------- DOM helper ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'icon') el.append(icon(v));
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M18 5l2 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  note: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  pin: '<path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
};
function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}
for (const el of document.querySelectorAll('[data-icon]')) el.prepend(icon(el.dataset.icon));

/* ---------- API ---------- */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function api(method, path, body, raw) {
  const headers = { 'X-Vitrine': '1' };
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.retryAfter = Number(data.retryAfter) || 0;
    throw err;
  }
  return data;
}

function toast(msg, kind = 'success') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'info' : 'check'), h('span', { text: msg }),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', icon: 'close', onclick: () => el.remove() }));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 2600);
}
function apiError(e) {
  if (e && e.status === 401) { navigate('/login', true); return; }
  toast(e && e.message ? e.message : String(e), 'error');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/* ---------- formatting ---------- */
const LOCALE = document.documentElement.lang || 'en';
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
function ago(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString(LOCALE);
}
const fmtDate = (iso) => new Date(iso).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
function fmtBytes(n) {
  if (typeof n !== 'number') return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function fileKind(name) {
  const n = String(name || '').toLowerCase();
  if (/\.html?$/.test(n)) return 'html';
  if (/\.(md|markdown)$/.test(n)) return 'markdown';
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/.test(n)) return 'image';
  if (/\.(txt|log|json|csv|tsv|ya?ml|xml|css|js|sh|py|ts|go|sql)$/.test(n)) return 'text';
  return 'other';
}
const KIND_LABEL = { html: 'HTML', markdown: 'MD', pdf: 'PDF', image: 'IMG', text: 'TXT', other: 'FILE' };
const fileUrl = (base, name) => base + name.split('/').map(encodeURIComponent).join('/');
const viewSrc = (base, name) => fileUrl(base, name) + (fileKind(name) === 'markdown' ? '?view=1' : '');
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
const TTLS = [['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const VIEW_LIMITS = [[0, 'Unlimited'], [1, '1 viewer'], [5, '5'], [25, '25']];

/* ---------- state & routing ---------- */
const state = { me: null, artifacts: [], tags: {}, tag: '', q: '', layout: 'grid' };
try { if (localStorage.getItem('vitrine.layout') === 'rows') state.layout = 'rows'; } catch { /* private mode */ }
let viewer = null;
let pollTimer = null;
const SCREENS = ['setup', 'login', 'gallery', 'detail', 'settings'];

function show(name) {
  for (const s of SCREENS) $(`#view-${s}`).hidden = s !== name;
  if (name !== 'detail') { viewer = null; clearInterval(pollTimer); $('#view-detail').textContent = ''; }
  document.title = state.me ? state.me.name : document.title;
}

function navigate(path, replace) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

async function route() {
  try { state.me = await api('GET', '/api/me'); } catch (e) { toast(e.message, 'error'); return; }
  const p = location.pathname;
  if (state.me.needsSetup) {
    show('setup');
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    if (code) $('#setup-code').value = code;
    setTimeout(() => $(code ? '#setup-pw' : '#setup-code').focus(), 0);
    return;
  }
  if (!state.me.authenticated) {
    if (p !== '/login') history.replaceState({ next: p }, '', '/login');
    show('login');
    setTimeout(() => $('#pw').focus(), 0);
    return;
  }
  const m = p.match(/^\/a\/([a-z0-9]+)$/);
  if (m) return openViewer(m[1]);
  if (p === '/settings') return openSettings();
  if (p !== '/') history.replaceState(null, '', '/');
  show('gallery');
  loadGallery();
}

/* ---------- auth screens ---------- */
function formError(sel, msg) { const el = $(sel); el.textContent = msg || ''; el.hidden = !msg; }

$('#setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError('#setup-error', '');
  try {
    await api('POST', '/api/auth/setup', { code: $('#setup-code').value.trim(), password: $('#setup-pw').value });
    history.replaceState(null, '', '/settings');
    toast('Vault created. Add a passkey and connect your agent.');
    route();
  } catch (e) { formError('#setup-error', e.message); }
});

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError('#login-error', '');
  try {
    await api('POST', '/api/auth/login', { password: $('#pw').value });
    $('#pw').value = '';
    afterLogin();
  } catch (e) {
    formError('#login-error', e.status === 429 ? `Too many attempts. Try again in ${Math.ceil(e.retryAfter / 60)} min.` : e.message);
  }
});

$('#pk-login').addEventListener('click', async () => {
  formError('#login-error', '');
  try {
    const b = await api('POST', '/api/auth/passkey/login/begin', {});
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: unb64u(b.challenge), rpId: b.rpId, userVerification: 'required',
      allowCredentials: b.allowCredentials.map((c) => ({ type: c.type, id: unb64u(c.id) })) } });
    const r = cred.response;
    await api('POST', '/api/auth/passkey/login/finish', {
      challengeId: b.challengeId, credentialId: cred.id, authenticatorData: b64u(r.authenticatorData),
      clientDataJSON: b64u(r.clientDataJSON), signature: b64u(r.signature) });
    afterLogin();
  } catch (e) {
    formError('#login-error', e && e.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled.' : (e.message || String(e)));
  }
});

function afterLogin() {
  const next = (history.state && history.state.next) || '/';
  history.replaceState(null, '', next === '/login' ? '/' : next);
  route();
}

async function registerPasskey(name) {
  const b = await api('POST', '/api/passkeys/begin', {});
  const c = await navigator.credentials.create({ publicKey: {
    challenge: unb64u(b.challenge), rp: b.rp,
    user: { id: unb64u(b.user.id), name: b.user.name, displayName: b.user.displayName },
    pubKeyCredParams: b.pubKeyCredParams, attestation: 'none', authenticatorSelection: b.authenticatorSelection,
    excludeCredentials: (b.excludeCredentials || []).map((x) => ({ type: x.type, id: unb64u(x.id) })) } });
  const r = c.response;
  await api('POST', '/api/passkeys/finish', {
    challengeId: b.challengeId, credentialId: c.id, name,
    authenticatorData: b64u(r.getAuthenticatorData ? r.getAuthenticatorData() : r.authenticatorData),
    clientDataJSON: b64u(r.clientDataJSON) });
}

/* ---------- gallery ---------- */
async function loadGallery() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.tag) p.set('tag', state.tag);
  try {
    const data = await api('GET', `/api/artifacts?${p}`);
    state.artifacts = data.artifacts;
    state.tags = data.tags || {};
    renderGallery();
  } catch (e) { apiError(e); }
}

function renderGallery() {
  $('#view-grid').classList.toggle('active', state.layout === 'grid');
  $('#view-rows').classList.toggle('active', state.layout === 'rows');
  const total = Object.keys(state.tags).length;
  const chips = $('#tag-chips');
  chips.textContent = '';
  chips.hidden = total === 0;
  const chip = (value, label, count) => h('button', {
    type: 'button', class: 'chip' + (state.tag === value ? ' active' : ''),
    onclick: () => { state.tag = value; loadGallery(); },
  }, label, count === undefined ? null : h('span', { class: 'chip-count', text: String(count) }));
  chips.append(chip('', 'All'));
  for (const [t, n] of Object.entries(state.tags).sort((a, b) => b[1] - a[1])) chips.append(chip(t, `#${t}`, n));

  $('#gallery-title').textContent = state.tag ? `#${state.tag}` : 'Artifacts';
  $('#gallery-count').textContent = String(state.artifacts.length);
  const box = $('#gallery-items');
  box.textContent = '';
  if (!state.artifacts.length) {
    const filtered = state.q || state.tag;
    box.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-art', icon: filtered ? 'search' : 'bot' }),
      h('h2', { text: filtered ? 'Nothing matches' : 'No artifacts yet' }),
      filtered
        ? h('button', { class: 'btn', type: 'button', text: 'Clear filters', onclick: () => { state.q = ''; state.tag = ''; $('#search').value = ''; loadGallery(); } })
        : h('p', { class: 'muted' }, 'Drop an HTML, Markdown or PDF file here, or ', h('a', { href: '/settings', 'data-link': '', text: 'connect your AI agent' }), ' and ask it to publish.')));
    return;
  }
  box.append(h('div', { class: `cards ${state.layout}` }, state.artifacts.map(state.layout === 'grid' ? cardEl : rowEl)));
  observeThumbs();
}

function thumbEl(a) {
  const kind = fileKind(a.entry);
  const box = h('div', { class: `thumb kind-${kind}` });
  if (kind === 'html' || kind === 'markdown') {
    box.append(h('iframe', { src: viewSrc(a.viewBase, a.entry), loading: 'lazy', tabindex: '-1', 'aria-hidden': 'true',
      sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', scrolling: 'no', title: '' }));
  } else if (kind === 'image') {
    box.append(h('img', { src: fileUrl(a.viewBase, a.entry), alt: '', loading: 'lazy' }));
  } else {
    box.append(h('div', { class: 'thumb-file' }, icon('file'), h('span', { text: KIND_LABEL[kind] })));
  }
  return box;
}

function flags(a) {
  return [
    a.pinned ? h('span', { class: 'flag', title: 'Pinned', icon: 'pin' }) : null,
    a.note ? h('span', { class: 'flag', title: 'Has a private note', icon: 'note' }) : null,
    a.activeShares ? h('span', { class: 'flag shared', title: `${a.activeShares} public link(s) active`, icon: 'globe' }) : null,
  ];
}

function cardEl(a) {
  return h('a', { class: 'card', href: `/a/${a.id}`, 'data-link': '' },
    thumbEl(a),
    h('div', { class: 'card-body' },
      h('h3', { text: a.title }),
      h('div', { class: 'card-meta' },
        h('span', { class: `kind-pill kind-${fileKind(a.entry)}`, text: KIND_LABEL[fileKind(a.entry)] }),
        ...a.tags.slice(0, 2).map((t) => h('span', { class: 'badge', text: t })),
        h('span', { class: 'spacer' }), flags(a)),
      h('div', { class: 'card-sub', text: `${ago(a.updatedAt)}${a.version > 1 ? ` · v${a.version}` : ''} · ${fmtBytes(a.size)}` })));
}

function rowEl(a) {
  return h('a', { class: 'row', href: `/a/${a.id}`, 'data-link': '' },
    h('span', { class: `kind-pill kind-${fileKind(a.entry)}`, text: KIND_LABEL[fileKind(a.entry)] }),
    h('span', { class: 'row-title', text: a.title }),
    h('span', { class: 'row-badges' }, a.tags.slice(0, 3).map((t) => h('span', { class: 'badge', text: t }))),
    flags(a),
    h('span', { class: 'row-time', text: `${ago(a.updatedAt)}${a.version > 1 ? ` · v${a.version}` : ''}` }));
}

/* Thumbnails render the page at 1280px and scale it to the card. */
const thumbObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const f = e.target.querySelector('iframe');
    if (f) f.style.transform = `scale(${e.contentRect.width / 1280})`;
  }
});
function observeThumbs() {
  thumbObserver.disconnect();
  for (const t of document.querySelectorAll('.thumb')) if (t.querySelector('iframe')) thumbObserver.observe(t);
}

$('#view-rows').addEventListener('click', () => setLayout('rows'));
$('#view-grid').addEventListener('click', () => setLayout('grid'));
function setLayout(v) {
  state.layout = v;
  try { localStorage.setItem('vitrine.layout', v); } catch { /* private mode */ }
  renderGallery();
}
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadGallery(); }, 180);
});

/* ---------- upload ---------- */
let uploadTarget = null; // artifact id when uploading a new version
$('#upload-btn').addEventListener('click', () => { uploadTarget = null; $('#file-input').click(); });
$('#file-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) upload(files, uploadTarget);
});

async function upload(files, id) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.relPath || f.name);
  toast(`Uploading ${files.length} file(s)…`);
  try {
    const a = await api('POST', id ? `/api/artifacts/${id}/versions` : '/api/artifacts', undefined, fd);
    toast(id ? `Published v${a.version}` : `Published “${a.title}”`);
    if (id && viewer) { viewer.artifact = a; viewer.version = 0; viewer.file = null; renderViewer(); }
    else navigate(`/a/${a.id}`);
  } catch (e) { apiError(e); }
}

/* Drag and drop: files or a whole folder. */
const dropzone = $('#dropzone');
let dragDepth = 0;
const dropActive = () => !$('#view-gallery').hidden || (viewer && !$('#view-detail').hidden);
window.addEventListener('dragenter', (e) => {
  if (!dropActive() || !e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  dropzone.hidden = false;
  $('#dropzone p').textContent = viewer ? 'Drop files to publish a new version' : 'Drop files to publish a new artifact';
  if (viewer && !dropzone.isConnected) document.body.append(dropzone);
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropzone.hidden = true; } });
window.addEventListener('dragover', (e) => { if (dropActive()) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!dropActive()) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;
  const files = await droppedFiles(e.dataTransfer);
  if (files.length) upload(files, viewer ? viewer.artifact.id : null);
});
document.body.append(dropzone);

async function droppedFiles(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      f.relPath = prefix + f.name;
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) if (!child.name.startsWith('.')) await walk(child, prefix + entry.name + '/');
      } while (batch.length);
    }
  };
  // A single dropped folder becomes the artifact root.
  if (entries.length === 1 && entries[0].isDirectory) {
    const reader = entries[0].createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) if (!child.name.startsWith('.')) await walk(child, '');
    } while (batch.length);
  } else {
    for (const entry of entries) await walk(entry, '');
  }
  return out;
}

/* ---------- viewer ---------- */
async function openViewer(id) {
  let a;
  try { a = await api('GET', `/api/artifacts/${id}`); } catch (e) {
    if (e.status === 404) { toast('Artifact not found', 'error'); navigate('/', true); } else apiError(e);
    return;
  }
  show('detail');
  viewer = { artifact: a, version: 0, file: null, drawer: null };
  renderViewer();
  clearInterval(pollTimer);
  pollTimer = setInterval(pollViewer, 4000);
}

function currentVersion() {
  const a = viewer.artifact;
  return a.versions.find((v) => v.n === (viewer.version || a.version)) || a.versions[0];
}

/* Live reload: when an agent publishes a new version, refresh in place. */
async function pollViewer() {
  if (!viewer || document.hidden) return;
  try {
    const a = await api('GET', `/api/artifacts/${viewer.artifact.id}`);
    if (!viewer || a.id !== viewer.artifact.id) return;
    const newer = a.version > viewer.artifact.version;
    viewer.artifact = a;
    if (newer && !viewer.version) {
      viewer.file = null;
      renderViewer();
      toast(`Updated to v${a.version}`);
    }
  } catch (e) { if (e.status === 404) navigate('/', true); }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && viewer) pollViewer(); });

function renderViewer() {
  const a = viewer.artifact;
  const v = currentVersion();
  if (!viewer.file || !v.files.some((f) => f.name === viewer.file)) viewer.file = v.entry;
  document.title = `${a.title} · ${state.me.name}`;
  const root = $('#view-detail');
  root.textContent = '';

  const versionSelect = a.versions.length > 1 ? h('select', {
    class: 'compact-select', 'aria-label': 'Version',
    onchange: (e) => { viewer.version = Number(e.target.value); viewer.file = null; renderViewer(); },
  }, a.versions.map((x) => h('option', { value: x.n === a.version ? '0' : String(x.n), text: `v${x.n}${x.n === a.version ? ' (latest)' : ''}`, selected: x.n === v.n }))) : null;
  const fileSelect = v.files.length > 1 ? h('select', {
    class: 'compact-select file-select', 'aria-label': 'File',
    onchange: (e) => { viewer.file = e.target.value; paintStage(); },
  }, v.files.map((f) => h('option', { value: f.name, text: f.name, selected: f.name === viewer.file }))) : null;

  viewer.openLink = h('a', { class: 'icon-btn hide-sm', target: '_blank', rel: 'noopener', title: 'Open in new tab', 'aria-label': 'Open in new tab', icon: 'external' });
  viewer.downloadLink = h('a', { class: 'icon-btn', title: 'Download', 'aria-label': 'Download', icon: 'download' });

  root.append(
    h('header', { class: 'bar' },
      h('a', { class: 'icon-btn', href: '/', 'data-link': '', title: 'Back (Esc)', 'aria-label': 'Back to gallery', icon: 'back' }),
      h('div', { class: 'bar-title' },
        h('h1', { text: a.title, title: a.title }),
        h('p', { class: 'muted', text: `${v.n === a.version ? 'Updated' : `v${v.n} ·`} ${ago(v.createdAt)}` })),
      h('div', { class: 'bar-actions' },
        versionSelect, fileSelect,
        h('button', { class: 'icon-btn', type: 'button', title: 'Copy private link', 'aria-label': 'Copy private link', icon: 'link',
          onclick: async () => toast(await copyText(a.url) ? 'Private link copied (login required)' : 'Copy failed') }),
        viewer.openLink, viewer.downloadLink,
        h('button', { class: 'icon-btn', type: 'button', id: 'btn-info', title: 'Details (i)', 'aria-label': 'Details', icon: 'info', onclick: () => toggleDrawer('info') }),
        h('button', { class: 'btn primary', type: 'button', id: 'btn-share', onclick: () => toggleDrawer('share') }, icon('share'), h('span', { class: 'hide-sm', text: 'Share' })))),
    h('div', { class: 'viewer-body' },
      h('main', { class: 'stage', id: 'stage' }),
      h('aside', { class: 'drawer', id: 'drawer', hidden: true, 'aria-label': 'Artifact details' })));
  paintStage();
  paintDrawer();
}

function paintStage() {
  const a = viewer.artifact;
  const v = currentVersion();
  const name = viewer.file;
  const kind = fileKind(name);
  const stage = $('#stage');
  stage.textContent = '';
  viewer.openLink.href = viewSrc(v.viewBase, name);
  viewer.downloadLink.href = `/api/artifacts/${a.id}/download/${name.split('/').map(encodeURIComponent).join('/')}?v=${v.n}`;
  if (kind === 'html' || kind === 'markdown') stage.append(h('iframe', { src: viewSrc(v.viewBase, name), sandbox: SANDBOX, referrerpolicy: 'no-referrer', title: a.title }));
  else if (kind === 'pdf' || kind === 'text') stage.append(h('iframe', { src: fileUrl(v.viewBase, name), referrerpolicy: 'no-referrer', title: a.title, class: kind === 'text' ? 'text-frame' : '' }));
  else if (kind === 'image') stage.append(h('div', { class: 'stage-image' }, h('img', { src: fileUrl(v.viewBase, name), alt: a.title })));
  else {
    const f = v.files.find((x) => x.name === name);
    stage.append(h('div', { class: 'stage-empty' },
      h('div', { class: 'empty-art', icon: 'file' }), h('h2', { text: name }),
      h('p', { class: 'muted', text: `${fmtBytes(f && f.size)} · no preview for this file type` }),
      h('a', { class: 'btn primary', href: viewer.downloadLink.href }, icon('download'), 'Download')));
  }
}

function toggleDrawer(tab) { viewer.drawer = viewer.drawer === tab ? null : tab; paintDrawer(); }

function paintDrawer() {
  const drawer = $('#drawer');
  drawer.textContent = '';
  drawer.hidden = !viewer.drawer;
  $('#btn-info').classList.toggle('active', viewer.drawer === 'info');
  $('#btn-share').classList.toggle('active', viewer.drawer === 'share');
  if (!viewer.drawer) return;
  const tab = (id, label) => h('button', { type: 'button', role: 'tab', class: viewer.drawer === id ? 'active' : '',
    'aria-selected': String(viewer.drawer === id), onclick: () => { viewer.drawer = id; paintDrawer(); } }, label);
  drawer.append(
    h('div', { class: 'drawer-head' },
      h('div', { class: 'drawer-tabs', role: 'tablist' }, tab('info', 'Details'), tab('share', 'Share')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', icon: 'close', onclick: () => toggleDrawer(viewer.drawer) })),
    h('div', { class: 'drawer-body' }, viewer.drawer === 'info' ? infoPanel() : sharePanel()));
}

function confirmButton(label, armedLabel, onConfirm, cls = 'btn ghost sm danger') {
  const b = h('button', { class: cls, type: 'button', text: label });
  let armed = false;
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = armedLabel;
      setTimeout(() => { if (armed && b.isConnected) { armed = false; b.textContent = label; } }, 3500);
      return;
    }
    b.disabled = true;
    try { await onConfirm(); } catch (e) { apiError(e); b.disabled = false; }
  });
  return b;
}

async function patchArtifact(body) {
  viewer.artifact = await api('PATCH', `/api/artifacts/${viewer.artifact.id}`, body);
}

function infoPanel() {
  const a = viewer.artifact;
  const v = currentVersion();
  const title = h('input', { value: a.title, maxLength: 160, 'aria-label': 'Title' });
  const tags = h('input', { value: a.tags.join(', '), placeholder: 'report, q3, draft', 'aria-label': 'Tags' });
  const note = h('textarea', { maxLength: 4000, rows: 4, placeholder: 'Only you can see this note…', value: a.note || '' });
  const status = h('span', { class: 'save-status muted' });
  for (const el of [title, tags, note]) el.addEventListener('input', () => { status.textContent = ''; });
  const save = h('button', { class: 'btn', type: 'button', text: 'Save', onclick: async () => {
    save.disabled = true;
    try {
      await patchArtifact({ title: title.value, tags: tags.value.split(','), note: note.value });
      status.textContent = 'Saved';
      $('.bar-title h1').textContent = viewer.artifact.title;
    } catch (e) { apiError(e); } finally { save.disabled = false; }
  } });
  const pin = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
    try { await patchArtifact({ pinned: !a.pinned }); paintDrawer(); } catch (e) { apiError(e); }
  } }, icon('pin'), a.pinned ? 'Unpin' : 'Pin to top');
  const newVersion = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { uploadTarget = a.id; $('#file-input').click(); } }, icon('upload'), 'Upload new version');

  return [
    h('label', { text: 'Title' }), title,
    h('label', { text: 'Tags' }), tags,
    h('label', { text: 'Private note' }), note,
    h('div', { class: 'form-row' }, save, status),
    h('div', { class: 'form-row wrap' }, pin, newVersion),
    h('h3', { text: `Files in v${v.n} (${v.files.length})` }),
    h('ul', { class: 'file-list' }, v.files.map((f) => h('li', { class: f.name === viewer.file ? 'current' : '' },
      h('button', { type: 'button', class: 'file-name', onclick: () => { viewer.file = f.name; const s = $('.file-select'); if (s) s.value = f.name; paintStage(); paintDrawer(); } },
        h('span', { class: `kind-pill kind-${fileKind(f.name)}`, text: KIND_LABEL[fileKind(f.name)] }), h('span', { class: 'name', text: f.name })),
      h('span', { class: 'size', text: fmtBytes(f.size) })))),
    a.versions.length > 1 ? [
      h('h3', { text: `History (${a.versions.length})` }),
      h('ul', { class: 'version-list' }, a.versions.map((x) => h('li', { class: x.n === v.n ? 'current' : '' },
        h('button', { type: 'button', onclick: () => { viewer.version = x.n === a.version ? 0 : x.n; viewer.file = null; renderViewer(); viewer.drawer = 'info'; paintDrawer(); } },
          h('strong', { text: `v${x.n}` }), h('span', { class: 'muted', text: ` ${x.message ? `${x.message} · ` : ''}${ago(x.createdAt)}` })),
        x.n === a.version ? null : confirmButton('Restore', 'Click again', async () => {
          viewer.artifact = await api('POST', `/api/artifacts/${a.id}/versions/${x.n}/restore`);
          viewer.version = 0;
          viewer.file = null;
          renderViewer();
          viewer.drawer = 'info';
          paintDrawer();
          toast(`Restored v${x.n} as v${viewer.artifact.version}`);
        }, 'btn ghost sm')))),
    ] : null,
    h('dl', { class: 'facts' },
      h('dt', { text: 'Created' }), h('dd', { text: fmtDate(a.createdAt) }),
      h('dt', { text: 'ID' }), h('dd', {}, h('code', { text: a.id }))),
    h('div', { class: 'danger-zone' },
      confirmButton('Delete artifact', 'Click again to delete forever', async () => {
        await api('DELETE', `/api/artifacts/${a.id}`);
        toast('Artifact deleted');
        navigate('/');
      })),
  ];
}

function shareRow(s) {
  const usedUp = s.maxViews > 0 && s.views >= s.maxViews;
  const st = s.active ? 'active' : s.revokedAt ? 'revoked' : usedUp && Date.parse(s.expiresAt) > Date.now() ? 'used' : 'expired';
  const label = { active: 'Live', revoked: 'Revoked', expired: 'Expired', used: 'Used up' }[st];
  const views = `${s.protected ? 'Password · ' : ''}${s.views} ${s.views === 1 ? 'view' : 'views'}${s.maxViews ? ` of ${s.maxViews}` : ''}${s.lastViewedAt ? ` · last ${ago(s.lastViewedAt)}` : ''}`;
  const li = h('li', { class: `share-link ${st}` },
    h('div', { class: 'share-link-top' },
      h('span', { class: `pill ${st}`, text: label }),
      h('span', { class: 'muted', text: `${s.version ? `v${s.version}` : 'latest'} · ${s.active ? `expires ${ago(s.expiresAt)}` : fmtDate(s.revokedAt || s.expiresAt)}` })),
    h('code', { class: 'share-url', text: s.url }),
    h('p', { class: 'muted small share-views', text: views }));
  if (s.active) {
    li.append(h('div', { class: 'form-row' },
      h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => toast(await copyText(s.url) ? 'Public link copied' : 'Copy failed') }, icon('copy'), 'Copy'),
      h('a', { class: 'btn ghost sm', href: s.url, target: '_blank', rel: 'noopener' }, icon('external'), 'Open'),
      h('span', { class: 'spacer' }),
      confirmButton('Revoke', 'Click again to revoke', async () => {
        await api('DELETE', `/api/artifacts/${viewer.artifact.id}/shares/${s.token}`);
        viewer.artifact = await api('GET', `/api/artifacts/${viewer.artifact.id}`);
        toast('Link revoked');
        paintDrawer();
      })));
  }
  return li;
}

function sharePanel() {
  const a = viewer.artifact;
  let ttl = viewer.ttl || '7d';
  const group = h('div', { class: 'segmented wide', role: 'radiogroup', 'aria-label': 'Link lifetime' });
  const paint = () => {
    group.textContent = '';
    for (const [val, label] of TTLS) group.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(val === ttl), class: val === ttl ? 'active' : '', text: label, onclick: () => { ttl = viewer.ttl = val; paint(); } }));
  };
  paint();
  let maxViews = viewer.maxViews || 0;
  const limits = h('div', { class: 'segmented wide', role: 'radiogroup', 'aria-label': 'View limit' });
  const paintLimits = () => {
    limits.textContent = '';
    for (const [val, label] of VIEW_LIMITS) limits.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(val === maxViews), class: val === maxViews ? 'active' : '', text: label, onclick: () => { maxViews = viewer.maxViews = val; paintLimits(); } }));
  };
  paintLimits();
  const note = h('textarea', { maxLength: 1000, rows: 2, placeholder: 'Optional note shown to viewers…' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', maxLength: 200, placeholder: 'Optional, 4+ characters', 'aria-label': 'Password for viewers' });
  const create = h('button', { class: 'btn primary block', type: 'button', onclick: async () => {
    create.disabled = true;
    try {
      const s = await api('POST', `/api/artifacts/${a.id}/shares`, { ttl, note: note.value, maxViews, password: pw.value });
      const copied = await copyText(s.url);
      viewer.artifact = await api('GET', `/api/artifacts/${a.id}`);
      toast(copied ? 'Public link created and copied' : 'Public link created');
      paintDrawer();
    } catch (e) { apiError(e); create.disabled = false; }
  } }, icon('link'), 'Create public link');
  const active = a.shares.filter((s) => s.active).reverse();
  const dead = a.shares.filter((s) => !s.active).reverse();
  return [
    h('p', { class: 'hint' }, 'Anyone with a public link can view this artifact until it ', h('strong', { text: 'expires or you revoke it' }), '. Your private link always requires sign-in.'),
    h('label', { text: 'Expires after' }), group,
    h('label', { text: 'View limit' }), limits,
    h('label', { text: 'Note for viewers' }), note,
    h('label', { text: 'Password' }), pw,
    create,
    h('h3', { text: `Live links (${active.length})` }),
    active.length ? h('ul', { class: 'share-list' }, active.map(shareRow)) : h('p', { class: 'muted', text: 'No public links. This artifact is private.' }),
    dead.length ? h('details', { class: 'share-history' }, h('summary', { text: `Expired or revoked (${dead.length})` }), h('ul', { class: 'share-list' }, dead.map(shareRow))) : null,
  ];
}

/* ---------- settings ---------- */
async function openSettings() {
  show('settings');
  const root = $('#view-settings');
  root.textContent = '';
  let tokens = [], passkeys = [];
  try { [tokens, passkeys] = await Promise.all([api('GET', '/api/tokens'), api('GET', '/api/passkeys')]); } catch (e) { apiError(e); return; }
  const me = state.me;
  const tokenOut = h('div', { class: 'token-out', hidden: true });

  const tokenName = h('input', { placeholder: 'e.g. claude-code on laptop', maxLength: 60, autocomplete: 'off', 'aria-label': 'Token name' });
  const createToken = h('button', { class: 'btn primary', type: 'button', text: 'Create token', onclick: async () => {
    try {
      const t = await api('POST', '/api/tokens', { name: tokenName.value || 'agent' });
      tokenName.value = '';
      showToken(tokenOut, t.token);
      refreshTokens();
    } catch (e) { apiError(e); }
  } });
  const tokenList = h('ul', { class: 'plain-list' });
  const refreshTokens = async () => {
    tokens = await api('GET', '/api/tokens');
    tokenList.textContent = '';
    if (!tokens.length) tokenList.append(h('li', { class: 'muted', text: 'No tokens yet.' }));
    for (const t of tokens) tokenList.append(h('li', {},
      h('div', {}, h('strong', { text: t.name }), h('div', { class: 'muted small', text: `${t.prefix}… · created ${ago(t.createdAt)} · ${t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'}` })),
      confirmButton('Revoke', 'Click again', async () => { await api('DELETE', `/api/tokens/${t.id}`); toast('Token revoked'); refreshTokens(); })));
  };
  refreshTokens();

  const pkList = h('ul', { class: 'plain-list' });
  const refreshPasskeys = async () => {
    passkeys = await api('GET', '/api/passkeys');
    pkList.textContent = '';
    if (!passkeys.length) pkList.append(h('li', { class: 'muted', text: 'No passkeys yet — add one so you never type the password again.' }));
    for (const p of passkeys) pkList.append(h('li', {},
      h('div', {}, h('strong', { text: p.name }), h('div', { class: 'muted small', text: `added ${ago(p.createdAt)}` })),
      confirmButton('Remove', 'Click again', async () => { await api('DELETE', `/api/passkeys/${encodeURIComponent(p.id)}`); toast('Passkey removed'); refreshPasskeys(); })));
  };
  refreshPasskeys();
  const pkName = h('input', { placeholder: 'e.g. MacBook Touch ID', maxLength: 60, autocomplete: 'off', 'aria-label': 'Passkey name' });
  const addPk = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    try { await registerPasskey(pkName.value || 'Passkey'); pkName.value = ''; toast('Passkey added'); refreshPasskeys(); } catch (e) {
      if (e && e.name === 'NotAllowedError') toast('Passkey setup cancelled', 'error'); else apiError(e);
    }
  } }, icon('key'), 'Add passkey');

  // Password managers attach saved logins to this hidden field instead of the passkey name.
  const user = h('input', { type: 'text', autocomplete: 'username', value: me.name, hidden: true, tabIndex: -1, 'aria-hidden': 'true' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password', placeholder: 'Current password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minLength: 10, 'aria-label': 'New password', placeholder: 'New password (10+ chars)' });
  const changePw = h('button', { class: 'btn', type: 'button', text: 'Change password', onclick: async () => {
    try { await api('POST', '/api/password', { current: cur.value, password: next.value }); cur.value = next.value = ''; toast('Password changed; other sessions signed out'); } catch (e) { apiError(e); }
  } });

  root.append(
    h('header', { class: 'bar' },
      h('a', { class: 'icon-btn', href: '/', 'data-link': '', 'aria-label': 'Back to gallery', icon: 'back' }),
      h('div', { class: 'bar-title' }, h('h1', { text: 'Settings' }), h('p', { class: 'muted', text: `${me.name} · ${me.version}` })),
      h('div', { class: 'bar-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: logout }, icon('logout'), 'Sign out'))),
    h('main', { class: 'settings' },
      h('section', { class: 'panel' },
        h('h2', {}, icon('bot'), 'Connect an AI agent'),
        h('p', { class: 'muted', text: 'Create a token, then give it to Claude Code, Codex, Cursor or any MCP client. Agents can publish, update and list artifacts; they only create public links when you ask.' }),
        h('div', { class: 'form-row' }, tokenName, createToken),
        tokenOut,
        tokenList),
      h('section', { class: 'panel' },
        h('h2', {}, icon('key'), 'Passkeys'),
        h('div', { class: 'form-row' }, pkName, addPk),
        pkList),
      h('section', { class: 'panel' },
        h('h2', {}, icon('settings'), 'Password'),
        h('div', { class: 'form-row wrap' }, user, cur, next, changePw)),
      h('section', { class: 'panel' },
        h('h2', {}, icon('note'), 'Look & feel'),
        h('p', { class: 'muted' }, 'Agents read ', h('a', { href: '/design.md', target: '_blank', text: '/design.md' }), ' before writing artifacts, so everything they publish matches your style. Export the theme with ', h('code', { text: 'vitrine theme init ./my-theme' }), ', ask your AI to restyle it, then run with ', h('code', { text: '--theme-dir ./my-theme' }), '.'),
        h('p', { class: 'muted' }, me.separateContentOrigin ? 'Artifacts are served from a separate origin (' : 'Artifacts are sandboxed on ', h('code', { text: me.contentOrigin }), me.separateContentOrigin ? ') — best isolation.' : '. For the strongest isolation, add --content-url with a second domain.'))));
}

function showToken(box, token) {
  const base = state.me.publicUrl;
  const snippets = [
    ['Claude Code (MCP)', `claude mcp add --transport http vitrine ${base}/mcp --header "Authorization: Bearer ${token}"`],
    ['Agent skill (any agent)', `npx skills add dinhkarate/vitrine\nexport VITRINE_URL=${base}\nexport VITRINE_TOKEN=${token}`],
    ['CLI', `VITRINE_URL=${base} VITRINE_TOKEN=${token} vitrine publish report.html`],
  ];
  box.hidden = false;
  box.textContent = '';
  box.append(
    h('p', {}, h('strong', { text: 'Copy this token now — it will not be shown again.' })),
    snippetEl('Token', token),
    ...snippets.map(([label, text]) => snippetEl(label, text)));
}
function snippetEl(label, text) {
  return h('div', { class: 'snippet' },
    h('div', { class: 'snippet-head' }, h('span', { text: label }),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => toast(await copyText(text) ? 'Copied' : 'Copy failed') }, icon('copy'), 'Copy')),
    h('pre', { text }));
}

async function logout() {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  navigate('/login', true);
}

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (viewer && viewer.drawer) { toggleDrawer(viewer.drawer); return; }
    if (typing) { document.activeElement.blur(); return; }
    if (viewer || !$('#view-settings').hidden) navigate('/');
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/' && !$('#view-gallery').hidden) { e.preventDefault(); $('#search').focus(); }
  if (viewer && e.key === 'i') toggleDrawer('info');
  if (viewer && e.key === 's') toggleDrawer('share');
});

route();
