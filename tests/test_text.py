import pytest

from meetnote import korean, summarize
from meetnote.diarize import _smooth, assign, paragraphs, renumber
from meetnote.engines.base import align_words, clean_text, is_hallucination, windows

kiwi = pytest.mark.skipif(korean.kiwi() is None, reason="kiwipiepy not installed")


@kiwi
def test_spacing_and_punctuation():
    text = korean.punctuate(korean.fix_spacing("조 금만 생각 을 하 면서 살 면 훨씬 편할 거야"))
    assert text == "조금만 생각을 하면서 살면 훨씬 편할 거야."
    out = korean.punctuate("먼저 개발 일정부터 말씀드리겠습니다 현재 베타 테스트가 진행 중입니다")
    assert out == "먼저 개발 일정부터 말씀드리겠습니다. 현재 베타 테스트가 진행 중입니다."
    assert korean.punctuate("출시는 언제로 잡으면 될까요").endswith("?")
    assert korean.fix_spacing("총 50 만 원") == "총 50만 원"


@kiwi
def test_topic_phrase_is_not_a_sentence_end():
    s = korean.punctuate("부모가 저지르는 큰 실수 중 하나는 자기 아이를 비교하는 것이다")
    assert s.count(".") == 1 and s.endswith(".")


def test_collapse_repeats_and_hallucinations():
    assert clean_text("네 네 네 네 네 네 알겠습니다") == "네 네 알겠습니다"
    assert is_hallucination("시청해 주셔서 감사합니다.")
    assert not is_hallucination("예산은 오천만 원입니다.")


def test_windows_do_not_overlap_and_skip_silence():
    wins = windows([(1.0, 2.0), (2.2, 3.0), (10.0, 12.0)], total=20.0, max_len=28, max_gap=0.5, pad=0.3)
    assert wins[0][0] == pytest.approx(0.7) and wins[0][1] < wins[1][0]
    assert len(wins) == 2  # the first two regions merge, the long silence is skipped
    solo = windows([(1.0, 2.0), (2.2, 3.0)], total=5.0, max_len=20, max_gap=0.0, pad=0.3)
    assert len(solo) == 2 and solo[0][1] <= solo[1][0]


def test_align_words_uses_token_times():
    words = align_words("그는 괜찮은 척했다.", ["그", "는", " 괜", "찮은", " 척", "했다", "."],
                        [0.0, 0.2, 0.5, 0.7, 1.2, 1.4, 1.8], offset=10.0, end=12.0)
    assert [w["w"] for w in words] == ["그는", "괜찮은", "척했다."]
    assert [w["s"] for w in words] == [10.0, 10.5, 11.2]


def _w(words):
    return [{"w": w, "s": s, "e": s + 0.4} for w, s in words]


def test_assign_splits_segment_at_speaker_change():
    seg = {"start": 0.0, "end": 4.0, "text": "a b c d e f",
           "words": _w([("a", 0), ("b", 0.5), ("c", 1.0), ("d", 2.5), ("e", 3.0), ("f", 3.5)])}
    turns = [(0.0, 2.0, 0), (2.2, 4.0, 1)]
    pieces = assign([seg], turns)
    assert [(p["speaker"], p["text"]) for p in pieces] == [(0, "a b c"), (1, "d e f")]


def test_smooth_absorbs_single_word_flips():
    assert _smooth([0, 0, 0, 1, 0, 0, 0]) == [0] * 7


def test_paragraphs_merge_same_speaker_and_renumber():
    pieces = [
        {"start": 0, "end": 2, "speaker": 3, "text": "안녕하세요.", "words": []},
        {"start": 2.5, "end": 4, "speaker": 3, "text": "시작하겠습니다.", "words": []},
        {"start": 5, "end": 7, "speaker": 1, "text": "네.", "words": []},
    ]
    paras, n = renumber(paragraphs(pieces))
    assert n == 2
    assert [(p["speaker"], p["text"]) for p in paras] == [(0, "안녕하세요. 시작하겠습니다."), (1, "네.")]


MEETING = [
    (0, 0.0, "안녕하세요. 오늘은 신제품 출시 일정과 마케팅 예산에 대해 논의하겠습니다."),
    (1, 6.0, "먼저 개발 일정부터 말씀드리겠습니다. 베타 테스트는 다음 달 15일까지 완료될 예정입니다."),
    (0, 16.0, "그럼 정식 출시는 언제로 잡으면 될까요?"),
    (1, 21.0, "베타 테스트 결과를 반영하려면 2주 정도 필요해서 다음 달 말에 출시하는 것이 좋겠습니다."),
    (0, 29.0, "출시일은 다음 달 말로 확정하겠습니다. 마케팅 예산은 어떻게 되나요?"),
    (1, 35.0, "마케팅 예산은 총 오천만 원으로 책정했고 절반은 온라인 광고에 사용할 계획입니다."),
    (0, 44.0, "온라인 광고 비중이 높네요. 오프라인 행사도 한 번 진행하면 좋겠습니다."),
    (1, 50.0, "그러면 제가 다음 주 금요일까지 오프라인 행사 기획안을 작성해서 공유드리겠습니다."),
    (0, 58.0, "감사합니다. 저는 디자인 팀과 상세 페이지 작업 일정을 조율하겠습니다. 오늘 회의는 여기까지 하겠습니다."),
]


def meeting_segments():
    return [{"speaker": s, "start": t, "end": t + 5.5, "text": x, "words": []} for s, t, x in MEETING]


def test_local_summary_finds_decisions_and_actions():
    segs = meeting_segments()
    speakers = {0: "김팀장", 1: "이대리"}
    data = summarize.normalize(summarize.local_summary({"note_type": "meeting"}, segs, speakers), segs)
    assert set(summarize.SCHEMA["properties"]) <= set(data)
    assert any("확정" in d for d in data["decisions"])
    owners = {a["owner"] for a in data["action_items"]}
    assert "이대리" in owners and "김팀장" in owners
    due = [a["due"] for a in data["action_items"] if a["owner"] == "이대리"]
    assert "다음 주 금요일" in due
    assert not any("논의하겠습니다" in a["task"] or "여기까지" in a["task"] for a in data["action_items"])
    assert "마케팅 예산" in data["keywords"][:5] or "마케팅" in data["keywords"][:5]
    assert data["one_line"] and data["title"]
    assert {p["name"] for p in data["participants"]} == {"김팀장", "이대리"}


def test_local_answer_quotes_relevant_lines():
    segs = meeting_segments()
    ans = summarize.local_answer(segs, {0: "김팀장", 1: "이대리"}, "마케팅 예산은 얼마야?")
    assert "오천만" in ans and "[00:35]" in ans


def test_time_helpers():
    assert summarize.fmt_time(3725) == "1:02:05"
    assert summarize.parse_time("03:15") == 195
    assert summarize.parse_time("1:02:05") == 3725
    assert summarize.parse_time("") is None
