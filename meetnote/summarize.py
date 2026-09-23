"""AI meeting summary: Claude, a local Ollama model, or the built-in offline summarizer.

All providers produce the same JSON document (see SCHEMA), which the UI renders
as the "AI 요약" tab and the formal minutes (회의록), and the exporters turn
into Word/Markdown.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
from collections import Counter, defaultdict

import httpx

from . import config, korean

log = logging.getLogger("meetnote.summarize")

NOTE_TYPES = {
    "meeting": "회의",
    "interview": "인터뷰",
    "lecture": "강의",
    "call": "통화",
    "memo": "개인 메모",
}

_STR = {"type": "string"}
_STRS = {"type": "array", "items": _STR}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


SCHEMA = _obj({
    "title": _STR,
    "one_line": _STR,
    "overview": _STR,
    "key_points": _STRS,
    "topics": {"type": "array", "items": _obj({"title": _STR, "time": _STR, "points": _STRS})},
    "decisions": _STRS,
    "action_items": {"type": "array", "items": _obj({"task": _STR, "owner": _STR, "due": _STR, "time": _STR})},
    "open_issues": _STRS,
    "keywords": _STRS,
    "participants": {"type": "array", "items": _obj({"name": _STR, "summary": _STR})},
})


def fmt_time(t: float) -> str:
    t = int(max(0, t))
    h, m, s = t // 3600, (t % 3600) // 60, t % 60
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse_time(s: str) -> float | None:
    if not s:
        return None
    m = re.findall(r"\d+", s)
    if not m:
        return None
    parts = [int(x) for x in m[-3:]]
    t = 0
    for p in parts:
        t = t * 60 + p
    return float(t)


def transcript_text(segments: list[dict], speakers: dict[int, str]) -> str:
    return "\n".join(
        f"[{fmt_time(s['start'])}] {speakers.get(s['speaker'], '참석자')}: {s['text']}" for s in segments
    )


def _instructions(note: dict, speakers: dict[int, str]) -> str:
    kind = NOTE_TYPES.get(note.get("note_type") or "meeting", "회의")
    lang = note.get("language") or "ko"
    out_lang = "영어" if lang == "en" else "일본어" if lang == "ja" else "한국어"
    names = ", ".join(speakers.values()) or "참석자 1"
    focus = {
        "회의": "결정 사항과 할 일(담당자·기한)을 빠짐없이 찾아내세요.",
        "인터뷰": "질문과 답변의 핵심, 인터뷰이의 주요 견해와 인용할 만한 발언을 정리하세요.",
        "강의": "핵심 개념, 정의, 예시, 시험/과제에 관련된 언급을 정리하세요. 결정 사항이 없으면 빈 배열로 두세요.",
        "통화": "요청 사항, 합의 내용, 후속 조치를 정리하세요.",
        "개인 메모": "아이디어와 해야 할 일을 정리하세요.",
    }[kind]
    return f"""당신은 전문 회의록 작성자입니다. 아래는 음성 인식으로 받아쓴 {kind} 녹취록입니다.
각 줄은 [시각] 화자: 발언 형식입니다. 화자: {names}.
음성 인식 오류(비슷한 발음의 잘못된 단어)가 있을 수 있으니 문맥으로 바로잡아 이해하세요.

작성 규칙:
- 모든 내용은 {out_lang}로, 간결한 개조식 문장(~함, ~예정, ~하기로 함)으로 작성합니다.
- title: 내용을 대표하는 20자 내외의 제목 (날짜나 '회의록' 같은 말은 넣지 않음).
- one_line: 전체를 한 문장으로 요약.
- overview: 3~5문장 요약 문단.
- key_points: 가장 중요한 핵심 내용 3~7개.
- topics: 대화 흐름에 따른 주제별 요약 (시간 순). time은 그 주제가 시작된 녹취록의 시각(예: "03:15"). points는 주제별 2~5개.
- decisions: 확정/합의/결정된 사항. 없으면 빈 배열.
- action_items: 해야 할 일. owner는 화자 이름(모르면 ""), due는 언급된 기한(없으면 ""), time은 언급 시각.
- open_issues: 결론이 나지 않았거나 추가 확인이 필요한 사항.
- keywords: 핵심 키워드 5~10개 (명사 위주).
- participants: 화자별로 주요 발언/입장을 한 문장으로.
- 녹취록에 없는 내용을 지어내지 마세요.
{focus}"""


# ------------------------------------------------------------------ providers

def resolve_provider(settings: dict | None = None) -> str:
    s = settings or config.load_settings()
    p = s.get("llm_provider", "auto")
    if p in ("claude", "ollama", "local"):
        return p
    if s.get("anthropic_api_key") or os.environ.get("ANTHROPIC_API_KEY"):
        return "claude"
    if ollama_ok(s):
        return "ollama"
    return "local"


def ollama_ok(s: dict) -> bool:
    try:
        r = httpx.get(s["ollama_url"].rstrip("/") + "/api/tags", timeout=1.5)
        return r.status_code == 200
    except Exception:
        return False


def ollama_models(s: dict) -> list[str]:
    try:
        r = httpx.get(s["ollama_url"].rstrip("/") + "/api/tags", timeout=2)
        return [m["name"] for m in r.json().get("models", [])]
    except Exception:
        return []


def summarize(note: dict, segments: list[dict], speakers: dict[int, str]) -> tuple[dict, str]:
    """Return (summary, provider_label)."""
    s = config.load_settings()
    provider = resolve_provider(s)
    if not segments:
        return _empty(), "local"
    if provider == "claude":
        data = _claude(note, segments, speakers, s)
        label = f"Claude ({s['claude_model']})"
    elif provider == "ollama":
        data = _ollama(note, segments, speakers, s)
        label = f"Ollama ({s['ollama_model']})"
    else:
        data = local_summary(note, segments, speakers)
        label = "내장 요약 (오프라인)"
    return normalize(data, segments), label


def _empty() -> dict:
    return {k: ([] if v.get("type") == "array" else "") for k, v in SCHEMA["properties"].items()}


def normalize(data: dict, segments: list[dict]) -> dict:
    out = _empty()
    for k in out:
        if k in data and data[k] is not None:
            out[k] = data[k]
    for t in out["topics"]:
        t["start"] = parse_time(t.get("time", ""))
    for a in out["action_items"]:
        a["start"] = parse_time(a.get("time", ""))
        a.setdefault("done", False)
    return out


def _claude_client(s: dict):
    import anthropic

    key = s.get("anthropic_api_key") or None
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()


def _claude_call(s: dict, system: str, messages: list[dict], schema: dict | None, max_tokens: int = 32000) -> str:
    import anthropic

    client = _claude_client(s)
    output_config: dict = {"effort": "medium"}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs = dict(model=s["claude_model"], max_tokens=max_tokens, system=system, messages=messages,
                  thinking={"type": "adaptive"}, output_config=output_config)
    try:
        # Server-side fallback reroutes a safety-classifier refusal to another model.
        with client.beta.messages.stream(**kwargs, betas=["server-side-fallback-2026-07-01"],
                                         fallbacks="default") as stream:
            msg = stream.get_final_message()
    except anthropic.BadRequestError:
        with client.messages.stream(**kwargs) as stream:
            msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise RuntimeError("Claude가 이 요청의 처리를 거절했습니다.")
    text = "".join(b.text for b in msg.content if b.type == "text")
    if msg.stop_reason == "max_tokens" and schema:
        raise RuntimeError("요약이 너무 길어 중간에 잘렸습니다.")
    return text


def _claude(note, segments, speakers, s) -> dict:
    system = _instructions(note, speakers)
    body = transcript_text(segments, speakers)
    extra = f"\n\n참고 메모:\n{note['memo']}" if note.get("memo") else ""
    text = _claude_call(s, system, [{"role": "user", "content": f"<transcript>\n{body}\n</transcript>{extra}"}], SCHEMA)
    return json.loads(text)


def _ollama_chat(s: dict, system: str, user: str, schema: dict | None, num_ctx: int = 16384) -> str:
    payload = {
        "model": s["ollama_model"], "stream": False,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "options": {"temperature": 0.2, "num_ctx": num_ctx},
    }
    if schema:
        payload["format"] = schema
    r = httpx.post(s["ollama_url"].rstrip("/") + "/api/chat", json=payload, timeout=900)
    r.raise_for_status()
    return r.json()["message"]["content"]


def _ollama(note, segments, speakers, s) -> dict:
    system = _instructions(note, speakers)
    body = transcript_text(segments, speakers)
    limit = 9000  # characters per request keeps small local models accurate
    if len(body) <= limit:
        return json.loads(_ollama_chat(s, system, body, SCHEMA))
    # Map-reduce: summarise chunks, then merge the partial summaries.
    lines, chunks, cur = body.split("\n"), [], ""
    for ln in lines:
        if len(cur) + len(ln) > limit and cur:
            chunks.append(cur)
            cur = ""
        cur += ln + "\n"
    if cur:
        chunks.append(cur)
    parts = [json.loads(_ollama_chat(s, system, c, SCHEMA)) for c in chunks]
    merge_prompt = (system + "\n\n아래는 녹취록을 여러 부분으로 나누어 만든 부분 요약들입니다. "
                    "이를 하나의 완전한 요약으로 통합하세요. 중복은 합치고 시간 순서를 유지하세요.")
    return json.loads(_ollama_chat(s, merge_prompt, json.dumps(parts, ensure_ascii=False), SCHEMA))


# ------------------------------------------------------------------ Q&A

def answer(note: dict, segments: list[dict], speakers: dict[int, str], history: list[dict], question: str) -> str:
    s = config.load_settings()
    provider = resolve_provider(s)
    body = transcript_text(segments, speakers)
    system = ("당신은 회의 내용을 잘 아는 비서입니다. 아래 녹취록만 근거로 질문에 답하세요. "
              "근거가 되는 발언의 시각을 [mm:ss] 형태로 함께 적고, 녹취록에 없는 내용은 모른다고 답하세요. "
              "답은 간결한 한국어로 작성하세요.\n\n<transcript>\n" + body + "\n</transcript>")
    if provider == "claude":
        msgs = [{"role": h["role"], "content": h["content"]} for h in history[-10:]]
        msgs.append({"role": "user", "content": question})
        return _claude_call(s, system, msgs, None, max_tokens=8000).strip()
    if provider == "ollama":
        convo = "\n".join(f"{'Q' if h['role'] == 'user' else 'A'}: {h['content']}" for h in history[-6:])
        return _ollama_chat(s, system, (convo + "\nQ: " + question).strip(), None).strip()
    return local_answer(segments, speakers, question)


def local_answer(segments, speakers, question: str) -> str:
    q = set(_terms(question))
    if not q:
        return "질문에서 찾을 단어가 없습니다. 조금 더 구체적으로 물어봐 주세요."
    scored = []
    for s in segments:
        terms = set(_terms(s["text"]))
        hit = len(q & terms) + sum(0.5 for t in q if any(t in x or x in t for x in terms if len(x) > 1))
        if hit:
            scored.append((hit, s))
    if not scored:
        return ("관련 발언을 찾지 못했습니다. (오프라인 모드에서는 키워드 검색으로 답합니다. "
                "설정에서 Claude API 키를 등록하면 자연어로 답변합니다.)")
    scored.sort(key=lambda x: -x[0])
    top = sorted((s for _, s in scored[:4]), key=lambda s: s["start"])
    lines = [f"- [{fmt_time(s['start'])}] {speakers.get(s['speaker'], '참석자')}: {s['text']}" for s in top]
    return "녹취록에서 관련된 발언을 찾았습니다:\n" + "\n".join(lines)


# ------------------------------------------------------------------ offline summarizer

JOSA = sorted("""은 는 이 가 을 를 에 에서 에게 께서 께 한테 으로 로 와 과 도 의 만 까지 부터 보다 처럼 이나 나 이랑 랑
으로는 로는 에는 에서는 에도 이라고 라고 이라는 라는 이며 이고 이죠 이에요 예요 입니다 이다 적인 적으로 들 들이 들은 들을 들의""".split(),
              key=len, reverse=True)
STOP = set("""그리고 그런데 그래서 그러면 그럼 그러니까 근데 하지만 그러나 또는 또 및 네 예 아 음 어 에 이제 좀 그냥 진짜 정말 너무 아주
매우 많이 조금 약간 이렇게 저렇게 그렇게 어떻게 왜 뭐 무엇 무슨 어떤 이런 저런 그런 이것 그것 저것 이거 그거 저거 여기 거기 저기 지금 오늘
내일 어제 우리 저희 제가 저는 저도 나는 내가 너 당신 것 수 등 때 중 더 안 못 잘 다 모두 모든 각 한 두 세 하나 번 분 거 게 건 걸 데 쪽
합니다 했습니다 하겠습니다 있습니다 없습니다 됩니다 됐습니다 같습니다 겁니다 거예요 거죠 하는 하고 해서 했고 하면 하지 해요 했어요 할 한 된 될
되는 되고 있는 있고 있어 없는 없고 같은 같아요 같고 위해 대해 대한 통해 관련 경우 정도 부분 생각 말씀 이야기 얘기 확인 감사합니다 안녕하세요
네네 예예 그죠 맞아요 맞습니다 알겠습니다 좋습니다 좋아요 좋겠습니다 그러면요 일단 먼저 다음 이번 지난 계속 바로 다시 혹시 사실 일단은""".split())
VERB_END = re.compile(r"(습니다|니다|어요|아요|해요|세요|죠|네요|군요|는데|지만|으면|면서|하고|하는|하게|해서|했고|했던|하던|하면|겠|던|었|았|였|"
                      r"려고|려면|도록|ㄹ게|을게|을까|ㄹ까|까요|나요|잖아|라서|니까|어서|아서|고요|는지|을지|ㄴ지)$")
DECISION = re.compile(r"(확정|결정|하기로|기로 했|합의|승인|결론|(으로|로) 정(했|하겠|합시다)|채택|최종적으로|으로 가겠|로 가겠|진행하기로)")
NOT_ACTION = re.compile(r"(논의하겠|말씀 ?드리겠|시작하겠|마치겠|여기까지|설명드리겠|소개하겠|발표하겠|이야기하겠|얘기하겠|감사|수고)")
ACTION = re.compile(r"(하겠습니다|드리겠습니다|할게요|해 ?드릴게요|해 ?주세요|해 ?주시|부탁|까지 .*(작성|공유|전달|보고|제출|정리|준비|검토)(하겠|할게|해 ?주|드리)|"
                    r"(작성|공유|전달|보고|제출|정리|준비|검토|조율|확인|연락)(해야|하겠|할게|해서|하기로))")
DUE = re.compile(r"((다음|이번|다다음)\s?주\s?[월화수목금토일]요일|(다음|이번)\s?주(까지|중|말)?|내일|모레|오늘\s?중|이번\s?달\s?(말|중)?|"
                 r"다음\s?달\s?(초|중순|말)?|월말|주말|연말|\d{1,2}\s?월\s?\d{1,2}\s?일|\d{1,2}\s?일(까지)?|[월화수목금토일]요일(까지)?)")
QUESTION = re.compile(r"(\?|까요|나요|는지|을지|인지|검토가 필요|확인이 필요|논의가 필요|미정|추후|다시 논의|고민)")
FILLER = re.compile(r"^(네|예|아|음|어|그|저|자|뭐|이제|그러면|그럼|그래서|근데|그런데|그리고)[,.\s]+")


def _terms(text: str) -> list[str]:
    if korean.kiwi() is not None:
        return [w for w in korean.nouns(text) if w not in STOP]
    out = []
    for tok in re.findall(r"[가-힣]+|[A-Za-z][A-Za-z0-9+#.-]*|\d+[가-힣%]*", text):
        if re.match(r"[A-Za-z]", tok):
            if len(tok) > 1 and tok.lower() not in {"ok", "the", "and", "to", "of", "a", "is"}:
                out.append(tok)
            continue
        if re.match(r"\d", tok):
            continue
        w = tok
        for j in JOSA:
            if len(w) > len(j) + 1 and w.endswith(j):
                w = w[: -len(j)]
                break
        if len(w) < 2 or w in STOP or tok in STOP or VERB_END.search(tok) and w == tok:
            continue
        if VERB_END.search(w) or re.search(r"(이고|하고|하며|하여|해서|이며)$", w):
            continue
        if len(w) > 2 and w.endswith("하"):
            w = w[:-1]
        out.append(w)
    return out


def _sentences(segments: list[dict], speakers: dict[int, str]) -> list[dict]:
    sents = []
    for s in segments:
        parts = korean.split_sentences(s["text"])
        words = s.get("words") or []
        n = len(parts)
        for i, p in enumerate(parts):
            p = p.strip()
            if len(p) < 4:
                continue
            # Approximate the sentence start inside the segment.
            t = s["start"] + (s["end"] - s["start"]) * i / max(1, n)
            if words:
                idx = int(len(words) * i / max(1, n))
                t = words[min(idx, len(words) - 1)]["s"]
            sents.append({"text": p, "t": t, "speaker": s["speaker"],
                          "who": speakers.get(s["speaker"], f"참석자 {s['speaker'] + 1}"), "terms": _terms(p)})
    return sents


def _keywords(sents: list[dict], k: int = 10) -> list[tuple[str, float]]:
    tf: Counter = Counter()
    df: Counter = Counter()
    for s in sents:
        tf.update(s["terms"])
        df.update(set(s["terms"]))
    # Adjacent term pairs that recur ("마케팅 예산", "베타 테스트") read better than single words.
    pairs: Counter = Counter()
    for s in sents:
        for a, b in zip(s["terms"], s["terms"][1:]):
            if a != b:
                pairs[f"{a} {b}"] += 1
    n = max(1, len(sents))
    scores: dict[str, float] = {}
    for w, c in tf.items():
        spread = df[w] / n
        scores[w] = c * (1.0 + 0.3 * len(w) / 3) * (1.0 if spread < 0.5 else 0.6)
    for p, c in pairs.items():
        if c >= 2:
            a, b = p.split(" ")
            scores[p] = c * 2.2
            for x in (a, b):
                scores[x] = scores.get(x, 0) * 0.7
    ranked = sorted(scores.items(), key=lambda x: -x[1])
    out, seen = [], set()
    for w, sc in ranked:
        if any(w in o or o in w for o in seen):
            continue
        seen.add(w)
        out.append((w, sc))
        if len(out) >= k:
            break
    return out


def _clean(text: str) -> str:
    t = FILLER.sub("", text.strip())
    t = FILLER.sub("", t)
    return t[:1].upper() + t[1:] if t else t


def _score(sent: dict, kw: dict[str, float]) -> float:
    if not sent["terms"]:
        return 0.0
    sc = sum(kw.get(t, 0) for t in sent["terms"])
    for p in kw:
        if " " in p and p in sent["text"]:
            sc += kw[p]
    return sc / math.sqrt(len(sent["terms"]) + 2)


def _segment_topics(sents: list[dict], k: int) -> list[list[dict]]:
    if k <= 1 or len(sents) < 6:
        return [sents]
    w = 3
    gaps = []
    for i in range(w, len(sents) - w + 1):
        a = Counter(t for s in sents[i - w:i] for t in s["terms"])
        b = Counter(t for s in sents[i:i + w] for t in s["terms"])
        dot = sum(a[x] * b[x] for x in a)
        na = math.sqrt(sum(v * v for v in a.values())) or 1
        nb = math.sqrt(sum(v * v for v in b.values())) or 1
        gaps.append((dot / (na * nb), i))
    cuts = []
    for sim, i in sorted(gaps):
        if all(abs(i - c) >= 3 for c in cuts):
            cuts.append(i)
        if len(cuts) >= k - 1:
            break
    cuts = sorted(cuts)
    out, prev = [], 0
    for c in cuts + [len(sents)]:
        if sents[prev:c]:
            out.append(sents[prev:c])
        prev = c
    return out


def local_summary(note: dict, segments: list[dict], speakers: dict[int, str]) -> dict:
    sents = _sentences(segments, speakers)
    if not sents:
        return _empty()
    kw_list = _keywords(sents, 12)
    kw = dict(kw_list)
    duration = max(s["end"] for s in segments)
    ranked = sorted(sents, key=lambda s: -_score(s, kw))

    k = max(1, min(8, round(duration / 150)))
    topics = []
    for block in _segment_topics(sents, k):
        bkw = _keywords(block, 3)
        title = " · ".join(w for w, _ in bkw[:2]) or _clean(block[0]["text"])[:20]
        best = sorted(block, key=lambda s: -_score(s, kw))[:3]
        best = sorted(best, key=lambda s: s["t"])
        topics.append({"title": title, "time": fmt_time(block[0]["t"]),
                       "points": [_clean(s["text"]) for s in best]})

    decisions = []
    for s in sents:
        if DECISION.search(s["text"]) and not s["text"].endswith("?"):
            decisions.append(_clean(s["text"]))
    actions = []
    for s in sents:
        if NOT_ACTION.search(s["text"]) or s["text"].endswith("?"):
            continue
        if ACTION.search(s["text"]) and not DECISION.search(s["text"]) \
                or re.search(r"(제가|저희가|제 쪽에서).*(하겠|드리겠|할게)", s["text"]):
            due = DUE.search(s["text"])
            owner = s["who"] if re.search(r"(제가|저는|저희가|제 쪽|저희 팀)", s["text"]) else ""
            if not owner:
                for name in speakers.values():
                    if name and name in s["text"]:
                        owner = name
            actions.append({"task": _clean(s["text"]), "owner": owner,
                            "due": due.group(0) if due else "", "time": fmt_time(s["t"])})
    issues = [_clean(s["text"]) for s in sents if QUESTION.search(s["text"])
              and s["text"] not in {a["task"] for a in actions} and _score(s, kw) > 0][:5]

    statements = [s for s in ranked if not s["text"].endswith("?")] or ranked
    top = sorted(statements[:4], key=lambda s: s["t"])
    overview = " ".join(_clean(s["text"]) for s in top)
    words = [w for w, _ in kw_list]
    topics_txt = ", ".join(words[:3])
    one_line = f"{topics_txt}에 대해 논의했습니다." if words else _clean(statements[0]["text"])
    if decisions:
        one_line += f" 결정 사항 {len(_dedupe(decisions))}건"
    if actions:
        one_line += ("," if decisions else "") + f" 할 일 {len(actions)}건"
    if decisions or actions:
        one_line += "을 정리했습니다."
    kind = NOTE_TYPES.get(note.get("note_type") or "meeting", "회의")
    title = " · ".join(words[:2]) + (f" {kind}" if words else kind)

    talk: dict[int, float] = defaultdict(float)
    for s in segments:
        talk[s["speaker"]] += s["end"] - s["start"]
    total_talk = sum(talk.values()) or 1.0
    participants = []
    for idx, t in sorted(talk.items(), key=lambda x: -x[1]):
        mine = [s for s in sents if s["speaker"] == idx]
        mk = [w for w, _ in _keywords(mine, 3)]
        best = max(mine, key=lambda s: _score(s, kw)) if mine else None
        desc = f"발언 비중 {round(100 * t / total_talk)}%"
        if mk:
            desc += f", 주로 {', '.join(mk)}에 대해 발언"
        if best:
            desc += f". \"{_clean(best['text'])[:60]}\""
        participants.append({"name": speakers.get(idx, f"참석자 {idx + 1}"), "summary": desc})

    return {
        "title": title[:40],
        "one_line": one_line,
        "overview": overview,
        "key_points": [_clean(s["text"]) for s in sorted(statements[:5], key=lambda s: s["t"])],
        "topics": topics,
        "decisions": _dedupe(decisions)[:8],
        "action_items": actions[:12],
        "open_issues": _dedupe(issues),
        "keywords": words[:10],
        "participants": participants,
    }


def _dedupe(items: list[str]) -> list[str]:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out
