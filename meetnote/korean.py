"""Korean text helpers backed by Kiwi (spacing correction, noun extraction).

Kiwi is optional: without it the functions return their input unchanged or
fall back to simple regex tokenisation.
"""
from __future__ import annotations

import re
import threading

_kiwi = None
_lock = threading.Lock()
_failed = False

HANGUL = re.compile(r"[가-힣]")
NUM_UNIT = re.compile(r"(\d)\s+(만|천|백|억|조|주|일|월|년|시|분|초|개|명|원|번|차|회|층|호|등|위|%|퍼센트|배|살|세|시간|개월|주년|주차|분기)(?=[\s가-힣.,?!]|$)")


def kiwi():
    global _kiwi, _failed
    if _kiwi is None and not _failed:
        with _lock:
            if _kiwi is None and not _failed:
                try:
                    from kiwipiepy import Kiwi
                    _kiwi = Kiwi()
                except Exception:
                    _failed = True
    return _kiwi


def fix_spacing(text: str) -> str:
    """Re-space Korean text (speech models often split words: '생각 을 하 면서')."""
    if not text or not HANGUL.search(text):
        return text
    k = kiwi()
    if k is None:
        return text
    try:
        out = k.space(text, reset_whitespace=True)
    except Exception:
        return text
    return NUM_UNIT.sub(r"\1\2", out)


def nouns(text: str) -> list[str]:
    """Nouns and noun compounds, e.g. '마케팅 예산은' -> ['마케팅', '예산']."""
    k = kiwi()
    if k is None:
        return []
    out = []
    for t in k.tokenize(text):
        if t.tag in ("NNG", "NNP", "SL") and (len(t.form) > 1 or t.tag == "NNP"):
            out.append(t.form)
    return out


QUESTION_END = re.compile(r"(까|까요|나요|니|니까|가요|죠|을까|ㄹ까|는지|습니까|입니까|어때|어때요|뭐야|뭐예요|거야|거예요)$")


def punctuate(text: str) -> str:
    """Add sentence-final punctuation the speech model left out.

    '말씀드리겠습니다 현재 베타 테스트가…' -> '말씀드리겠습니다. 현재 베타 테스트가…'
    """
    if not text or not HANGUL.search(text):
        return text
    k = kiwi()
    if k is None:
        return text
    try:
        sents = [s.text.strip() for s in k.split_into_sents(text)]
    except Exception:
        return text
    out = []
    for s in sents:
        if not s:
            continue
        if not re.search(r"[.?!…。？！,]$", s):
            s += "?" if QUESTION_END.search(s) else "."
        out.append(s)
    return " ".join(out)


def split_sentences(text: str) -> list[str]:
    k = kiwi()
    if k is None or not HANGUL.search(text or ""):
        return [p for p in re.split(r"(?<=[.?!。？！])\s+", (text or "").strip()) if p]
    try:
        return [s.text.strip() for s in k.split_into_sents(text) if s.text.strip()]
    except Exception:
        return [text]
