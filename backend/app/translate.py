"""
Translation of free text into any of the 22 scheduled languages (Gemini).

Used for the doctor's prescription notes, first-aid cards in languages
without a written pack, and the slip. Medicine names, numbers and units
are kept unchanged. Without an API key the original text is returned with
engine "none" so the website can say the text is not translated.
"""
import concurrent.futures as cf
import json
from typing import Dict, List

from . import config, llm
from .protocol import protocol

_CACHE: Dict[str, str] = {}
_POOL = cf.ThreadPoolExecutor(max_workers=2)

PROMPT = """Translate each string in the JSON array into {lang_name} ({native}), written in its usual script.
Rules: plain words a rural patient understands; keep medicine names, numbers, units, phone numbers and the
words "108", "104", "112", "14416", "ORS", "ASHA" unchanged; do not add advice; do not drop anything.
Return only a JSON array of the same length."""


def _call(texts: List[str], lang: str) -> List[str]:
    from google.genai import types
    info = protocol()["supported_languages"].get(lang, {"name": lang, "native": lang})
    resp = llm.generate(
        "text", contents=json.dumps(texts, ensure_ascii=False),
        config=types.GenerateContentConfig(system_instruction=PROMPT.format(lang_name=info["name"], native=info["native"]),
                                           temperature=0, response_mime_type="application/json", response_schema=list[str]))
    out = resp.parsed if isinstance(getattr(resp, "parsed", None), list) else json.loads(resp.text)
    if len(out) != len(texts):
        raise ValueError("length mismatch")
    return [str(x) for x in out]


def translate(texts: List[str], lang: str) -> Dict:
    texts = [str(t)[:1500] for t in texts[:60]]
    if lang == "en" or not texts:
        return {"texts": texts, "engine": "none", "lang": lang}
    todo = [t for t in texts if (lang + "|" + t) not in _CACHE and t.strip()]
    if todo and llm.available():
        try:
            res = _POOL.submit(_call, todo, lang).result(timeout=config.LLM_TIMEOUT_S * 2)
            for src, dst in zip(todo, res):
                _CACHE[lang + "|" + src] = dst
        except Exception as e:  # keep originals on any failure
            return {"texts": texts, "engine": "none", "lang": lang, "error": type(e).__name__}
    if any((lang + "|" + t) not in _CACHE for t in texts if t.strip()):
        return {"texts": texts, "engine": "none", "lang": lang}
    return {"texts": [_CACHE.get(lang + "|" + t, t) for t in texts], "engine": "gemini", "lang": lang}
