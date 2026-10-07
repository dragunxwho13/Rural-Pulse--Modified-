"""
Loads the versioned clinical protocol (data/protocol.json), UI strings
(data/i18n.json), first-aid guidance, clinician prep lists, the facility
directory and the doctors listing, and provides the text matcher shared by
every rule. The same JSON files drive the offline browser engine
(frontend/assets/js/engine.js), so there is one source of truth.
"""
import json
import re
import unicodedata
from functools import lru_cache
from typing import Dict, List, Tuple

from . import config

_PUNCT = re.compile(r"[.,!?;:()\[\]{}\"“”‘/\\|।॥…*#_~<>؟،۔]+")


@lru_cache(maxsize=1)
def _digit_map() -> Dict[int, str]:
    table = {}
    for z in protocol()["native_digit_zeros"]:
        base = int(z, 16)
        for i in range(10):
            table[base + i] = str(i)
    return table


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFC", text or "").lower()
    t = t.replace("’", "'").replace("`", "'").translate(_digit_map())
    t = _PUNCT.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def _is_ascii(s: str) -> bool:
    return all(ord(ch) < 128 for ch in s)


@lru_cache(maxsize=8192)
def _compile(pattern: str):
    p = normalize(pattern)
    if _is_ascii(p):
        body = r"\s+".join(re.escape(w) for w in p.split(" "))
        return re.compile(r"(?<![a-z0-9])" + body + r"(?![a-z0-9])")
    return re.compile(re.escape(p))


def find(pattern: str, text_norm: str):
    """Return the match object for one pattern in normalised text (or None)."""
    return _compile(pattern).search(text_norm)


def _load(name: str) -> Dict:
    with open(config.DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def protocol() -> Dict:
    return _load("protocol.json")


@lru_cache(maxsize=1)
def i18n() -> Dict:
    return _load("i18n.json")


@lru_cache(maxsize=1)
def first_aid_doc() -> Dict:
    return _load("first_aid.json")


@lru_cache(maxsize=1)
def prep_doc() -> Dict:
    return _load("prep.json")


@lru_cache(maxsize=1)
def facilities_doc() -> Dict:
    return _load("facilities.json")


@lru_cache(maxsize=1)
def doctors_doc() -> Dict:
    return _load("doctors.json")


def facilities() -> List[Dict]:
    return facilities_doc()["facilities"]


def lang_chain(lang: str) -> List[str]:
    """Language fallback chain, e.g. kok -> mr -> hi -> en."""
    sup = protocol()["supported_languages"]
    chain, cur = [], lang
    while cur and cur not in chain:
        chain.append(cur)
        cur = sup.get(cur, {}).get("fallback")
    if "en" not in chain:
        chain.append("en")
    return chain


def pick(node: Dict, lang: str) -> str:
    for code in lang_chain(lang):
        if node.get(code):
            return node[code]
    return next(iter(node.values()), "")


def pick_lang(node: Dict, lang: str) -> str:
    """Which language pick() would actually use."""
    for code in lang_chain(lang):
        if node.get(code):
            return code
    return "en"


def match_concepts(text: str) -> Dict[str, Dict]:
    """Find every protocol concept mentioned in the text.

    Returns {concept_id: {"phrase": matched words, "lang": pattern language}}.
    """
    t = normalize(text)
    hits: Dict[str, Dict] = {}
    if not t:
        return hits
    for cid, concept in protocol()["concepts"].items():
        for lang, pats in concept["patterns"].items():
            for p in sorted(pats, key=len, reverse=True):
                m = find(p, t)
                if m:
                    hits[cid] = {"phrase": m.group(0), "lang": lang}
                    break
            if cid in hits:
                break
    return hits


def concept_langs(text: str) -> Dict[str, int]:
    """How many concept patterns of each language occur in the text (for language detection)."""
    t = normalize(text)
    out: Dict[str, int] = {}
    for concept in protocol()["concepts"].values():
        for lang, pats in concept["patterns"].items():
            if any(find(p, t) for p in pats):
                out[lang] = out.get(lang, 0) + 1
    return out


def any_pattern(patterns: List[str], text: str) -> Tuple[bool, str]:
    t = normalize(text)
    for p in sorted(patterns, key=len, reverse=True):
        m = find(p, t)
        if m:
            return True, m.group(0)
    return False, ""


def msg(path: str, lang: str) -> str:
    """Fetch a localised protocol message, e.g. msg('levels.EMERGENCY.title', 'bn')."""
    node = protocol()["messages"]
    for part in path.split("."):
        node = node[part]
    return pick(node, lang)


def t(key: str, lang: str) -> str:
    """Fetch a localised UI string from data/i18n.json."""
    return pick(i18n()["strings"].get(key, {"en": key}), lang)


def concept_label(cid: str, lang: str = "en") -> str:
    c = protocol()["concepts"].get(cid)
    if not c:
        return cid.replace("_", " ")
    return pick(c["label"], lang)
