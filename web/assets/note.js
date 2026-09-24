import { h, fill, icon, api, modal, fmtTime, fmtDur, fmtDate, toast, menu, confirmDialog, promptDialog, speakerColor, initials, escapeRe, debounce, copyText, isTyping, download } from './util.js';
import { S, go, reloadAll, trashNote } from './app.js';
import { openExport, moveToFolder, LANGS, TYPES, speakerSelect } from './dialogs.js';

// Renders one note: transcript on the left, AI summary / minutes / memo /
// bookmarks / Q&A on the right, audio player at the bottom.
export async function renderNote(main, id, opts = {}) {
  let note;
  try { note = await api(`/api/notes/${id}`); } catch (e) {
    main.append(h('div', { class: 'empty' }, h('h3', null, '노트를 찾을 수 없습니다'), h('button', { class: 'btn', onclick: () => go('#/all') }, '목록으로')));
    return null;
  }
  const V = {
    note, tab: localStorage.getItem('mn.tab') || 'summary', editSummary: false, audio: null, follow: true, activeSeg: -1, activeWord: null,
    search: '', matches: [], matchIdx: -1, speakerFilter: null, pollTimer: null, raf: 0, destroyed: false, segEls: new Map(),
  };
  const speakers = () => Object.fromEntries(V.note.speakers.map((s) => [s.idx, s.name]));
  const nameOf = (idx) => speakers()[idx] || `참석자 ${idx + 1}`;

  // ---------------------------------------------------------------- layout
  const titleInput = h('input', {
    value: note.title, 'aria-label': '노트 제목',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) e.target.blur(); if (e.key === 'Escape') { e.target.value = V.note.title; e.target.blur(); } },
    onblur: async (e) => {
      const t = e.target.value.trim();
      if (t && t !== V.note.title) { await api(`/api/notes/${id}`, { method: 'PATCH', body: { title: t } }); V.note.title = t; toast('제목을 바꿨습니다'); }
      else e.target.value = V.note.title;
    },
  });
  const metaEl = h('div', { class: 'note-meta' });
  const starBtn = h('button', { class: 'btn ghost icon', title: '즐겨찾기', onclick: toggleStar }, icon('star'));
  const top = h('div', { class: 'note-top' },
    h('button', { class: 'btn ghost icon', title: '목록으로', onclick: () => history.length > 1 ? history.back() : go('#/all') }, icon('back')),
    h('div', { class: 'note-title' }, titleInput, metaEl),
    starBtn,
    h('button', { class: 'btn', onclick: () => openExport(V.note) }, icon('download', 'sm'), '내보내기'),
    h('button', { class: 'btn ghost icon', title: '더보기', onclick: (e) => moreMenu(e.currentTarget) }, icon('more')));
  const banner = h('div');
  const txCol = h('div', { class: 'tx-col' });
  const sideCol = h('div', { class: 'side-col' });
  const playerEl = h('div', { class: 'player' });
  main.append(h('div', { class: 'note' }, top, banner, h('div', { class: 'note-body' }, txCol, sideCol), playerEl));

  function renderMeta() {
    const n = V.note;
    const used = new Set(n.segments.map((s) => s.speaker));
    const folder = S.state.folders.find((f) => f.id === n.folder_id);
    fill(metaEl, fmtDate(n.recorded_at || n.created_at), h('span', { class: 'sep' }), fmtDur(n.duration),
      used.size ? [h('span', { class: 'sep' }), `참석자 ${used.size}명`] : null,
      h('span', { class: 'sep' }), TYPES.find((t) => t[0] === n.note_type)?.[1] || '회의',
      folder ? [h('span', { class: 'sep' }), `📁 ${folder.name}`] : null,
      n.engine ? [h('span', { class: 'sep' }), h('span', { title: '음성 인식 엔진' }, n.engine)] : null);
    starBtn.classList.toggle('active', !!n.favorite);
    starBtn.querySelector('svg').style.fill = n.favorite ? '#f5b300' : 'none';
    starBtn.querySelector('svg').style.stroke = n.favorite ? '#f5b300' : '';
  }

  async function toggleStar() {
    V.note.favorite = !V.note.favorite;
    await api(`/api/notes/${id}`, { method: 'PATCH', body: { favorite: V.note.favorite } });
    renderMeta();
    reloadAll();
  }

  function moreMenu(anchor) {
    menu(anchor, [
      { label: '다시 변환하기', icon: 'refresh', fn: reprocessDialog },
      { label: 'AI 요약 다시 만들기', icon: 'sparkle', fn: resummarize },
      { label: '찾아 바꾸기', icon: 'replace', fn: replaceDialog },
      { label: '폴더로 이동', icon: 'folder', fn: () => moveToFolder(V.note, (fid) => { V.note.folder_id = fid; renderMeta(); }) },
      { label: '녹음 파일 내려받기', icon: 'download', fn: () => download(`/api/notes/${id}/export?fmt=audio`) },
      '-',
      { label: '휴지통으로 이동', icon: 'trash', danger: true, fn: async () => { await trashNote(id); go('#/all'); } },
    ], { align: 'right' });
  }

  function reprocessDialog() {
    const lang = h('select', { class: 'sel' }, LANGS.map(([v, l]) => h('option', { value: v, selected: V.note.language === v ? '' : null }, l)));
    const spk = speakerSelect(V.note.num_speakers);
    const hint = h('input', { class: 'inp', value: V.note.hint || '', placeholder: '이름·전문 용어 (쉼표로 구분)' });
    const eng = h('select', { class: 'sel' }, h('option', { value: '' }, '현재 설정 유지'),
      S.state.engines.filter((e) => e.ok).map((e) => h('option', { value: e.key }, e.label)));
    const m = modalLite('다시 변환하기', [
      h('p', { style: { margin: 0, color: 'var(--text-2)' } }, '녹음을 처음부터 다시 받아씁니다. 수정한 대화 내용은 사라지고 참석자 이름은 유지됩니다.'),
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, '언어'), lang), h('div', { class: 'field' }, h('label', null, '참석자 수'), spk)),
      h('div', { class: 'field' }, h('label', null, '인식 엔진'), eng),
      h('div', { class: 'field' }, h('label', null, '키워드 등록'), hint)],
    async () => {
      await api(`/api/notes/${id}/reprocess`, { method: 'POST', body: { language: lang.value, num_speakers: Number(spk.value), hint: hint.value, engine: eng.value || undefined } });
      V.note.status = 'queued';
      renderAll();
      startPoll();
    }, '다시 변환');
    return m;
  }

  async function resummarize() {
    V.note.summary_status = 'running';
    renderSide();
    await api(`/api/notes/${id}/summarize`, { method: 'POST' });
    startPoll();
  }

  async function replaceDialog() {
    const find = h('input', { class: 'inp', placeholder: '찾을 말 (예: 김민 수)', value: V.search || '' });
    const repl = h('input', { class: 'inp', placeholder: '바꿀 말 (예: 김민수)' });
    modalLite('찾아 바꾸기', [h('div', { class: 'field' }, h('label', null, '찾을 말'), find), h('div', { class: 'field' }, h('label', null, '바꿀 말'), repl),
      h('span', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12.5px' } }, '전체 대화에서 한 번에 바꿉니다. 잘못 인식된 이름이나 용어를 고칠 때 편리합니다.')],
    async () => {
      if (!find.value) return;
      const r = await api(`/api/notes/${id}/replace`, { method: 'POST', body: { find: find.value, replace: repl.value } });
      toast(`${r.count}곳을 바꿨습니다`);
      await reload();
    }, '모두 바꾸기');
  }

  // ---------------------------------------------------------------- transcript
  const searchInput = h('input', {
    placeholder: '대화에서 찾기', value: '',
    oninput: debounce((e) => { V.search = e.target.value.trim(); V.matchIdx = -1; renderTranscript(); if (V.matches.length) gotoMatch(0); }, 150),
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); gotoMatch(V.matchIdx + (e.shiftKey ? -1 : 1)); }
      if (e.key === 'Escape') { e.target.value = ''; V.search = ''; renderTranscript(); e.target.blur(); }
    },
  });
  const matchInfo = h('span');
  const transcriptEl = h('div', { class: 'transcript scroll', onscroll: onUserScroll, onwheel: () => { V.userScrolled = Date.now(); } });
  const followBtn = h('button', { class: 'btn primary sm follow-btn', hidden: true, onclick: () => { V.follow = true; followBtn.hidden = true; scrollToActive(true); } }, icon('follow', 'sm'), '현재 재생 위치로');
  const filterEl = h('div', { class: 'speaker-filter' });
  txCol.append(
    h('div', { class: 'tx-tools' },
      h('div', { class: 'search' }, icon('search', 'sm'), searchInput, matchInfo),
      h('div', { class: 'nav' },
        h('button', { class: 'btn ghost icon sm', title: '이전 (⇧Enter)', onclick: () => gotoMatch(V.matchIdx - 1) }, icon('back', 'sm')),
        h('button', { class: 'btn ghost icon sm', title: '다음 (Enter)', onclick: () => gotoMatch(V.matchIdx + 1), style: { transform: 'scaleX(-1)' } }, icon('back', 'sm'))),
      h('div', { class: 'spacer' }), filterEl),
    h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, transcriptEl, followBtn));

  function onUserScroll() {
    if (V.userScrolled && Date.now() - V.userScrolled < 800 && V.audio && !V.audio.paused) {
      V.follow = false;
      followBtn.hidden = false;
    }
  }

  function renderFilter() {
    const used = [...new Set(V.note.segments.map((s) => s.speaker))].sort((a, b) => a - b);
    if (used.length < 2) { filterEl.replaceChildren(); return; }
    filterEl.replaceChildren(...used.map((i) => h('button', {
      class: `chip${V.speakerFilter === i ? ' green' : ''}`, title: '이 참석자의 발언만 강조',
      onclick: () => { V.speakerFilter = V.speakerFilter === i ? null : i; renderTranscript(); renderFilter(); },
    }, h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: speakerColor(i), display: 'inline-block' } }), nameOf(i))));
  }

  function textNodes(seg) {
    // Word spans when we have timings (click-to-seek + karaoke highlight); plain text otherwise.
    const q = V.search;
    if (q) {
      const parts = seg.text.split(new RegExp(`(${escapeRe(q)})`, 'gi'));
      return parts.map((p, i) => (i % 2 ? h('mark', { 'data-m': '1' }, p) : p));
    }
    if (seg.words && seg.words.length && !seg.edited) {
      const out = [];
      seg.words.forEach((w, i) => {
        if (i) out.push(' ');
        out.push(h('span', { class: 'w', 'data-s': w.s, 'data-e': w.e }, w.w));
      });
      return out;
    }
    return [seg.text];
  }

  function segEl(seg, i) {
    const text = h('div', { class: 'seg-text', ondblclick: () => editSeg(seg, text) }, textNodes(seg));
    text.addEventListener('click', (e) => {
      if (text.isContentEditable) return;
      const w = e.target.closest('.w');
      if (w && V.audio && !window.getSelection().toString()) seek(Number(w.dataset.s), true);
    });
    const hlBtn = h('button', { class: seg.highlight ? 'on' : '', title: '하이라이트', onclick: () => toggleHL(seg, el, hlBtn) }, icon('highlight', 'sm'));
    const el = h('div', { class: `seg${seg.highlight ? ' hl' : ''}${V.speakerFilter !== null && V.speakerFilter !== seg.speaker ? ' dim' : ''}`, 'data-i': i },
      h('div', { class: 'avatar', style: { background: speakerColor(seg.speaker) }, title: '참석자 변경', onclick: (e) => speakerMenu(e.currentTarget, seg) }, initials(nameOf(seg.speaker), seg.speaker)),
      h('div', { class: 'seg-main' },
        h('div', { class: 'seg-head' },
          h('span', { class: 'seg-name', onclick: (e) => speakerMenu(e.currentTarget, seg) }, nameOf(seg.speaker)),
          h('span', { class: 'seg-time', onclick: () => seek(seg.start, true), title: '여기서 재생' }, fmtTime(seg.start))),
        text),
      h('div', { class: 'seg-actions' },
        h('button', { title: '여기서 재생', onclick: () => seek(seg.start, true) }, icon('play', 'sm')),
        hlBtn,
        h('button', { title: '수정 (더블클릭)', onclick: () => editSeg(seg, text) }, icon('edit', 'sm')),
        h('button', { title: '복사', onclick: () => copyText(`${nameOf(seg.speaker)} ${fmtTime(seg.start)}\n${seg.text}`) }, icon('copy', 'sm')),
        h('button', { title: '더보기', onclick: (e) => segMenu(e.currentTarget, seg) }, icon('more', 'sm'))));
    V.segEls.set(seg.id, el);
    return el;
  }

  function renderTranscript() {
    V.segEls.clear();
    const n = V.note;
    if (n.status !== 'done' && !n.segments.length) {
      transcriptEl.replaceChildren(processingCard());
      return;
    }
    if (!n.segments.length) {
      transcriptEl.replaceChildren(h('div', { class: 'empty' }, h('h3', null, '인식된 대화가 없습니다'), '녹음에 말소리가 없거나 너무 작았을 수 있습니다.',
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: reprocessDialog }, '다시 변환하기'))));
      return;
    }
    transcriptEl.replaceChildren(...n.segments.map(segEl));
    V.matches = [...transcriptEl.querySelectorAll('mark[data-m]')];
    matchInfo.textContent = V.search ? `${V.matches.length ? V.matchIdx + 1 : 0}/${V.matches.length}` : '';
    V.activeSeg = -1;
    V.activeWord = null;
    syncPlayhead(true);
  }

  function gotoMatch(i) {
    if (!V.matches.length) return;
    V.matchIdx = (i + V.matches.length) % V.matches.length;
    V.matches.forEach((m, k) => m.classList.toggle('cur', k === V.matchIdx));
    const m = V.matches[V.matchIdx];
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    matchInfo.textContent = `${V.matchIdx + 1}/${V.matches.length}`;
    V.follow = false;
  }

  function processingCard() {
    const n = V.note;
    if (n.status === 'error') {
      return h('div', { class: 'processing-card' }, h('h3', null, '변환하지 못했습니다'), h('div', { class: 'err', style: { margin: '12px 0' } }, n.error || '알 수 없는 오류'),
        h('button', { class: 'btn primary', onclick: reprocessDialog }, '다시 시도'));
    }
    const pct = Math.round((n.progress || 0) * 100);
    return h('div', { class: 'processing-card' }, h('div', { class: 'spinner' }),
      h('h3', null, n.status === 'queued' ? '변환 대기 중' : n.stage || '변환 중'),
      h('div', { style: { color: 'var(--muted)', fontSize: '13px' } }, n.status === 'queued' ? '앞의 작업이 끝나면 시작합니다' : '음성을 텍스트로 바꾸고 참석자를 구분하고 있습니다'),
      h('div', { class: `progress${n.status === 'queued' ? ' indet' : ''}` }, h('div', { style: { width: `${pct}%` } })),
      h('div', { class: 'pct' }, n.status === 'queued' ? '' : `${pct}%${eta()}`),
      h('div', { style: { color: 'var(--muted)', fontSize: '12px', marginTop: '10px' } }, '다른 작업을 해도 괜찮습니다. 끝나면 자동으로 표시됩니다.'));
  }

  function eta() {
    const hs = V.progHist || [];
    if (hs.length < 3) return '';
    const a = hs[Math.max(0, hs.length - 15)], b = hs[hs.length - 1];
    const rate = (b.p - a.p) / ((b.t - a.t) / 1000);
    if (!(rate > 0) || b.t - a.t < 3000) return '';
    const left = (1 - b.p) / rate;
    return left < 60 ? ' · 1분 이내 남음' : ` · 약 ${Math.round(left / 60)}분 남음`;
  }

  async function toggleHL(seg, el, btn) {
    seg.highlight = !seg.highlight;
    el.classList.toggle('hl', seg.highlight);
    btn.classList.toggle('on', seg.highlight);
    await api(`/api/notes/${id}/segments/${seg.id}`, { method: 'PATCH', body: { highlight: seg.highlight } });
    if (V.tab === 'bookmarks') renderSide();
  }

  function editSeg(seg, text) {
    if (text.isContentEditable) return;
    const before = seg.text;
    text.textContent = seg.text;
    text.contentEditable = 'true';
    text.focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = async (save) => {
      text.removeEventListener('keydown', onKey);
      text.removeEventListener('blur', onBlur);
      text.contentEditable = 'false';
      const after = text.textContent.replace(/\s+/g, ' ').trim();
      if (save && after && after !== before) {
        seg.text = after;
        seg.edited = true;
        seg.words = [];
        await api(`/api/notes/${id}/segments/${seg.id}`, { method: 'PATCH', body: { text: after } });
        toast('수정했습니다');
      }
      text.replaceChildren(...textNodes(seg));
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    text.addEventListener('keydown', onKey);
    text.addEventListener('blur', onBlur);
  }

  function speakerMenu(anchor, seg) {
    const items = [{ header: '이 발언의 참석자' }];
    V.note.speakers.forEach((s) => items.push({
      label: s.name, check: s.idx === seg.speaker,
      fn: async () => { await api(`/api/notes/${id}/segments/${seg.id}`, { method: 'PATCH', body: { speaker: s.idx } }); seg.speaker = s.idx; afterSpeakerChange(); },
    }));
    items.push({ label: '새 참석자 추가', icon: 'plus', fn: async () => {
      const name = await promptDialog('새 참석자', `참석자 ${V.note.speakers.length + 1}`);
      if (!name) return;
      const r = await api(`/api/notes/${id}/speakers`, { method: 'POST', body: { name } });
      V.note.speakers.push({ idx: r.idx, name });
      await api(`/api/notes/${id}/segments/${seg.id}`, { method: 'PATCH', body: { speaker: r.idx } });
      seg.speaker = r.idx;
      afterSpeakerChange();
    } });
    items.push('-', { label: `'${nameOf(seg.speaker)}' 이름 바꾸기`, icon: 'edit', fn: () => renameSpeaker(seg.speaker) });
    if (V.note.speakers.length > 1) {
      items.push({ label: `'${nameOf(seg.speaker)}'을(를) 다른 참석자와 합치기`, icon: 'merge', fn: () => mergeSpeaker(anchor, seg.speaker) });
    }
    menu(anchor, items);
  }

  async function renameSpeaker(idx) {
    const name = await promptDialog('참석자 이름', nameOf(idx), { placeholder: '예: 김민수 팀장' });
    if (!name) return;
    await api(`/api/notes/${id}/speakers/${idx}`, { method: 'PUT', body: { name } });
    const sp = V.note.speakers.find((s) => s.idx === idx);
    if (sp) sp.name = name; else V.note.speakers.push({ idx, name });
    toast('모든 발언에 새 이름을 적용했습니다');
    afterSpeakerChange();
  }

  function mergeSpeaker(anchor, src) {
    menu(anchor, [{ header: `${nameOf(src)} → 합칠 대상` }, ...V.note.speakers.filter((s) => s.idx !== src).map((s) => ({
      label: s.name, fn: async () => {
        await api(`/api/notes/${id}/speakers/merge`, { method: 'POST', body: { src, dst: s.idx } });
        await reload();
        toast('참석자를 합쳤습니다');
      },
    }))]);
  }

  function afterSpeakerChange() {
    renderTranscript();
    renderFilter();
    renderMeta();
    drawWave();
    if (V.tab === 'summary') renderSide();
  }

  function segMenu(anchor, seg) {
    const i = V.note.segments.indexOf(seg);
    menu(anchor, [
      { label: '이 시점에 북마크', icon: 'bookmark', fn: () => addBookmark(seg.start, seg.text.slice(0, 40)) },
      { label: '메모에 인용', icon: 'memo', fn: () => { quoteToMemo(seg); } },
      i < V.note.segments.length - 1 ? { label: '다음 발언과 합치기', icon: 'merge', fn: async () => { await api(`/api/notes/${id}/segments/${seg.id}/merge-next`, { method: 'POST' }); reload(); } } : null,
      { label: '참석자 변경', icon: 'user', fn: () => speakerMenu(anchor, seg) },
    ].filter(Boolean), { align: 'right' });
  }

  // ---------------------------------------------------------------- side panel
  const tabsEl = h('div', { class: 'tabs' });
  const tabBody = h('div', { class: 'tab-body scroll' });
  sideCol.append(tabsEl, tabBody);
  const TABS = [['summary', 'AI 요약', 'sparkle'], ['minutes', '회의록', 'doc'], ['memo', '메모', 'memo'], ['bookmarks', '북마크', 'bookmark'], ['chat', 'AI 질문', 'chat']];

  function renderTabs() {
    const bmCount = V.note.bookmarks.length + V.note.segments.filter((s) => s.highlight).length;
    tabsEl.replaceChildren(...TABS.map(([k, l]) => h('button', { class: `tab${V.tab === k ? ' active' : ''}`, onclick: () => { V.tab = k; localStorage.setItem('mn.tab', k); renderTabs(); renderSide(); } },
      l, k === 'bookmarks' && bmCount ? h('span', { class: 'n' }, bmCount) : null)));
  }

  function tlink(t) {
    if (t === null || t === undefined) return null;
    return h('button', { class: 'tlink', title: '이 부분 재생', onclick: () => seek(t, true) }, fmtTime(t));
  }

  function summaryWaiting() {
    const n = V.note;
    if (n.status !== 'done') return h('div', { class: 'sec', style: { textAlign: 'center', color: 'var(--muted)' } }, '받아쓰기가 끝나면 AI가 요약합니다.');
    if (n.summary_status === 'running') return h('div', { class: 'sec', style: { textAlign: 'center' } }, h('div', { class: 'spinner', style: { width: '28px', height: '28px', margin: '6px auto 10px', borderRadius: '50%', border: '3px solid var(--accent-weak)', borderTopColor: 'var(--accent)', animation: 'spin 1s linear infinite' } }), h('b', null, 'AI가 회의 내용을 정리하고 있습니다'), h('div', { style: { color: 'var(--muted)', fontSize: '12.5px', marginTop: '4px' } }, '핵심 요약 · 주제 · 결정 사항 · 할 일'));
    return h('div', { class: 'sec', style: { textAlign: 'center' } }, h('p', { style: { color: 'var(--muted)', marginBottom: '12px' } }, 'AI 요약이 아직 없습니다.'),
      h('button', { class: 'btn primary', onclick: resummarize }, icon('sparkle', 'sm'), 'AI 요약 만들기'));
  }

  function talkTimes() {
    const t = {};
    for (const s of V.note.segments) t[s.speaker] = (t[s.speaker] || 0) + (s.end - s.start);
    return t;
  }

  // Editable text: plain in view mode, contenteditable in edit mode.
  function ed(tag, obj, key, attrs = {}) {
    const el = h(tag, attrs, obj[key]);
    if (V.editSummary) {
      el.contentEditable = 'true';
      el.classList.add('editable');
      el.addEventListener('blur', () => { obj[key] = el.innerText.trim(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.blur(); } });
    }
    return el;
  }

  function listSec(sm, key, title, ic, ordered = false) {
    const arr = sm[key] || (sm[key] = []);
    if (!arr.length && !V.editSummary) return null;
    return h('div', { class: 'sec' }, h('h4', null, icon(ic, 'sm'), title),
      h(ordered ? 'ol' : 'ul', null, arr.map((_, i) => h('li', null, ed('span', arr, i),
        V.editSummary ? h('button', { class: 'x-btn', title: '삭제', onclick: () => { arr.splice(i, 1); renderSide(); } }, icon('x', 'sm')) : null))),
      V.editSummary ? h('button', { class: 'add-btn', onclick: () => { arr.push('새 항목'); renderSide(); } }, icon('plus', 'sm'), '추가') : null);
  }

  function renderSummary() {
    const sm = V.note.summary;
    if (!sm || V.note.summary_status === 'running' || V.note.status !== 'done') return [summaryWaiting()];
    const out = [];
    const E = V.editSummary;
    if (V.note.summary_error && !E) out.push(h('div', { class: 'err', style: { marginBottom: '12px' } }, V.note.summary_error));
    if (E) out.push(h('div', { class: 'edit-bar' }, icon('edit', 'sm'), '요약 편집 중 — 글자를 눌러 고치세요',
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: async () => { V.editSummary = false; V.note = await api(`/api/notes/${id}`); renderSide(); } }, '취소'),
      h('button', { class: 'btn sm primary', onclick: async () => { document.activeElement?.blur(); await saveSummary(); V.editSummary = false; toast('요약을 저장했습니다'); renderSide(); } }, '저장')));
    if (sm.one_line || E) out.push(h('div', { class: 'sec oneline-sec' }, h('h4', null, icon('sparkle', 'sm'), '한 줄 요약'), ed('div', sm, 'one_line', { class: 'oneline' })));
    if (sm.overview || E) out.push(h('div', { class: 'sec' }, h('h4', null, icon('notes', 'sm'), '요약'), ed('p', sm, 'overview')));
    if (sm.topics?.length) {
      out.push(h('div', { class: 'sec' }, h('h4', null, icon('list', 'sm'), '주요 주제'),
        sm.topics.map((t, i) => h('div', { class: 'topic' },
          h('div', { class: 'topic-h' }, `${i + 1}.`, ed('span', t, 'title'), tlink(t.start),
            E ? h('button', { class: 'x-btn', title: '주제 삭제', onclick: () => { sm.topics.splice(i, 1); renderSide(); } }, icon('x', 'sm')) : null),
          h('ul', null, (t.points || []).map((_, j) => h('li', null, ed('span', t.points, j),
            E ? h('button', { class: 'x-btn', onclick: () => { t.points.splice(j, 1); renderSide(); } }, icon('x', 'sm')) : null))),
          E ? h('button', { class: 'add-btn', onclick: () => { (t.points ||= []).push('새 내용'); renderSide(); } }, icon('plus', 'sm'), '내용 추가') : null))));
    }
    out.push(listSec(sm, 'decisions', '결정 사항', 'check'));
    const acts = sm.action_items || (sm.action_items = []);
    if (acts.length || E) {
      out.push(h('div', { class: 'sec' }, h('h4', null, icon('flag', 'sm'), `할 일 ${acts.filter((a) => a.done).length}/${acts.length}`),
        acts.map((a, i) => {
          const row = h(E ? 'div' : 'label', { class: `todo${a.done ? ' done' : ''}` },
            h('input', { type: 'checkbox', checked: a.done, onchange: async (e) => { a.done = e.target.checked; row.classList.toggle('done', a.done); if (!E) { await saveSummary(); renderSide(); } } }),
            h('div', { style: { flex: 1 } }, ed('div', a, 'task', { class: 'todo-t' }),
              E ? h('div', { class: 'todo-meta' }, h('input', { class: 'inp mini', placeholder: '담당', value: a.owner || '', oninput: (e) => { a.owner = e.target.value; } }),
                h('input', { class: 'inp mini', placeholder: '기한', value: a.due || '', oninput: (e) => { a.due = e.target.value; } }))
                : h('div', { class: 'todo-meta' }, a.owner ? h('span', { class: 'chip' }, icon('user', 'sm'), a.owner) : null, a.due ? h('span', { class: 'chip warn' }, icon('clock', 'sm'), a.due) : null, tlink(a.start))),
            E ? h('button', { class: 'x-btn', onclick: () => { acts.splice(i, 1); renderSide(); } }, icon('x', 'sm')) : null);
          return row;
        }),
        E ? h('button', { class: 'add-btn', onclick: () => { acts.push({ task: '새 할 일', owner: '', due: '', time: '', start: null, done: false }); renderSide(); } }, icon('plus', 'sm'), '할 일 추가') : null));
    }
    out.push(listSec(sm, 'open_issues', '미결 · 확인 필요', 'alert'));
    out.push(listSec(sm, 'key_points', '핵심 내용', 'target'));
    if (sm.keywords?.length && !E) {
      out.push(h('div', { class: 'sec' }, h('h4', null, icon('search', 'sm'), '키워드'),
        h('div', { class: 'kw-wrap' }, sm.keywords.map((k) => h('button', { class: 'chip', title: '대화에서 찾기', onclick: () => { searchInput.value = k; V.search = k; V.matchIdx = -1; renderTranscript(); gotoMatch(0); } }, `#${k}`)))));
    }
    const tt = talkTimes();
    const total = Object.values(tt).reduce((a, b) => a + b, 0) || 1;
    const partSum = Object.fromEntries((sm.participants || []).map((p) => [p.name, p.summary]));
    const order = Object.keys(tt).map(Number).sort((a, b) => tt[b] - tt[a]);
    if (order.length && !E) {
      out.push(h('div', { class: 'sec' }, h('h4', null, icon('users', 'sm'), '참석자'),
        order.map((i) => h('div', { class: 'part' }, h('div', { class: 'avatar', style: { background: speakerColor(i) }, onclick: () => renameSpeaker(i), title: '이름 바꾸기' }, initials(nameOf(i), i)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('b', { style: { cursor: 'pointer' }, onclick: () => renameSpeaker(i) }, nameOf(i)), h('span', { style: { color: 'var(--muted)', fontSize: '12px' } }, `${fmtDur(tt[i])} · ${Math.round((100 * tt[i]) / total)}%`)),
            h('div', { class: 'bar' }, h('div', { style: { width: `${(100 * tt[i]) / total}%`, background: speakerColor(i) } })),
            partSum[nameOf(i)] ? h('div', { style: { fontSize: '12.5px', color: 'var(--text-2)' } }, partSum[nameOf(i)]) : null)))));
    }
    if (!E) {
      const usageEl = h('span', { class: 'usage', title: '이 노트의 요약·AI 질문에 쓴 Claude 토큰 (입력/출력)과 예상 비용' });
      api(`/api/usage?note=${id}`).then((u) => { if (u.n) usageEl.textContent = `· 토큰 ${fmtK(u.inp)}/${fmtK(u.out)} · $${u.cost.toFixed(3)}`; }).catch(() => {});
      out.push(h('div', { class: 'sum-foot' }, icon('sparkle', 'sm'), V.note.summary_provider || '', usageEl, h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm', onclick: () => { V.editSummary = true; renderSide(); } }, icon('edit', 'sm'), '편집'),
        h('button', { class: 'btn ghost sm', onclick: () => copyText(summaryText()) }, icon('copy', 'sm'), '복사'),
        h('button', { class: 'btn ghost sm', onclick: resummarize }, icon('refresh', 'sm'), '다시 요약')));
    }
    return out.filter(Boolean);
  }

  function summaryText() {
    const sm = V.note.summary || {};
    const L = [V.note.title, ''];
    if (sm.one_line) L.push(`■ 한 줄 요약\n${sm.one_line}`, '');
    if (sm.overview) L.push(`■ 요약\n${sm.overview}`, '');
    if (sm.topics?.length) L.push('■ 주요 주제', ...sm.topics.flatMap((t, i) => [`${i + 1}. ${t.title}`, ...(t.points || []).map((p) => `  - ${p}`)]), '');
    if (sm.decisions?.length) L.push('■ 결정 사항', ...sm.decisions.map((d) => `- ${d}`), '');
    if (sm.action_items?.length) L.push('■ 할 일', ...sm.action_items.map((a) => `- [${a.done ? 'x' : ' '}] ${a.task}${a.owner ? ` (${a.owner})` : ''}${a.due ? ` ~${a.due}` : ''}`), '');
    if (sm.open_issues?.length) L.push('■ 미결 사항', ...sm.open_issues.map((d) => `- ${d}`), '');
    return L.join('\n').trim();
  }

  async function saveSummary() {
    await api(`/api/notes/${id}/summary`, { method: 'PUT', body: V.note.summary });
  }

  function renderMinutes() {
    const n = V.note, sm = n.summary || {};
    const used = [...new Set(n.segments.map((s) => s.speaker))].map(nameOf);
    const when = new Date((n.recorded_at || n.created_at) * 1000);
    const date = `${when.getFullYear()}.${String(when.getMonth() + 1).padStart(2, '0')}.${String(when.getDate()).padStart(2, '0')} (${'일월화수목금토'[when.getDay()]}) ${when.toTimeString().slice(0, 5)}`;
    if (n.status !== 'done') return [summaryWaiting()];
    const doc = h('div', { class: 'minutes', id: 'minutes-doc' },
      h('h1', null, n.title),
      h('table', null, h('tbody', null,
        h('tr', null, h('td', { class: 'k' }, '일시'), h('td', null, date)),
        h('tr', null, h('td', { class: 'k' }, '소요 시간'), h('td', null, fmtDur(n.duration))),
        h('tr', null, h('td', { class: 'k' }, '참석자'), h('td', null, used.join(', ') || '-')),
        sm.keywords?.length ? h('tr', null, h('td', { class: 'k' }, '키워드'), h('td', null, sm.keywords.join(', '))) : null)),
      sm.overview ? [h('h2', null, '회의 요약'), h('p', null, sm.overview)] : null,
      sm.topics?.length ? [h('h2', null, '논의 내용'), sm.topics.map((t, i) => [h('h3', null, `${i + 1}. ${t.title}`), h('ul', null, (t.points || []).map((p) => h('li', null, p)))])] : null,
      sm.decisions?.length ? [h('h2', null, '결정 사항'), h('ol', null, sm.decisions.map((d) => h('li', null, d)))] : null,
      sm.action_items?.length ? [h('h2', null, '향후 조치 (Action Items)'), h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'No'), h('th', null, '할 일'), h('th', null, '담당'), h('th', null, '기한'))),
        h('tbody', null, sm.action_items.map((a, i) => h('tr', null, h('td', null, i + 1), h('td', null, a.task), h('td', null, a.owner || '-'), h('td', null, a.due || '-')))))] : null,
      sm.open_issues?.length ? [h('h2', null, '미결 사항'), h('ul', null, sm.open_issues.map((d) => h('li', null, d)))] : null,
      n.memo ? [h('h2', null, '메모'), h('p', { style: { whiteSpace: 'pre-wrap' } }, n.memo)] : null);
    if (!n.summary) doc.append(h('p', { style: { color: 'var(--muted)' } }, 'AI 요약을 만들면 회의록이 자동으로 채워집니다.'));
    return [
      h('div', { class: 'row no-print', style: { marginBottom: '10px' } },
        h('button', { class: 'btn sm', onclick: () => download(`/api/notes/${id}/export?fmt=docx`) }, icon('download', 'sm'), 'Word'),
        h('button', { class: 'btn sm', onclick: () => copyText(doc.innerText) }, icon('copy', 'sm'), '복사'),
        h('button', { class: 'btn sm', onclick: copyMinutesRich }, icon('doc', 'sm'), '서식 복사'),
        h('button', { class: 'btn sm', onclick: () => window.print() }, icon('print', 'sm'), '인쇄 · PDF')),
      doc];
  }

  async function copyMinutesRich() {
    const doc = document.getElementById('minutes-doc');
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([doc.outerHTML], { type: 'text/html' }), 'text/plain': new Blob([doc.innerText], { type: 'text/plain' }) })]);
      toast('서식과 함께 복사했습니다 (메일·워드에 붙여넣기)');
    } catch { copyText(doc.innerText); }
  }

  function renderMemo() {
    const status = h('span', { style: { color: 'var(--muted)', fontSize: '12px' } }, '자동 저장');
    const save = debounce(async (v) => { await api(`/api/notes/${id}`, { method: 'PATCH', body: { memo: v } }); V.note.memo = v; status.textContent = '저장됨'; }, 600);
    const ta = h('textarea', { class: 'memo-area', placeholder: '회의 중 떠오른 생각, 추가 정보, 후속 조치를 적어 두세요.\n\n[시간 넣기]를 누르면 현재 재생 위치가 기록됩니다.', value: V.note.memo || '',
      oninput: (e) => { status.textContent = '저장 중…'; save(e.target.value); } });
    V.memoEl = ta;
    return [h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('button', { class: 'btn sm', onclick: () => insertAtCursor(ta, `[${fmtTime(V.audio?.currentTime || 0)}] `) }, icon('clock', 'sm'), '시간 넣기'),
      h('span', { class: 'spacer' }), status), ta];
  }

  function insertAtCursor(ta, text) {
    const s = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd ?? s);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.dispatchEvent(new Event('input'));
  }

  function quoteToMemo(seg) {
    V.tab = 'memo';
    renderTabs();
    renderSide();
    insertAtCursor(V.memoEl, `${V.memoEl.value && !V.memoEl.value.endsWith('\n') ? '\n' : ''}> [${fmtTime(seg.start)}] ${nameOf(seg.speaker)}: ${seg.text}\n`);
  }

  async function addBookmark(t, label = '') {
    const b = await api(`/api/notes/${id}/bookmarks`, { method: 'POST', body: { t, label } });
    V.note.bookmarks.push(b);
    V.note.bookmarks.sort((a, c) => a.t - c.t);
    toast(`${fmtTime(t)}에 북마크를 추가했습니다`);
    renderTabs();
    if (V.tab === 'bookmarks') renderSide();
    drawWave();
  }

  function renderBookmarks() {
    const out = [h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn sm primary', onclick: () => addBookmark(V.audio?.currentTime || 0) }, icon('bookmark', 'sm'), '현재 위치 북마크'),
      h('span', { style: { color: 'var(--muted)', fontSize: '12px' } }, '재생 중 B 키로도 추가'))];
    if (V.note.bookmarks.length) {
      out.push(h('h4', { style: { margin: '6px 2px 8px', fontSize: '12px', color: 'var(--muted)' } }, '북마크'));
      out.push(...V.note.bookmarks.map((b) => h('div', { class: 'bm' }, tlink(b.t),
        h('input', { value: b.label, placeholder: '설명 추가', onchange: async (e) => { b.label = e.target.value; await api(`/api/notes/${id}/bookmarks/${b.id}`, { method: 'PATCH', body: { label: b.label } }); } }),
        h('button', { class: 'btn ghost icon sm', title: '삭제', onclick: async () => { await api(`/api/notes/${id}/bookmarks/${b.id}`, { method: 'DELETE' }); V.note.bookmarks = V.note.bookmarks.filter((x) => x !== b); renderSide(); renderTabs(); drawWave(); } }, icon('x', 'sm')))));
    }
    const hls = V.note.segments.filter((s) => s.highlight);
    if (hls.length) {
      out.push(h('h4', { style: { margin: '16px 2px 8px', fontSize: '12px', color: 'var(--muted)' } }, '하이라이트한 발언'));
      out.push(...hls.map((s) => h('div', { class: 'bm', style: { cursor: 'pointer' }, onclick: () => { seek(s.start, false); scrollToSeg(s); } }, tlink(s.start),
        h('div', { class: 'quote' }, h('b', null, nameOf(s.speaker), ' '), s.text))));
    }
    if (!V.note.bookmarks.length && !hls.length) out.push(h('div', { class: 'empty', style: { padding: '40px 10px' } }, '중요한 순간을 북마크하거나', h('br'), '발언에 마우스를 올려 하이라이트하세요.'));
    return out;
  }

  function linkify(text) {
    // [mm:ss] or [h:mm:ss] in answers become seek buttons.
    const parts = text.split(/(\[\d{1,2}:\d{2}(?::\d{2})?\])/g);
    return parts.map((p) => {
      const m = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]$/.exec(p);
      if (!m) return p;
      const t = m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
      return tlink(t);
    });
  }

  async function renderChat() {
    const log = h('div', { class: 'chat-log' });
    const ta = h('textarea', { class: 'inp', placeholder: '이 회의에 대해 물어보세요 (Enter 전송)', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
    const sendBtn = h('button', { class: 'btn primary icon', onclick: () => send(), title: '보내기' }, icon('send', 'sm'));
    const wrap = h('div', { class: 'chat' }, log, h('div', { class: 'chat-input' }, ta, sendBtn));
    const history = await api(`/api/notes/${id}/chat`);
    const draw = () => {
      if (!history.length) {
        const qs = ['결정된 사항을 정리해 줘', '누가 무엇을 하기로 했어?', '가장 많이 논의된 주제는 뭐야?', '추가로 확인이 필요한 사항은?', '일정이나 기한이 언급된 부분을 알려줘'];
        log.replaceChildren(h('div', { style: { color: 'var(--muted)', fontSize: '13px', margin: '4px 2px 10px' } }, '녹취록을 바탕으로 AI가 답합니다. 답변의 시간을 누르면 해당 부분을 재생합니다.'),
          h('div', { class: 'suggest' }, qs.map((q) => h('button', { onclick: () => send(q) }, q))));
        return;
      }
      log.replaceChildren(...history.map((m) => h('div', { class: `msg ${m.role}${m.pending ? ' pending' : ''}` }, m.role === 'assistant' ? linkify(m.content) : m.content)),
        h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn ghost sm', onclick: async () => { await api(`/api/notes/${id}/chat`, { method: 'DELETE' }); history.length = 0; draw(); } }, '대화 지우기')));
      log.scrollTop = log.scrollHeight;
    };
    async function send(q) {
      q = (q || ta.value).trim();
      if (!q) return;
      ta.value = '';
      history.push({ role: 'user', content: q });
      const pending = { role: 'assistant', content: '답변을 작성하고 있습니다…', pending: true };
      history.push(pending);
      draw();
      sendBtn.disabled = true;
      try {
        const r = await api(`/api/notes/${id}/chat`, { method: 'POST', body: { question: q } });
        Object.assign(pending, r, { pending: false });
      } catch (e) {
        Object.assign(pending, { content: `오류: ${e.message}`, pending: false });
      }
      sendBtn.disabled = false;
      draw();
    }
    draw();
    return [wrap];
  }

  async function renderSide() {
    let content;
    if (V.tab === 'summary') content = renderSummary();
    else if (V.tab === 'minutes') content = renderMinutes();
    else if (V.tab === 'memo') content = renderMemo();
    else if (V.tab === 'bookmarks') content = renderBookmarks();
    else content = await renderChat();
    tabBody.style.display = V.tab === 'chat' ? 'flex' : '';
    tabBody.style.flexDirection = 'column';
    fill(tabBody, content);
  }

  // ---------------------------------------------------------------- player
  const playBtn = h('button', { class: 'pbtn', title: '재생/일시정지 (Space)', onclick: togglePlay }, icon('play', 'lg'));
  const timeEl = h('div', { class: 'ptime' }, '00:00 / 00:00');
  const canvas = h('canvas');
  const tip = h('div', { class: 'tip' });
  const waveEl = h('div', { class: 'wave', title: '' }, canvas, tip);
  const speedSel = h('select', { class: 'speed', title: '재생 속도', onchange: (e) => { if (V.audio) V.audio.playbackRate = Number(e.target.value); localStorage.setItem('mn.rate', e.target.value); } },
    [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5].map((r) => h('option', { value: r, selected: Number(localStorage.getItem('mn.rate') || 1) === r ? '' : null }, `${r}x`)));
  const skip = () => Number(S.state.settings.skip_seconds || 5);
  V.skipSilence = localStorage.getItem('mn.skipSilence') === '1';
  const silenceBtn = h('button', {
    class: `btn ghost sm${V.skipSilence ? ' active' : ''}`, title: '말소리가 없는 구간을 건너뛰고 재생합니다',
    onclick: () => { V.skipSilence = !V.skipSilence; localStorage.setItem('mn.skipSilence', V.skipSilence ? '1' : '0'); silenceBtn.classList.toggle('active', V.skipSilence); toast(V.skipSilence ? '무음 구간을 건너뜁니다' : '무음 건너뛰기를 껐습니다'); },
  }, '무음 건너뛰기');
  playerEl.append(
    h('button', { class: 'skip', title: `${skip()}초 뒤로 (←)`, onclick: () => seek((V.audio?.currentTime || 0) - skip()) }, icon('rew'), h('small', null, skip())),
    playBtn,
    h('button', { class: 'skip', title: `${skip()}초 앞으로 (→)`, onclick: () => seek((V.audio?.currentTime || 0) + skip()) }, icon('fwd'), h('small', null, skip())),
    timeEl, waveEl, silenceBtn, speedSel,
    h('button', { class: 'btn ghost icon', title: '현재 위치 북마크 (B)', onclick: () => addBookmark(V.audio?.currentTime || 0) }, icon('bookmark')));

  function setupAudio() {
    if (!V.note.audio_file) return;
    if (V.audio) { V.audio.pause(); V.audio.src = ''; }
    const a = new Audio(`/api/notes/${id}/audio?v=${encodeURIComponent(V.note.audio_file)}`);
    a.preload = 'metadata';
    a.playbackRate = Number(speedSel.value);
    a.addEventListener('play', () => { playBtn.replaceChildren(icon('pause', 'lg')); loop(); });
    a.addEventListener('pause', () => { playBtn.replaceChildren(icon('play', 'lg')); });
    a.addEventListener('loadedmetadata', () => syncPlayhead(true));
    a.addEventListener('seeked', () => syncPlayhead(true));
    V.audio = a;
  }

  function togglePlay() {
    if (!V.audio) return;
    if (V.audio.paused) V.audio.play().catch((e) => toast(`재생할 수 없습니다: ${e.message}`, { error: true }));
    else V.audio.pause();
  }

  function seek(t, play = false) {
    if (!V.audio) return;
    const d = duration();
    V.audio.currentTime = Math.max(0, Math.min(d || t, t));
    V.follow = true;
    followBtn.hidden = true;
    syncPlayhead(true);
    if (play && V.audio.paused) togglePlay();
  }

  const duration = () => (V.audio && isFinite(V.audio.duration) && V.audio.duration) || V.note.duration || 0;

  function loop() {
    cancelAnimationFrame(V.raf);
    const step = () => {
      if (V.destroyed) return;
      syncPlayhead(false);
      if (V.audio && !V.audio.paused) V.raf = requestAnimationFrame(step);
    };
    V.raf = requestAnimationFrame(step);
  }

  function findSeg(t) {
    const segs = V.note.segments;
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function syncPlayhead(force) {
    const t = V.audio ? V.audio.currentTime : 0;
    if (V.skipSilence && V.audio && !V.audio.paused && V.note.segments.length) {
      const k = findSeg(t);
      const cur = V.note.segments[k], next = V.note.segments[k + 1];
      const gapEnd = k < 0 ? V.note.segments[0].start : (next && t > cur.end + 0.25 ? next.start : null);
      if (gapEnd !== null && gapEnd - t > 1.0) { V.audio.currentTime = gapEnd - 0.2; return; }
    }
    timeEl.textContent = `${fmtTime(t)} / ${fmtTime(duration())}`;
    drawWave();
    const i = findSeg(t);
    if (i !== V.activeSeg || force) {
      const prev = V.note.segments[V.activeSeg];
      if (prev) V.segEls.get(prev.id)?.classList.remove('active');
      V.activeSeg = i;
      const cur = V.note.segments[i];
      if (cur && t <= cur.end + 1.5) {
        V.segEls.get(cur.id)?.classList.add('active');
        if (V.follow && (!V.audio?.paused || force)) scrollToActive(false);
      }
    }
    // karaoke: current word
    const seg = V.note.segments[V.activeSeg];
    const el = seg && V.segEls.get(seg.id);
    let wordEl = null;
    if (el && !V.audio?.paused) {
      const ws = el.querySelectorAll('.w');
      for (const w of ws) { if (Number(w.dataset.s) <= t + 0.02 && t < Number(w.dataset.e) + 0.15) wordEl = w; }
    }
    if (wordEl !== V.activeWord) {
      V.activeWord?.classList.remove('now');
      wordEl?.classList.add('now');
      V.activeWord = wordEl;
    }
  }

  function scrollToActive(smooth) {
    const seg = V.note.segments[V.activeSeg];
    const el = seg && V.segEls.get(seg.id);
    if (!el) return;
    const box = transcriptEl.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (smooth || r.top < box.top + 40 || r.bottom > box.bottom - 60) {
      transcriptEl.scrollTo({ top: transcriptEl.scrollTop + r.top - box.top - box.height * 0.3, behavior: 'smooth' });
    }
  }

  function scrollToSeg(s) {
    const el = V.segEls.get(s.id);
    el && el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = waveEl.clientWidth, hgt = waveEl.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#11b36b';
    const muted = css.getPropertyValue('--line').trim() || '#ddd';
    const peaks = V.note.peaks || [];
    const d = duration();
    const t = V.audio ? V.audio.currentTime : 0;
    const px = d ? (t / d) * w : 0;
    const barW = 2, gap = 1, n = Math.floor(w / (barW + gap));
    const waveH = hgt - 10;
    for (let i = 0; i < n; i++) {
      const p = peaks.length ? peaks[Math.floor((i / n) * peaks.length)] || 0 : 0.15;
      const bh = Math.max(2, p * (waveH - 4));
      const x = i * (barW + gap);
      ctx.fillStyle = x < px ? accent : muted;
      ctx.fillRect(x, (waveH - bh) / 2, barW, bh);
    }
    // speaker timeline strip
    if (d) {
      for (const s of V.note.segments) {
        ctx.fillStyle = css.getPropertyValue(`--s${(s.speaker % 8) + 1}`).trim();
        ctx.globalAlpha = 0.85;
        ctx.fillRect((s.start / d) * w, hgt - 5, Math.max(1, ((s.end - s.start) / d) * w), 4);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f5b300';
      for (const b of V.note.bookmarks) {
        const x = (b.t / d) * w;
        ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6); ctx.fill();
      }
      ctx.fillStyle = css.getPropertyValue('--text').trim();
      ctx.fillRect(px - 1, 0, 2, waveH);
    }
  }

  let dragging = false;
  const posToTime = (e) => { const r = waveEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration(); };
  waveEl.addEventListener('mousedown', (e) => { dragging = true; seek(posToTime(e)); });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  function onMove(e) {
    if (dragging) seek(posToTime(e));
    const r = waveEl.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      const t = posToTime(e);
      const seg = V.note.segments[findSeg(t)];
      tip.textContent = fmtTime(t) + (seg && t <= seg.end + 1 ? ` · ${nameOf(seg.speaker)}` : '');
      tip.style.left = `${e.clientX - r.left}px`;
    }
  }
  function onUp() { dragging = false; }
  const ro = new ResizeObserver(() => drawWave());
  ro.observe(waveEl);

  function onKey(e) {
    if (isTyping(e) || document.querySelector('.backdrop')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
    if (mod) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek((V.audio?.currentTime || 0) - skip()); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek((V.audio?.currentTime || 0) + skip()); }
    else if (e.key.toLowerCase() === 'b') addBookmark(V.audio?.currentTime || 0);
  }
  window.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------- data refresh
  function renderBanner() {
    const n = V.note;
    const warn = n.status === 'done' && S.state.summary_provider === 'local' && n.summary && !localStorage.getItem('mn.hideAiTip');
    banner.replaceChildren(...(warn ? [h('div', { class: 'note-banner' }, icon('info', 'sm'),
      '오프라인 내장 요약을 사용 중입니다. 설정 > AI 요약에서 Claude 키를 등록하거나 Ollama를 연결하면 훨씬 자연스러운 회의록을 만듭니다.',
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => import('./dialogs.js').then((d) => d.openSettings('ai')) }, '설정 열기'),
      h('button', { class: 'btn ghost icon sm', onclick: () => { localStorage.setItem('mn.hideAiTip', '1'); renderBanner(); } }, icon('x', 'sm')))] : []));
  }

  function renderAll() {
    renderMeta();
    renderBanner();
    renderFilter();
    renderTranscript();
    renderTabs();
    renderSide();
    drawWave();
  }

  async function reload() {
    const t = V.audio?.currentTime || 0;
    const hadAudio = V.note.audio_file;
    V.note = await api(`/api/notes/${id}`);
    if (!V.audio || hadAudio !== V.note.audio_file) setupAudio();
    renderAll();
    if (V.audio && t) V.audio.currentTime = t;
  }

  function startPoll() {
    clearTimeout(V.pollTimer);
    const tick = async () => {
      if (V.destroyed) return;
      let st;
      try { st = await api(`/api/notes/${id}/status`); } catch { V.pollTimer = setTimeout(tick, 2000); return; }
      const wasDone = V.note.status === 'done';
      const sumChanged = st.summary_status !== V.note.summary_status;
      Object.assign(V.note, { status: st.status, stage: st.stage, progress: st.progress, error: st.error });
      if (st.status === 'processing') (V.progHist ||= []).push({ t: Date.now(), p: st.progress });
      if (st.status === 'done' && (!wasDone || sumChanged || st.summary_status !== 'running')) {
        await reload();
        titleInput.value = V.note.title;
      } else if (st.status !== 'done') {
        renderTranscript();
      }
      if (['queued', 'processing'].includes(st.status) || st.summary_status === 'running') V.pollTimer = setTimeout(tick, 1000);
      else reloadAll();
    };
    V.pollTimer = setTimeout(tick, 800);
  }

  setupAudio();
  renderAll();
  if (['queued', 'processing'].includes(note.status) || note.summary_status === 'running') startPoll();
  if (opts.t) setTimeout(() => { seek(Number(opts.t)); scrollToActive(true); }, 150);

  return () => {
    V.destroyed = true;
    clearTimeout(V.pollTimer);
    cancelAnimationFrame(V.raf);
    if (V.audio) { V.audio.pause(); V.audio.src = ''; }
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    ro.disconnect();
  };
}

function fmtK(n) { return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString(); }

function modalLite(title, body, onOk, okLabel = '확인') {
  const m = modal({
    title, body,
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: async () => { m.close(); await onOk(); } }, okLabel)],
  });
  return m;
}

export { confirmDialog };
