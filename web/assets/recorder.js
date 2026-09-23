import { h, fill, icon, api, fmtTime, toast, confirmDialog, debounce } from './util.js';
import { S, go, reloadAll, renderSidebar } from './app.js';
import { TYPES, speakerSelect } from './dialogs.js';

// One recording at a time; it keeps running while the user browses other notes.
let REC = null;

export const isRecording = () => !!REC && !REC.stopped;
export const currentRecording = () => (isRecording() ? REC : null);

export async function startRecording(opts = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 창에서는 마이크를 사용할 수 없습니다. 설정 > 일반 > 브라우저에서 열기를 이용하세요.');
  const ls = (k, def) => (localStorage.getItem(k) ?? def) === '1';
  const mic = localStorage.getItem('mn.mic');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: mic ? { exact: mic } : undefined, channelCount: 1,
        noiseSuppression: ls('mn.ns', '1'), autoGainControl: ls('mn.agc', '1'), echoCancellation: ls('mn.ec', '0'),
      },
    });
  } catch (e) {
    if (mic && e.name === 'OverconstrainedError') { localStorage.removeItem('mn.mic'); return startRecording(opts); }
    throw new Error(e.name === 'NotAllowedError'
      ? '마이크 권한이 없습니다. 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 회의노트를 허용해 주세요.'
      : `마이크를 열 수 없습니다: ${e.message}`);
  }
  const note = await api('/api/notes/record', { method: 'POST', body: { ...opts, language: S.state.settings.language } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/assets/recorder-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-recorder', { processorOptions: { targetRate: 16000 } });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node);
  node.connect(sink).connect(ctx.destination);

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/record/${note.id}`);
  ws.binaryType = 'arraybuffer';
  const rec = {
    id: note.id, note, stream, ctx, node, ws, samples: 0, paused: false, stopped: false, levels: [], live: [], bookmarks: [],
    pending: [], listeners: new Set(), level: 0,
    emit() { this.listeners.forEach((f) => f()); },
  };
  REC = rec;
  ws.onopen = () => { for (const b of rec.pending) ws.send(b); rec.pending = []; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'live') { rec.live.push(m); rec.emit(); }
    else if (m.type === 'bookmark') { rec.bookmarks.push(m); rec.emit(); }
    else if (m.type === 'saved') { rec.saved = true; rec.emit(); }
  };
  ws.onclose = () => { if (!rec.stopped) { toast('녹음 연결이 끊겼습니다. 지금까지 녹음된 내용은 저장했습니다.', { error: true, ms: 6000 }); cleanup(rec); reloadAll(); } };
  node.port.onmessage = (e) => {
    const { pcm, level } = e.data;
    rec.level = level || 0;
    rec.levels.push(rec.level);
    if (rec.levels.length > 600) rec.levels.shift();
    if (pcm && !rec.paused) {
      rec.samples += pcm.byteLength / 2;
      if (ws.readyState === 1) ws.send(pcm);
      else if (ws.readyState === 0) rec.pending.push(pcm);
    }
    rec.emit();
  };
  renderSidebar();
  return note.id;
}

function cleanup(rec) {
  rec.stopped = true;
  try { rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
  try { rec.ctx.close(); } catch { /* closed */ }
  if (REC === rec) REC = null;
  renderSidebar();
}

async function stopRecording(rec) {
  rec.node.port.postMessage('flush');
  await new Promise((r) => setTimeout(r, 120));
  rec.stopped = true;
  const saved = new Promise((resolve) => {
    const t = setTimeout(resolve, 8000);
    rec.ws.addEventListener('message', (e) => { if (JSON.parse(e.data).type === 'saved') { clearTimeout(t); resolve(); } });
    rec.ws.addEventListener('close', () => { clearTimeout(t); resolve(); });
  });
  rec.ws.send(JSON.stringify({ type: 'stop' }));
  cleanup(rec);
  await saved;
}

export async function renderRecorder(main, id) {
  const rec = REC && REC.id === id ? REC : null;
  if (!rec) {
    const n = await api(`/api/notes/${id}`).catch(() => null);
    if (n && n.status !== 'recording') { go(`#/note/${id}`); return null; }
    main.append(h('div', { class: 'empty' }, h('h3', null, '녹음이 진행 중이 아닙니다'), '창을 새로 고치면 녹음이 멈추고 그때까지의 내용이 저장됩니다.',
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => go('#/all') }, '목록으로'))));
    return null;
  }
  const status = h('div', { class: 'rec-status' }, h('span', { class: 'led' }), h('span', null, '녹음 중'));
  const timer = h('div', { class: 'rec-timer' }, '00:00:00');
  const wave = h('canvas', { class: 'rec-wave' });
  const pauseBtn = h('button', { class: 'rbtn', title: '일시정지', onclick: togglePause }, icon('pause', 'lg'));
  const bmCount = h('span', null, '북마크');
  const liveEl = h('div', { class: 'rec-live scroll' });
  const titleIn = h('input', { class: 'inp', value: rec.note.title, onchange: (e) => api(`/api/notes/${id}`, { method: 'PATCH', body: { title: e.target.value } }) });
  const memo = h('textarea', { class: 'inp', rows: 8, placeholder: '녹음하면서 메모하세요. 회의록에 함께 저장됩니다.',
    oninput: debounce((e) => rec.ws.readyState === 1 && rec.ws.send(JSON.stringify({ type: 'memo', memo: e.target.value })), 500) });
  const spk = speakerSelect(0);
  spk.onchange = () => api(`/api/notes/${id}`, { method: 'PATCH', body: { num_speakers: Number(spk.value) } });
  const type = h('select', { class: 'sel', onchange: (e) => api(`/api/notes/${id}`, { method: 'PATCH', body: { note_type: e.target.value } }) },
    TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const hint = h('input', { class: 'inp', placeholder: '이름·전문 용어', onchange: (e) => api(`/api/notes/${id}`, { method: 'PATCH', body: { hint: e.target.value } }) });

  main.append(h('div', { class: 'recorder' },
    h('div', { class: 'rec-main' },
      h('div', { class: 'rec-stage' }, status, timer, wave,
        h('div', { class: 'rec-ctrl' },
          h('div', { class: 'rbtn-l' }, h('button', { class: 'rbtn', title: '녹음 취소', onclick: cancel }, icon('trash', 'lg')), '취소'),
          h('div', { class: 'rbtn-l' }, pauseBtn, h('span', { class: 'pl' }, '일시정지')),
          h('div', { class: 'rbtn-l' }, h('button', { class: 'rbtn stop', title: '녹음 완료', onclick: finish }, h('span')), '완료'),
          h('div', { class: 'rbtn-l' }, h('button', { class: 'rbtn', title: '북마크 (B)', onclick: bookmark }, icon('bookmark', 'lg')), bmCount))),
      liveEl),
    h('div', { class: 'rec-side' },
      h('div', { class: 'field' }, h('label', null, '제목'), titleIn),
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, '참석자 수'), spk), h('div', { class: 'field' }, h('label', null, '종류'), type)),
      h('div', { class: 'field' }, h('label', null, '키워드 등록'), hint, h('span', { class: 'hint' }, '이름·용어를 적으면 더 정확하게 받아씁니다')),
      h('div', { class: 'field' }, h('label', null, '메모'), memo),
      h('div', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12px' } }, '다른 노트를 보는 동안에도 녹음은 계속됩니다. 완료를 누르면 AI가 받아쓰고 회의록을 만듭니다.'))));

  function togglePause() {
    rec.paused = !rec.paused;
    rec.node.port.postMessage(rec.paused ? 'pause' : 'resume');
    rec.emit();
  }
  function bookmark() {
    const t = rec.samples / 16000;
    rec.ws.send(JSON.stringify({ type: 'bookmark', t }));
    toast(`${fmtTime(t)} 북마크`);
  }
  async function finish() {
    if (rec.samples < 16000) { toast('1초 이상 녹음해 주세요'); return; }
    const btns = main.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    status.replaceChildren(h('span', null, '저장 중…'));
    await stopRecording(rec);
    await reloadAll();
    go(`#/note/${id}`);
  }
  async function cancel() {
    if (!await confirmDialog('녹음 취소', '지금까지 녹음한 내용을 저장하지 않고 삭제할까요?', { ok: '삭제', danger: true })) return;
    rec.stopped = true;
    rec.ws.send(JSON.stringify({ type: 'cancel' }));
    cleanup(rec);
    await new Promise((r) => setTimeout(r, 300));
    await reloadAll();
    go('#/all');
  }
  function onKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key.toLowerCase() === 'b') bookmark();
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  }
  window.addEventListener('keydown', onKey);

  let lastLive = -1;
  function update() {
    const t = rec.samples / 16000;
    const p2 = (n) => String(Math.floor(n)).padStart(2, '0');
    timer.textContent = `${p2(t / 3600)}:${p2((t % 3600) / 60)}:${p2(t % 60)}`;
    status.className = `rec-status${rec.paused ? ' paused' : ''}`;
    status.lastChild.textContent = rec.paused ? '일시정지됨' : '녹음 중';
    pauseBtn.replaceChildren(icon(rec.paused ? 'mic' : 'pause', 'lg'));
    pauseBtn.nextSibling.textContent = rec.paused ? '계속하기' : '일시정지';
    bmCount.textContent = rec.bookmarks.length ? `북마크 ${rec.bookmarks.length}` : '북마크';
    if (rec.live.length !== lastLive) {
      lastLive = rec.live.length;
      const atBottom = liveEl.scrollHeight - liveEl.scrollTop - liveEl.clientHeight < 60;
      fill(liveEl, h('h5', null, icon('wave', 'sm'), S.state.settings.live_transcription ? '실시간 자막 · 완료 후 더 정확하게 다시 받아씁니다' : '실시간 자막이 꺼져 있습니다 (설정 > 녹음)'),
        rec.live.length ? rec.live.map((l) => h('div', { class: 'live-line' }, h('span', { class: 'seg-time' }, fmtTime(l.start)), h('span', null, l.text)))
          : h('div', { style: { color: 'var(--muted)' } }, '말씀하시면 여기에 표시됩니다…'));
      if (atBottom) liveEl.scrollTop = liveEl.scrollHeight;
    }
    drawLevels();
  }
  function drawLevels() {
    const dpr = window.devicePixelRatio || 1;
    const w = wave.clientWidth, hh = wave.clientHeight;
    if (!w) return;
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(hh * dpr); }
    const c = wave.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hh);
    const bar = 3, gap = 2, n = Math.floor(w / (bar + gap));
    const lv = rec.levels.slice(-n);
    const color = rec.paused ? getComputedStyle(document.documentElement).getPropertyValue('--muted') : getComputedStyle(document.documentElement).getPropertyValue('--danger');
    c.fillStyle = color.trim() || '#e5484d';
    for (let i = 0; i < lv.length; i++) {
      const v = Math.min(1, Math.sqrt(lv[i]) * 1.6);
      const bh = Math.max(3, v * hh);
      c.fillRect(w - (lv.length - i) * (bar + gap), (hh - bh) / 2, bar, bh);
    }
  }
  rec.listeners.add(update);
  update();
  return () => { rec.listeners.delete(update); window.removeEventListener('keydown', onKey); };
}
