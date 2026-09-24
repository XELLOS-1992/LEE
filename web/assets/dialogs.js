import { h, icon, api, modal, toast, uploadFile, download, fmtDur, promptDialog } from './util.js';
import { S, go, reloadAll, refreshState, applyTheme, askNotificationPermission } from './app.js';

export const LANGS = [['ko', '한국어'], ['en', 'English'], ['ja', '日本語'], ['zh', '中文'], ['auto', '자동 감지']];
export const TYPES = [['meeting', '회의'], ['interview', '인터뷰'], ['lecture', '강의'], ['call', '통화'], ['memo', '개인 메모']];

export function speakerSelect(value = 0) {
  return h('select', { class: 'sel' },
    h('option', { value: 0 }, '자동 감지'),
    Array.from({ length: 10 }, (_, i) => h('option', { value: i + 1, selected: Number(value) === i + 1 ? '' : null }, `${i + 1}명`)));
}

function sel(options, value) {
  return h('select', { class: 'sel' }, options.map(([v, l]) => h('option', { value: v, selected: v === value ? '' : null }, l)));
}

// ------------------------------------------------------------------ upload
const ACCEPT = 'audio/*,video/*,.m4a,.mp3,.wav,.aac,.flac,.ogg,.opus,.webm,.mp4,.mov,.mkv,.amr,.3gp,.wma';

export function openUpload(initial = []) {
  const s = S.state.settings;
  let files = [...initial];
  const list = h('div', { class: 'files' });
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true, onchange: (e) => { add([...e.target.files]); e.target.value = ''; } });
  const drop = h('div', {
    class: 'drop', onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); add([...e.dataTransfer.files]); },
  }, icon('upload', 'lg'), h('b', null, '파일을 끌어다 놓거나 클릭해서 선택'), h('span', null, 'm4a · mp3 · wav · mp4 · mov · webm 등 음성·영상 파일, 여러 개 가능'));
  const lang = sel(LANGS, s.language);
  const spk = speakerSelect(0);
  const type = sel(TYPES, 'meeting');
  const hint = h('input', { class: 'inp', placeholder: '예: 김민수, 박지영, OKR, 쿠버네티스, 3분기 매출' });
  const folder = h('select', { class: 'sel' }, h('option', { value: '' }, '폴더 없음'),
    S.state.folders.map((f) => h('option', { value: f.id, selected: S.route?.folder === f.id ? '' : null }, f.name)));
  const go_ = h('button', { class: 'btn primary', onclick: submit }, '변환 시작');

  function add(fs) {
    files = files.concat(fs.filter((f) => f.size > 0));
    renderFiles();
  }
  function renderFiles() {
    list.replaceChildren(...files.map((f, i) => h('div', { class: 'file-row' }, icon('file', 'sm'),
      h('span', { class: 'fn' }, f.name), h('span', { style: { color: 'var(--muted)' } }, `${(f.size / 1048576).toFixed(1)}MB`),
      h('span', { class: 'st', 'data-i': i }),
      h('button', { class: 'btn ghost icon sm', onclick: () => { files.splice(i, 1); renderFiles(); } }, icon('x', 'sm')))));
    go_.disabled = !files.length;
    go_.textContent = files.length > 1 ? `${files.length}개 변환 시작` : '변환 시작';
  }
  async function submit() {
    go_.disabled = true;
    askNotificationPermission();
    const fields = { language: lang.value, num_speakers: spk.value, note_type: type.value, hint: hint.value, folder_id: folder.value };
    let last = null;
    const rows = list.querySelectorAll('.file-row');
    for (let i = 0; i < files.length; i++) {
      const slot = rows[i]?.querySelector('.st');
      const bar = h('div', { class: 'progress' }, h('div', { style: { width: '0%' } }));
      slot && slot.replaceChildren(bar);
      try {
        last = await uploadFile(files[i], fields, (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
        slot && slot.replaceChildren(h('span', { class: 'chip green' }, '완료'));
      } catch (e) {
        slot && slot.replaceChildren(h('span', { class: 'chip red' }, '실패'));
        toast(`${files[i].name}: ${e.message}`, { error: true });
      }
    }
    m.close();
    await reloadAll();
    if (files.length === 1 && last) go(`#/note/${last.id}`);
    else toast('변환을 시작했습니다. 완료되면 목록에서 확인하세요.');
  }
  const m = modal({
    title: '파일 업로드',
    body: [drop, input, list,
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', null, '언어'), lang),
        h('div', { class: 'field' }, h('label', null, '참석자 수'), spk),
        h('div', { class: 'field' }, h('label', null, '녹음 종류'), type),
        h('div', { class: 'field' }, h('label', null, '폴더'), folder)),
      h('div', { class: 'field' }, h('label', null, '키워드 등록 (선택)'), hint,
        h('span', { class: 'hint' }, '사람 이름, 전문 용어, 제품명을 적어 두면 더 정확하게 받아씁니다.'))],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '취소'), go_],
  });
  renderFiles();
  if (!files.length) setTimeout(() => input.click(), 60);
}

// ------------------------------------------------------------------ move to folder
export function moveToFolder(note, done) {
  const folders = S.state.folders;
  const m = modal({
    title: '폴더로 이동',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      h('button', { class: `nav-item${!note.folder_id ? ' active' : ''}`, onclick: () => pick(null) }, icon('notes'), '폴더 없음'),
      folders.map((f) => h('button', { class: `nav-item${note.folder_id === f.id ? ' active' : ''}`, onclick: () => pick(f.id) }, icon('folder'), f.name)),
      h('button', { class: 'nav-item', onclick: async () => {
        const name = await promptDialog('새 폴더', '', { placeholder: '폴더 이름', ok: '만들기' });
        if (!name) return;
        const f = await api('/api/folders', { method: 'POST', body: { name } });
        pick(f.id);
      } }, icon('plus'), '새 폴더 만들기')),
  });
  async function pick(fid) {
    await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { folder_id: fid } });
    m.close();
    toast('이동했습니다');
    await refreshState();
    done && done(fid);
  }
}

// ------------------------------------------------------------------ export
export function openExport(note) {
  const opt = (fmt, title, desc, ic) => h('button', { class: 'opt', style: { width: '100%', textAlign: 'left', background: 'none' }, onclick: () => { download(`/api/notes/${note.id}/export?fmt=${fmt}`); toast('내려받는 중…'); } },
    icon(ic), h('div', null, h('div', { class: 'ot' }, title), h('div', { class: 'od' }, desc)));
  const m = modal({
    title: '내보내기',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      opt('docx', '회의록 · Word (.docx)', '회의 정보, 요약, 결정 사항, 할 일 표, 전체 대화가 담긴 문서', 'doc'),
      opt('md', 'Markdown (.md)', 'Notion · Obsidian 등에 붙여넣기 좋은 형식', 'notes'),
      opt('txt', '텍스트 (.txt)', '요약 + 화자·시간이 표시된 전체 대화', 'file'),
      opt('srt', '자막 (.srt)', '영상 편집 프로그램용 자막 (화자 포함)', 'list'),
      opt('vtt', '웹 자막 (.vtt)', '웹 동영상 플레이어용 자막', 'list'),
      opt('audio', '녹음 파일', '원본 음성 파일', 'wave'),
      opt('json', '데이터 (.json)', '단어별 시간 정보를 포함한 전체 데이터', 'cpu')),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '닫기')],
  });
}

// ------------------------------------------------------------------ settings
export async function openSettings(tab = 'asr') {
  let st = await api('/api/state');
  let ms = await api('/api/models');
  let s = st.settings;
  const nav = h('nav');
  const pane = h('div', { class: 'pane' });
  let timer = null;
  const tabs = [['asr', '음성 인식', 'mic'], ['ai', 'AI 요약', 'sparkle'], ['rec', '녹음', 'wave'], ['models', '모델 관리', 'cpu'], ['general', '일반', 'settings']];

  async function save(patch, quiet) {
    s = await api('/api/settings', { method: 'PATCH', body: patch });
    if (!quiet) toast('저장했습니다');
    if ('theme' in patch) applyTheme(s.theme);
    st = await api('/api/state');
    S.state = st;
    refreshState();
  }
  const sw = (checked, onchange) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span'));
  const row = (title, desc, control) => h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('b', null, title), desc ? h('span', null, desc) : null), control);

  function modelRow(m) {
    const right = m.installed ? h('span', { class: 'chip green' }, icon('check', 'sm'), '설치됨')
      : m.downloading ? h('div', { class: 'progress' }, h('div', { style: { width: `${Math.round(m.progress * 100)}%` } }))
        : h('button', { class: 'btn sm', onclick: async () => { await api(`/api/models/${m.key}/download`, { method: 'POST' }); poll(); } }, icon('download', 'sm'), '받기');
    return h('div', { class: 'model-row' }, h('div', { class: 'mn' }, h('b', null, m.name),
      h('span', null, `${(m.size / 1e6).toFixed(0)}MB${m.required ? ' · 필수' : ''}${m.error ? ` · 오류: ${m.error}` : ''}`)), right);
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!document.body.contains(pane)) return;
      ms = await api('/api/models');
      st = await api('/api/state');
      render();
      const busy = ms.models.some((x) => x.downloading) || ms.mlx.downloading;
      if (busy) poll();
    }, 1000);
  }

  function render() {
    nav.replaceChildren(...tabs.map(([k, l, ic]) => h('button', { class: `nav-item${tab === k ? ' active' : ''}`, onclick: () => { tab = k; render(); } }, icon(ic), l)));
    const p = [];
    if (tab === 'asr') {
      p.push(h('div', { class: 'field' }, h('label', null, '인식 엔진'),
        h('label', { class: `opt${s.asr_engine === 'auto' ? ' on' : ''}` }, h('input', { type: 'radio', name: 'eng', checked: s.asr_engine === 'auto', onchange: () => save({ asr_engine: 'auto' }).then(render) }),
          h('div', null, h('div', { class: 'ot' }, '자동 (권장)'), h('div', { class: 'od' }, `지금 사용: ${st.engines.find((e) => e.key === st.engine)?.label || st.engine}`))),
        st.engines.map((e) => h('label', { class: `opt${s.asr_engine === e.key ? ' on' : ''}${e.ok ? '' : ' disabled'}` },
          h('input', { type: 'radio', name: 'eng', disabled: !e.ok, checked: s.asr_engine === e.key, onchange: () => save({ asr_engine: e.key }).then(render) }),
          h('div', { style: { flex: 1 } }, h('div', { class: 'ot' }, e.label), h('div', { class: 'od' }, e.desc + (e.ok ? '' : ' — 사용할 수 없음 (모델 관리에서 설치)')))))));
      if (ms.mlx.supported) {
        p.push(row('Whisper 모델 크기', 'Apple GPU 엔진에서 사용할 모델', h('select', { class: 'sel', onchange: (e) => save({ whisper_model: e.target.value }) },
          [['large-v3-turbo', 'large-v3-turbo (권장)'], ['large-v3', 'large-v3 (최고 정확도, 느림)'], ['medium', 'medium'], ['small', 'small (빠름)']]
            .map(([v, l]) => h('option', { value: v, selected: s.whisper_model === v ? '' : null }, l)))));
      }
      p.push(row('기본 언어', '녹음과 업로드의 기본값', h('select', { class: 'sel', onchange: (e) => save({ language: e.target.value }) },
        LANGS.map(([v, l]) => h('option', { value: v, selected: s.language === v ? '' : null }, l)))));
      p.push(row('화자 구분', '누가 말했는지 참석자별로 나눕니다', sw(s.diarization, (v) => save({ diarization: v }))));
      p.push(row('화자 구분 민감도', `낮을수록 참석자를 더 잘게 나눕니다 (현재 ${Number(s.diarization_threshold).toFixed(2)})`,
        h('input', { type: 'range', min: 0.4, max: 0.9, step: 0.05, value: s.diarization_threshold, onchange: (e) => save({ diarization_threshold: Number(e.target.value) }) })));
    } else if (tab === 'ai') {
      const prov = (k, t, d) => h('label', { class: `opt${s.llm_provider === k ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'prov', checked: s.llm_provider === k, onchange: () => save({ llm_provider: k }).then(render) }),
        h('div', null, h('div', { class: 'ot' }, t), h('div', { class: 'od' }, d)));
      const key = h('input', { class: 'inp', type: 'password', placeholder: s.anthropic_api_key_set ? `등록됨 ${s.anthropic_api_key_hint || ''} (바꾸려면 새 키 입력)` : 'sk-ant-…', style: { flex: 1 } });
      p.push(h('div', { class: 'field' }, h('label', null, 'AI 요약 방식'),
        prov('auto', '자동 (권장)', `지금 사용: ${{ claude: 'Claude', ollama: 'Ollama', local: '내장 요약' }[st.summary_provider]} — Claude 키가 있으면 Claude, 없으면 Ollama, 둘 다 없으면 내장 요약`),
        prov('claude', 'Claude (최고 품질)', '회의록·결정 사항·할 일을 사람처럼 정리합니다. 녹취록 텍스트만 전송되며 음성은 전송되지 않습니다.'),
        prov('ollama', 'Ollama (완전 로컬 LLM)', '인터넷 없이 Mac에서 직접 요약. 한국어는 exaone3.5 · qwen2.5 모델 권장'),
        prov('local', '내장 요약 (오프라인)', '추가 설치 없이 핵심 문장·키워드·할 일을 추출합니다')));
      p.push(h('div', { class: 'field' }, h('label', null, 'Claude API 키'),
        h('div', { class: 'row' }, key, h('button', { class: 'btn', onclick: async () => { if (!key.value.trim()) return; await save({ anthropic_api_key: key.value.trim() }); key.value = ''; render(); } }, '저장'),
          s.anthropic_api_key_set ? h('button', { class: 'btn danger', onclick: async () => { await save({ clear_api_key: true }); render(); } }, '삭제') : null),
        h('span', { class: 'hint' }, 'console.anthropic.com에서 발급. 키는 이 Mac에만 저장됩니다.')));
      p.push(row('Claude 모델', null, h('select', { class: 'sel', onchange: (e) => save({ claude_model: e.target.value }) },
        [['claude-opus-5', 'Claude Opus 5 (권장)'], ['claude-sonnet-5', 'Claude Sonnet 5 (빠름·저렴)'], ['claude-haiku-4-5', 'Claude Haiku 4.5 (가장 저렴)']]
          .map(([v, l]) => h('option', { value: v, selected: s.claude_model === v ? '' : null }, l)))));
      const olUrl = h('input', { class: 'inp', value: s.ollama_url, onchange: (e) => save({ ollama_url: e.target.value }) });
      const olModel = h('input', { class: 'inp', value: s.ollama_model, list: 'ollama-models', onchange: (e) => save({ ollama_model: e.target.value }) });
      const dl = h('datalist', { id: 'ollama-models' });
      api('/api/ollama/models').then((r) => { dl.replaceChildren(...r.models.map((x) => h('option', { value: x }))); olStatus.textContent = r.ok ? `연결됨 · 모델 ${r.models.length}개` : '연결 안 됨 (Ollama 앱을 실행하세요)'; });
      const olStatus = h('span', { class: 'hint' }, '확인 중…');
      p.push(h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Ollama 주소'), olUrl, olStatus),
        h('div', { class: 'field' }, h('label', null, 'Ollama 모델'), olModel, dl, h('span', { class: 'hint' }, '예: exaone3.5:7.8b, qwen2.5:14b'))));
      const useEl = h('span', null, '불러오는 중…');
      api('/api/usage').then((u) => {
        const f = (x) => `${x.n}회 · 입력 ${x.inp.toLocaleString()} / 출력 ${x.out.toLocaleString()} 토큰 · 약 $${x.cost.toFixed(2)}`;
        useEl.textContent = `이번 달 ${f(u.month)} (누적 $${u.all.cost.toFixed(2)})`;
      });
      p.push(row('Claude 사용량', null, h('div', { style: { fontSize: '12.5px', color: 'var(--text-2)', textAlign: 'right' } }, useEl)));
      p.push(row('변환 후 자동 요약', '받아쓰기가 끝나면 바로 AI 요약을 만듭니다', sw(s.auto_summary, (v) => save({ auto_summary: v }))));
    } else if (tab === 'rec') {
      const micSel = h('select', { class: 'sel', onchange: (e) => { localStorage.setItem('mn.mic', e.target.value); toast('다음 녹음부터 적용됩니다'); } }, h('option', { value: '' }, '시스템 기본 마이크'));
      navigator.mediaDevices?.enumerateDevices?.().then((ds) => {
        const cur = localStorage.getItem('mn.mic') || '';
        ds.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default').forEach((d, i) => micSel.append(h('option', { value: d.deviceId, selected: d.deviceId === cur ? '' : null }, d.label || `마이크 ${i + 1}`)));
      });
      const ls = (k, def) => (localStorage.getItem(k) ?? def) === '1';
      p.push(row('마이크', '녹음에 사용할 입력 장치', micSel));
      p.push(row('실시간 자막', '녹음하는 동안 말한 내용을 바로 보여줍니다 (SenseVoice)', sw(s.live_transcription, (v) => save({ live_transcription: v }))));
      p.push(row('잡음 억제', '끄는 것을 권장 — 화상통화용 처리라 받아쓰기 정확도를 떨어뜨릴 수 있습니다', sw(ls('mn.ns', '0'), (v) => localStorage.setItem('mn.ns', v ? '1' : '0'))));
      p.push(row('자동 음량 조절', '마이크에서 멀리 앉은 사람이 많을 때만 켜세요', sw(ls('mn.agc', '0'), (v) => localStorage.setItem('mn.agc', v ? '1' : '0'))));
      p.push(row('에코 제거', '스피커로 화상회의를 들으며 녹음할 때 켜세요', sw(ls('mn.ec', '0'), (v) => localStorage.setItem('mn.ec', v ? '1' : '0'))));
    } else if (tab === 'models') {
      p.push(h('div', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12.5px' } }, `모든 모델은 이 Mac에서만 실행됩니다. 저장 위치: ${ms.dir}`));
      p.push(...ms.models.map(modelRow));
      if (ms.mlx.supported) {
        p.push(h('div', { class: 'model-row' }, h('div', { class: 'mn' }, h('b', null, `Whisper (MLX) · ${ms.mlx.repo.split('/')[1]}`),
          h('span', null, ms.mlx.available ? 'Apple GPU 가속 · Hugging Face에서 내려받음' : 'mlx-whisper 패키지가 설치되지 않았습니다 (install.sh 다시 실행)')),
        ms.mlx.installed ? h('span', { class: 'chip green' }, icon('check', 'sm'), '설치됨')
          : ms.mlx.downloading ? h('div', { class: 'progress' }, h('div', { style: { width: `${Math.round(ms.mlx.progress * 100)}%` } }))
            : h('button', { class: 'btn sm', disabled: !ms.mlx.available, onclick: async () => { await api('/api/models/whisper-mlx/download', { method: 'POST' }); poll(); } }, icon('download', 'sm'), '받기')));
      }
    } else {
      p.push(row('화면 테마', null, h('div', { class: 'seg-ctl' }, [['system', '시스템'], ['light', '라이트'], ['dark', '다크']].map(([v, l]) =>
        h('button', { class: s.theme === v ? 'on' : '', onclick: () => save({ theme: v }, true).then(render) }, l)))));
      p.push(row('건너뛰기 간격', '재생 중 ← → 키로 이동하는 시간', h('div', { class: 'seg-ctl' }, [3, 5, 10, 15].map((v) =>
        h('button', { class: Number(s.skip_seconds) === v ? 'on' : '', onclick: () => save({ skip_seconds: v }, true).then(render) }, `${v}초`)))));
      p.push(row('데이터 폴더', st.data_dir, h('button', { class: 'btn', onclick: () => api('/api/app/reveal', { method: 'POST' }) }, 'Finder에서 열기')));
      p.push(row('브라우저에서 열기', '창 대신 기본 브라우저로 엽니다', h('button', { class: 'btn', onclick: () => api('/api/app/open-browser', { method: 'POST' }) }, '열기')));
      p.push(row('단축키', null, h('div', { style: { fontSize: '12.5px', color: 'var(--text-2)', textAlign: 'right', lineHeight: 1.9 } },
        'Space 재생/정지 · ←/→ 이동 · ⌘F 대화 검색', h('br'), '⌘K 노트 검색 · ⌘U 업로드 · ⇧⌘R 녹음 · ⌘, 설정')));
      p.push(row(`회의노트 ${st.version}`, '모든 녹음과 회의록은 이 Mac에 저장됩니다', h('button', { class: 'btn danger', onclick: async () => {
        if (window.__meetnoteNative) { window.webkit.messageHandlers.meetnote.postMessage({ type: 'quit' }); return; }
        await api('/api/app/quit', { method: 'POST' }); document.body.innerHTML = '<div class="empty"><h3>회의노트를 종료했습니다</h3>이 창을 닫아도 됩니다.</div>';
      } }, icon('logout', 'sm'), '앱 종료')));
    }
    pane.replaceChildren(...p);
  }
  render();
  if (ms.models.some((x) => x.downloading) || ms.mlx.downloading) poll();
  modal({ title: '설정', wide: true, body: h('div', { class: 'settings' }, nav, pane), onClose: () => clearTimeout(timer) });
}

export { fmtDur };
