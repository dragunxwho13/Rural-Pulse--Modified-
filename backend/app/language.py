"""
Language and script detection for the 22 scheduled languages of India + English.

Each language has a tier (data/protocol.json -> supported_languages):
  validated  English, Hindi, Tamil: tested demo lexicon, romanised input too
  core       11 more languages with an offline lexicon + full UI (draft, review needed)
  assisted   9 languages understood only with the AI layer (or an ASHA)
`supported` means the offline engine may triage it. Anything else is
reported honestly so the triage engine can abstain instead of guessing.
"""
import re
from typing import Dict

from .protocol import normalize, protocol, match_concepts, concept_langs


def _script_counts(text: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    ranges = protocol()["script_ranges"]
    for ch in text:
        cp = ord(ch)
        for r in ranges:
            if int(r["from"], 16) <= cp <= int(r["to"], 16):
                counts[r["lang"]] = counts.get(r["lang"], 0) + 1
                break
    return counts


def _result(code: str, script: str, conf: float, name: str = None) -> Dict:
    sup = protocol()["supported_languages"]
    info = sup.get(code)
    if not info:
        return {"code": code, "name": name or code, "tier": "untested", "supported": False, "script": script, "confidence": conf}
    tier = info["tier"]
    if script == "latin" and not info.get("romanized") and code != "en":
        tier = "untested"
    return {"code": code, "name": name or info["name"], "native": info["native"], "tier": tier,
            "supported": tier in ("validated", "core"), "script": script, "confidence": conf}


def _family_pick(base: str, text: str) -> str:
    P = protocol()
    family = P["script_families"].get(base, [base])
    for code, chars in P["unique_chars"].items():
        if code in family and any(c in text for c in chars):
            return code
    tokens = set(normalize(text).split())
    scores = {c: 0 for c in family}
    for c in family:
        scores[c] += sum(1 for w in P["script_hints"].get(c, []) if w in tokens)
    for c, n in concept_langs(text).items():
        if c in scores:
            scores[c] += 2 * n
    best = max(family, key=lambda c: (scores[c], c == base))
    return best if scores[best] > 0 else base


def detect(text: str) -> Dict:
    P = protocol()
    counts = _script_counts(text)
    latin = len(re.findall(r"[A-Za-z]", text))
    if counts and sum(counts.values()) >= max(3, latin * 0.3):
        base = max(counts, key=counts.get)
        code = _family_pick(base, text)
        tier = P["supported_languages"][code]["tier"]
        return _result(code, "native", {"validated": 0.95, "core": 0.85}.get(tier, 0.6))

    tokens = normalize(text).split()
    scores = {k: 0 for k in P["roman_hints"]}
    for tok in tokens:
        for k, hints in P["roman_hints"].items():
            if tok in hints:
                scores[k] += 1
    for hit in match_concepts(text).values():
        if hit["lang"] in scores:
            scores[hit["lang"]] += 2
    if not tokens or max(scores.values()) == 0:
        return {"code": "unknown", "name": P["unsupported_language_names"]["unknown"], "tier": "untested",
                "supported": False, "script": "latin", "confidence": 0.3}
    best = max(scores, key=lambda k: (scores[k], k == "en"))
    if best == "or" and scores["or"] >= 2 and scores["or"] > max(scores["hi"], scores["ta"], scores["en"]):
        return {"code": "or", "name": P["unsupported_language_names"]["or-roman"], "tier": "untested",
                "supported": False, "script": "latin", "confidence": 0.6}
    if best == "or":
        best = max(("en", "hi", "ta"), key=lambda k: scores[k])
    if best == "en":
        return _result("en", "latin", 0.9)
    r = _result(best, "latin", 0.75)
    r["name"] = r["name"] + " (romanised)"
    return r
