// Small DOM + API helpers shared by every view.

export function h(tag, attrs, ...children) {
  const el = tag === 'frag' ? document.createDocumentFragment() : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'ref') v(el);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------ icons (inline SVG, Lucide-style)
const P = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h0"/>',
  notes: '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
  rew: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  fwd: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  sparkle: '<path d="M12 3l1.8 4.9L19 9.7l-4.9 1.8L12 16.5l-1.8-5L5.3 9.7l4.9-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1"/>',
  memo: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4M12 2v13"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  follow: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  merge: '<path d="M8 6v12M16 6v4a4 4 0 0 1-4 4H8"/>',
  replace: '<path d="M3 7h13l-3-3M21 17H8l3 3"/>',
  lang: '<path d="M4 5h9M8.5 3v2M6 5c0 4 2.5 7 6 8.5M11 5c-.8 4-3.5 7-7 8.5"/><path d="m13 21 4-9 4 9M14.5 18h5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `i ${cls}`);
  s.innerHTML = P[name] || '';
  return s;
}

// ------------------------------------------------------------------ API
export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'X-MeetNote': '1' } };
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) init.body = opts.body;
    else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg = j.detail || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

export function uploadFile(file, fields, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v ?? '');
    const x = new XMLHttpRequest();
    x.open('POST', '/api/notes/upload');
    x.setRequestHeader('X-MeetNote', '1');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) resolve(JSON.parse(x.responseText));
      else {
        let m = x.statusText;
        try { m = JSON.parse(x.responseText).detail; } catch { /* keep */ }
        reject(new Error(m));
      }
    };
    x.onerror = () => reject(new Error('업로드 실패'));
    x.send(fd);
  });
}

// ------------------------------------------------------------------ formatting
export function fmtTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function fmtDur(t) {
  t = Math.round(t || 0);
  if (t < 60) return `${t}초`;
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  if (hh) return `${hh}시간 ${mm}분`;
  return ss && mm < 10 ? `${mm}분 ${ss}초` : `${mm}분`;
}

export function fmtDate(ts, withTime = true) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const wd = '일월화수목금토'[d.getDay()];
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay) return withTime ? `오늘 ${time}` : '오늘';
  if (d.toDateString() === y.toDateString()) return withTime ? `어제 ${time}` : '어제';
  const date = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`
    : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${wd})`;
  return withTime ? `${date} ${time}` : date;
}

export function dayGroup(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return '이번 주';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return '이번 달';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

export const SPEAKER_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const speakerColor = (i) => SPEAKER_COLORS[((i % 8) + 8) % 8];
export function initials(name, idx) {
  const m = /(\d+)$/.exec(name || '');
  if (/^참석자/.test(name || '') && m) return m[1];
  const t = (name || '').trim();
  if (!t) return String(idx + 1);
  if (/[가-힣]/.test(t[0])) return t.length >= 3 ? t.slice(1, 3) : t;  // 김민수 → 민수
  return t.slice(0, 2).toUpperCase();
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------------------------------------ toasts, modals, menus
export function toast(msg, opts = {}) {
  const el = h('div', { class: `toast${opts.error ? ' err' : ''}` }, msg,
    opts.action ? h('button', { onclick: () => { opts.action.fn(); el.remove(); } }, opts.action.label) : null);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.ms || (opts.action ? 6000 : 2600));
}

export function modal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bd.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const bd = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === bd) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-h' }, h('h3', null, title),
        h('button', { class: 'btn ghost icon sm', onclick: close, 'aria-label': '닫기' }, icon('x'))),
      h('div', { class: 'modal-b scroll' }, body),
      footer ? h('div', { class: 'modal-f' }, footer) : null));
  root.appendChild(bd);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => { const f = bd.querySelector('input:not([type=checkbox]):not([type=radio]), textarea'); f && f.focus(); }, 30);
  return { close, el: bd };
}

export function confirmDialog(title, message, { ok = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: h('p', { style: { margin: 0, color: 'var(--text-2)' } }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => { done = true; m.close(); resolve(false); } }, '취소'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onclick: () => { done = true; m.close(); resolve(true); } }, ok),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function promptDialog(title, value = '', { placeholder = '', ok = '저장' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'inp', value, placeholder, style: { width: '100%' } });
    const submit = () => { done = true; m.close(); resolve(input.value.trim()); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
    const m = modal({
      title, body: input,
      footer: [h('button', { class: 'btn', onclick: () => { done = true; m.close(); resolve(null); } }, '취소'),
        h('button', { class: 'btn primary', onclick: submit }, ok)],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => input.select(), 40);
  });
}

let openMenu = null;
export function menu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' }, items.map((it) => {
    if (it === '-') return h('hr');
    if (it.header) return h('div', { class: 'mh' }, it.header);
    if (it.node) return it.node;
    return h('button', {
      class: it.danger ? 'danger' : '', role: 'menuitem',
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.fn(); },
    }, it.icon ? icon(it.icon, 'sm') : null, it.label, it.check ? h('span', { style: { marginLeft: 'auto', color: 'var(--accent)' } }, icon('check', 'sm')) : null);
  }));
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, bottom: anchor.y, top: anchor.y };
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let x = align === 'right' ? r.right - mw : r.left;
  let y = r.bottom + 6;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  openMenu = el;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  return el;
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('mousedown', outside, true);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h('textarea', { style: { position: 'fixed', opacity: 0 } });
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast('복사했습니다');
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// replaceChildren() that accepts nested arrays and skips null/false.
export function fill(el, ...children) {
  el.replaceChildren(h('frag', null, ...children));
  return el;
}
