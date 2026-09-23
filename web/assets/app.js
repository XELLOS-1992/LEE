import { h, fill, icon, api, fmtDur, fmtDate, dayGroup, toast, menu, confirmDialog, promptDialog, escapeRe, debounce, isTyping } from './util.js';
import { openUpload, openSettings, moveToFolder } from './dialogs.js';
import { renderNote } from './note.js';
import { renderRecorder, startRecording, isRecording, currentRecording } from './recorder.js';

export const S = {
  state: null,
  notes: [],
  q: '',
  sort: localStorage.getItem('mn.sort') || 'recent',
  destroy: null,
  listTimer: null,
};

// ------------------------------------------------------------------ theme
export function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
}

// ------------------------------------------------------------------ routing
export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  if (parts[0] === 'note') return { name: 'note', id: parts[1], t: params.get('t') };
  if (parts[0] === 'record') return { name: 'record', id: parts[1] };
  if (parts[0] === 'folder') return { name: 'list', view: 'folder', folder: parts[1] };
  if (parts[0] === 'favorites') return { name: 'list', view: 'favorites' };
  if (parts[0] === 'trash') return { name: 'list', view: 'trash' };
  return { name: 'list', view: 'all' };
}

export async function refreshState() {
  S.state = await api('/api/state');
  applyTheme(S.state.settings.theme);
  renderSidebar();
  return S.state;
}

async function route() {
  const r = parseRoute();
  if (S.destroy) { try { S.destroy(); } catch (e) { console.error(e); } S.destroy = null; }
  clearTimeout(S.listTimer);
  S.route = r;
  renderSidebar();
  const main = document.getElementById('main');
  main.replaceChildren();
  if (r.name === 'note') S.destroy = await renderNote(main, r.id, { t: r.t });
  else if (r.name === 'record') S.destroy = await renderRecorder(main, r.id);
  else await renderList(main, r);
}

// ------------------------------------------------------------------ sidebar
function navItem(label, ic, hash, count, active, extra = {}) {
  return h('button', { class: `nav-item${active ? ' active' : ''}`, onclick: () => go(hash), ...extra },
    icon(ic), h('span', { class: 'name' }, label), count !== undefined ? h('span', { class: 'count' }, count) : null);
}

export function renderSidebar() {
  const sb = document.getElementById('sidebar');
  const st = S.state;
  if (!st) return;
  const r = S.route || {};
  const c = st.counts;
  const engineName = { 'whisper-mlx': 'Whisper · Apple GPU', sensevoice: 'SenseVoice', 'faster-whisper': 'faster-whisper' }[st.engine] || st.engine;
  const sumName = { claude: 'Claude', ollama: 'Ollama', local: '내장 요약' }[st.summary_provider];
  const folderDrop = (fid) => ({
    ondragover: (e) => { if (e.dataTransfer.types.includes('text/meetnote-id')) { e.preventDefault(); e.currentTarget.classList.add('drop-target'); } },
    ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
    ondrop: async (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('drop-target');
      const id = e.dataTransfer.getData('text/meetnote-id');
      if (!id) return;
      await api(`/api/notes/${id}`, { method: 'PATCH', body: { folder_id: fid } });
      toast(fid ? '폴더로 이동했습니다' : '폴더에서 뺐습니다');
      reloadAll();
    },
  });
  fill(sb, 
    h('div', { class: 'brand' }, h('img', { src: '/assets/icon.png', alt: '' }),
      h('div', null, h('b', null, '회의노트'), h('small', null, 'MeetNote · 로컬 AI 회의록'))),
    h('div', { class: 'new-btns' },
      h('button', { class: 'btn-new rec', onclick: () => newRecording(), title: '새 녹음 (⌘R)' }, h('span', { class: 'dot' }), '녹음하기'),
      h('button', { class: 'btn-new', onclick: () => openUpload(), title: '파일 업로드 (⌘U)' }, icon('upload'), '파일 업로드')),
    currentRecording() ? h('button', { class: `nav-item${r.name === 'record' ? ' active' : ''}`, style: { color: 'var(--danger)', fontWeight: 700 }, onclick: () => go(`#/record/${currentRecording().id}`) },
      h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: 'var(--danger)', margin: '0 4px', animation: 'blink 1.2s infinite' } }), '녹음 중 — 돌아가기') : null,
    navItem('전체 노트', 'notes', '#/all', c.all, r.name === 'list' && r.view === 'all', folderDrop(null)),
    navItem('즐겨찾기', 'star', '#/favorites', c.favorites, r.view === 'favorites'),
    navItem('휴지통', 'trash', '#/trash', c.trash || undefined, r.view === 'trash'),
    h('div', { class: 'nav-sec' }, '폴더',
      h('button', { title: '새 폴더', onclick: newFolder }, icon('plus', 'sm'))),
    h('div', { class: 'folders scroll' }, st.folders.length ? st.folders.map((f) =>
      navItem(f.name, 'folder', `#/folder/${f.id}`, f.count, r.view === 'folder' && r.folder === f.id, {
        ...folderDrop(f.id),
        oncontextmenu: (e) => { e.preventDefault(); folderMenu(e, f); },
      })) : h('div', { class: 'nav-item', style: { color: 'var(--muted)', cursor: 'default', fontSize: '12.5px' } }, '폴더로 노트를 정리하세요')),
    h('div', { class: 'side-bottom' },
      h('div', { class: 'engine-chip', title: '음성 인식 엔진 · AI 요약' },
        h('span', { class: `led${st.models_ready ? '' : ' off'}` }),
        st.models_ready ? `${engineName} · ${sumName}` : '첫 변환 시 모델을 내려받습니다'),
      h('button', { class: 'nav-item', onclick: () => openSettings() }, icon('settings'), '설정')),
  );
}

async function newFolder() {
  const name = await promptDialog('새 폴더', '', { placeholder: '폴더 이름', ok: '만들기' });
  if (!name) return;
  const f = await api('/api/folders', { method: 'POST', body: { name } });
  await refreshState();
  go(`#/folder/${f.id}`);
}

function folderMenu(e, f) {
  menu({ x: e.clientX, y: e.clientY }, [
    { label: '이름 변경', icon: 'edit', fn: async () => {
      const name = await promptDialog('폴더 이름 변경', f.name);
      if (name) { await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name } }); refreshState(); }
    } },
    { label: '폴더 삭제', icon: 'trash', danger: true, fn: async () => {
      if (!await confirmDialog('폴더 삭제', `'${f.name}' 폴더를 삭제할까요? 안의 노트는 삭제되지 않고 전체 노트에 남습니다.`, { ok: '삭제', danger: true })) return;
      await api(`/api/folders/${f.id}`, { method: 'DELETE' });
      await refreshState();
      go('#/all');
    } },
  ]);
}

// ------------------------------------------------------------------ list
async function renderList(main, r) {
  const st = S.state;
  const folder = r.view === 'folder' ? st.folders.find((f) => f.id === r.folder) : null;
  const title = r.view === 'favorites' ? '즐겨찾기' : r.view === 'trash' ? '휴지통' : folder ? folder.name : '전체 노트';
  const searchInput = h('input', {
    placeholder: '노트 제목, 대화 내용, 요약에서 검색', value: S.q, id: 'global-search',
    oninput: debounce((e) => { S.q = e.target.value; loadList(); }, 220),
  });
  const sortSel = h('select', { class: 'sel', title: '정렬', onchange: (e) => { S.sort = e.target.value; localStorage.setItem('mn.sort', S.sort); loadList(); } },
    [['recent', '최신순'], ['oldest', '오래된순'], ['updated', '최근 수정순'], ['title', '이름순'], ['duration', '긴 녹음순']]
      .map(([v, l]) => h('option', { value: v, selected: S.sort === v ? '' : null }, l)));
  const listEl = h('div', { class: 'cards' });
  const wrap = h('div', { class: 'list-wrap scroll' });
  main.append(
    h('div', { class: 'topbar' },
      h('div', { class: 'search' }, icon('search'), searchInput, h('kbd', null, '⌘K')),
      h('div', { class: 'spacer' }),
      sortSel,
      r.view === 'trash' && st.counts.trash ? h('button', { class: 'btn danger', onclick: emptyTrash }, icon('trash', 'sm'), '휴지통 비우기') : null),
    wrap);
  const head = h('div', { class: 'list-head' }, h('div', null, h('div', { class: 'title' }, title), h('div', { class: 'sub', id: 'list-sub' }, '')));
  wrap.append(head);
  if (r.view === 'all' && !S.q) {
    wrap.append(h('div', { class: 'quick' },
      h('button', { class: 'quick-card rec', onclick: () => newRecording() },
        h('div', { class: 'qi' }, icon('mic', 'lg')), h('div', null, h('b', null, '새 녹음 시작'), h('span', null, '회의를 녹음하면 실시간 자막과 함께 받아씁니다'))),
      h('button', { class: 'quick-card', onclick: () => openUpload() },
        h('div', { class: 'qi' }, icon('upload', 'lg')), h('div', null, h('b', null, '음성·영상 파일 올리기'), h('span', null, '녹음 파일을 끌어다 놓아도 됩니다 · 여러 개 가능')))));
  }
  wrap.append(listEl);

  async function loadList() {
    const params = new URLSearchParams({ view: r.view === 'folder' ? 'all' : r.view, sort: S.sort, q: S.q });
    if (folder) params.set('folder', folder.id);
    let notes;
    try { notes = await api(`/api/notes?${params}`); } catch (e) { toast(e.message, { error: true }); return; }
    S.notes = notes;
    const sub = document.getElementById('list-sub');
    if (sub) sub.textContent = S.q ? `'${S.q}' 검색 결과 ${notes.length}개` : `노트 ${notes.length}개`;
    listEl.replaceChildren(...buildCards(notes, r));
    clearTimeout(S.listTimer);
    if (notes.some((n) => ['queued', 'processing', 'recording'].includes(n.status))) {
      S.listTimer = setTimeout(() => { if (S.route === r) { loadList(); refreshCounts(); } }, 1500);
    }
  }
  S.reloadList = loadList;
  await loadList();
  if (S.q) searchInput.focus();
}

async function refreshCounts() {
  try {
    const st = await api('/api/state');
    S.state = st;
    renderSidebar();
  } catch { /* ignore */ }
}

function highlight(text, q) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? h('mark', null, p) : p));
}

function buildCards(notes, r) {
  if (!notes.length) {
    if (S.q) return [h('div', { class: 'empty' }, h('h3', null, '검색 결과가 없습니다'), h('div', null, '다른 단어로 검색해 보세요.'))];
    if (r.view === 'trash') return [h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('trash')), h('h3', null, '휴지통이 비어 있습니다'))];
    if (r.view === 'favorites') return [h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('star')), h('h3', null, '즐겨찾기한 노트가 없습니다'), h('div', null, '노트의 ☆를 눌러 즐겨찾기에 추가하세요.'))];
    return [h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('wave')), h('h3', null, '아직 노트가 없습니다'),
      h('div', null, '회의를 녹음하거나 녹음 파일을 올리면 AI가 대화를 받아쓰고 회의록을 만들어 드립니다.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => newRecording() }, icon('mic', 'sm'), '녹음 시작'),
        h('button', { class: 'btn', onclick: () => openUpload() }, icon('upload', 'sm'), '파일 업로드')))];
  }
  const out = [];
  let lastGroup = null;
  for (const n of notes) {
    if (S.sort === 'recent' && !S.q) {
      const g = dayGroup(n.created_at);
      if (g !== lastGroup) { out.push(h('div', { class: 'group-label' }, g)); lastGroup = g; }
    }
    out.push(card(n, r));
  }
  return out;
}

function statusChip(n) {
  if (n.status === 'recording') return h('span', { class: 'chip red' }, '● 녹음 중');
  if (n.status === 'queued') return h('span', { class: 'chip' }, '대기 중');
  if (n.status === 'processing') return h('span', { class: 'chip green' }, `${n.stage || '변환 중'} ${Math.round(n.progress * 100)}%`);
  if (n.status === 'error') return h('span', { class: 'chip red' }, '변환 실패');
  return null;
}

function card(n, r) {
  const trash = r.view === 'trash';
  const star = h('button', {
    class: `star${n.favorite ? ' on' : ''}`, title: '즐겨찾기',
    onclick: async (e) => {
      e.stopPropagation();
      await api(`/api/notes/${n.id}`, { method: 'PATCH', body: { favorite: !n.favorite } });
      n.favorite = !n.favorite;
      star.classList.toggle('on', n.favorite);
      refreshCounts();
    },
  }, icon('star'));
  const preview = n.match ? h('span', null, h('span', { class: 'chip', style: { marginRight: '6px', height: '20px' } }, `${Math.floor(n.match.t / 60)}:${String(Math.floor(n.match.t % 60)).padStart(2, '0')}`), highlight(n.match.text, S.q))
    : highlight(n.preview || (n.status === 'done' ? '대화 내용이 없습니다.' : ''), S.q);
  const folder = S.state.folders.find((f) => f.id === n.folder_id);
  const el = h('div', {
    class: 'card', draggable: trash ? null : 'true', tabindex: 0,
    ondragstart: (e) => { e.dataTransfer.setData('text/meetnote-id', n.id); e.dataTransfer.effectAllowed = 'move'; },
    onclick: () => { if (n.status === 'recording') go(`#/record/${n.id}`); else if (!trash) go(`#/note/${n.id}${n.match ? `?t=${n.match.t}` : ''}`); },
    onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); },
    oncontextmenu: (e) => { e.preventDefault(); cardMenu({ x: e.clientX, y: e.clientY }, n, trash); },
  },
  h('div', { class: `ic${n.source === 'record' ? ' rec' : ''}` }, icon(n.source === 'record' ? 'mic' : 'file')),
  h('div', { class: 'body' },
    h('div', { class: 't' }, h('span', { class: 'tt' }, highlight(n.title, S.q)), statusChip(n)),
    h('div', { class: 'meta' }, fmtDate(n.created_at), n.duration ? [h('span', { class: 'sep' }), fmtDur(n.duration)] : null,
      n.speaker_count ? [h('span', { class: 'sep' }), `참석자 ${n.speaker_count}명`] : null,
      folder ? [h('span', { class: 'sep' }), h('span', null, '📁 ', folder.name)] : null),
    ['queued', 'processing'].includes(n.status)
      ? h('div', { class: `progress${n.status === 'queued' ? ' indet' : ''}` }, h('div', { style: { width: `${Math.round((n.progress || 0) * 100)}%` } }))
      : h('div', { class: 'pv' }, n.status === 'error' ? h('span', { style: { color: 'var(--danger)' } }, n.error) : preview),
    n.keywords && n.keywords.length ? h('div', { class: 'kw' }, n.keywords.map((k) => h('span', { class: 'chip' }, `#${k}`))) : null),
  h('div', { class: 'side' },
    trash ? null : star,
    h('button', { class: 'btn ghost icon sm', title: '더보기', onclick: (e) => { e.stopPropagation(); cardMenu(e.currentTarget, n, trash); } }, icon('more'))));
  return el;
}

function cardMenu(anchor, n, trash) {
  if (trash) {
    menu(anchor, [
      { label: '복원', icon: 'restore', fn: async () => { await api(`/api/notes/${n.id}/restore`, { method: 'POST' }); toast('복원했습니다'); reloadAll(); } },
      { label: '영구 삭제', icon: 'trash', danger: true, fn: async () => {
        if (!await confirmDialog('영구 삭제', '노트와 녹음 파일이 완전히 삭제됩니다. 되돌릴 수 없습니다.', { ok: '삭제', danger: true })) return;
        await api(`/api/notes/${n.id}`, { method: 'DELETE' }); reloadAll();
      } },
    ], { align: 'right' });
    return;
  }
  menu(anchor, [
    { label: '열기', icon: 'notes', fn: () => go(`#/note/${n.id}`) },
    { label: '이름 변경', icon: 'edit', fn: async () => {
      const t = await promptDialog('노트 이름 변경', n.title);
      if (t) { await api(`/api/notes/${n.id}`, { method: 'PATCH', body: { title: t } }); reloadAll(); }
    } },
    { label: n.favorite ? '즐겨찾기 해제' : '즐겨찾기', icon: 'star', fn: async () => { await api(`/api/notes/${n.id}`, { method: 'PATCH', body: { favorite: !n.favorite } }); reloadAll(); } },
    { label: '폴더로 이동', icon: 'folder', fn: () => moveToFolder(n, reloadAll) },
    '-',
    { label: '휴지통으로 이동', icon: 'trash', danger: true, fn: () => trashNote(n.id) },
  ], { align: 'right' });
}

export async function trashNote(id) {
  await api(`/api/notes/${id}/trash`, { method: 'POST' });
  toast('휴지통으로 이동했습니다', { action: { label: '실행 취소', fn: async () => { await api(`/api/notes/${id}/restore`, { method: 'POST' }); reloadAll(); } } });
  reloadAll();
}

async function emptyTrash() {
  if (!await confirmDialog('휴지통 비우기', '휴지통의 모든 노트와 녹음 파일을 영구 삭제합니다.', { ok: '모두 삭제', danger: true })) return;
  await api('/api/trash/empty', { method: 'POST' });
  reloadAll();
}

export async function reloadAll() {
  await refreshState();
  if (S.route && S.route.name === 'list' && S.reloadList) S.reloadList();
}

export async function newRecording(opts = {}) {
  if (isRecording()) { toast('이미 녹음 중입니다'); return; }
  try {
    const id = await startRecording(opts);
    if (id) go(`#/record/${id}`);
  } catch (e) {
    toast(e.message, { error: true, ms: 6000 });
  }
}

// ------------------------------------------------------------------ global behaviour
function setupDrop() {
  const dz = document.getElementById('dropzone');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; dz.hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dz.hidden = true;
    if (document.querySelector('.modal .drop')) return; // the upload dialog handles its own drop
    openUpload([...e.dataTransfer.files]);
  });
}

function setupKeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (S.route?.name !== 'list') go('#/all');
      setTimeout(() => document.getElementById('global-search')?.focus(), 50);
    } else if (mod && e.key.toLowerCase() === 'u' && !isTyping(e)) {
      e.preventDefault(); openUpload();
    } else if (mod && e.key.toLowerCase() === 'r' && e.shiftKey) {
      e.preventDefault(); newRecording();
    } else if (mod && e.key === ',') {
      e.preventDefault(); openSettings();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (isRecording()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ------------------------------------------------------------------ background jobs
// Tell the user when a conversion or summary finishes, wherever they are in the app.
const active = new Map();
async function watchJobs() {
  try {
    const jobs = await api('/api/jobs');
    const now = new Set(jobs.map((j) => j.id));
    for (const j of jobs) active.set(j.id, j);
    for (const [id, j] of active) {
      if (now.has(id)) continue;
      active.delete(id);
      const st = await api(`/api/notes/${id}/status`).catch(() => null);
      if (!st) continue;
      if (st.status === 'done') {
        const onNote = S.route?.name === 'note' && S.route.id === id;
        if (!onNote) toast(`'${st.title}' 회의록이 준비됐습니다`, { action: { label: '열기', fn: () => go(`#/note/${id}`) }, ms: 8000 });
        notifyNative('회의록이 준비됐습니다', st.title);
      } else if (st.status === 'error') {
        toast(`'${st.title}' 변환 실패: ${st.error}`, { error: true, ms: 8000 });
      }
      refreshCounts();
    }
  } catch { /* server restarting */ }
  setTimeout(watchJobs, active.size ? 2000 : 4000);
}

function notifyNative(title, body) {
  if (document.hasFocus()) return;
  if (window.__meetnoteNative) window.webkit.messageHandlers.meetnote.postMessage({ type: 'notify', title, body });
  else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/assets/icon.png' });
}

export function askNotificationPermission() {
  if (!window.__meetnoteNative && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

async function boot() {
  setupDrop();
  setupKeys();
  window.addEventListener('hashchange', route);
  try {
    await refreshState();
  } catch (e) {
    document.getElementById('main').append(h('div', { class: 'empty' }, h('h3', null, '서버에 연결할 수 없습니다'), e.message));
    return;
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change', () => applyTheme(S.state?.settings.theme));
  await route();
  watchJobs();
}

boot();
