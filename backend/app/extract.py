"""
Deterministic, offline symptom extraction.

Turns free text into structured fields (symptoms, duration, age, severity,
pregnancy, chronic illness, medication-dose questions, prompt-injection
attempts) using the versioned lexicon in data/protocol.json. It never
guesses: a field it cannot find stays None and becomes a clarifying
question.
"""
import re
from typing import Dict, Optional

from .protocol import normalize, protocol, match_concepts, any_pattern, concept_label


def _alt(words):
    out = []
    for w in sorted(set(words), key=len, reverse=True):
        w = normalize(w)
        out.append(r"\s+".join(re.escape(p) for p in w.split(" ")))
    return "|".join(out)


def extract_duration(text: str) -> Optional[float]:
    D = protocol()["duration"]
    t = normalize(text)
    nums = D["number_words"]
    unit_alts = {u: _alt(ws) for u, ws in D["units"].items()}
    all_units = "|".join(f"(?P<{u}>{a})" for u, a in unit_alts.items())
    rx = re.compile(r"(?<![a-z0-9])(?P<n>\d+(?:\.\d+)?|" + _alt(nums.keys()) + r")\s*(?:-\s*)?(?:" + all_units + ")")
    best = None
    for m in rx.finditer(t):
        n = m.group("n")
        val = float(n) if re.match(r"\d", n) else float(nums.get(n, 0))
        unit = next(u for u in D["units"] if m.group(u))
        after = t[m.end():m.end() + 12]
        if re.match(r"\s*(ki|ka|ke|की|का|के|old|pregnant|garbh|गर्भ|கர்ப்ப|karpp|karbin)", after):
            continue  # "5 months pregnant" / "4 mahine ki" describe pregnancy or age, not symptom duration
        days = val * D["multipliers"][unit]
        if days > 0 and (best is None or days > best):
            best = days
    if best is not None:
        return best
    for phrase, val in sorted(D["since_phrases"].items(), key=lambda kv: len(kv[0]), reverse=True):
        ok, _ = any_pattern([phrase], t)
        if ok:
            return float(val)
    return None


def extract_age(text: str) -> Optional[float]:
    A = protocol()["age"]
    t = normalize(text)
    preg = r"\s*(?:pregnant|garbh|गर्भ|கர்ப்ப|karpp|karbin)"
    # 1) explicit prefix: "age 45", "umar 30", "I am 40", "வயது 45"
    for m in re.finditer(r"(?:" + _alt(A["prefix"]) + r")\s*(?:is|:|-)?\s*(\d{1,3})(?!\d)(?!\s*(?:month|week|day|mahine|din|महीने|दिन))", t):
        if 0 < int(m.group(1)) <= 120 and not re.match(preg, t[m.end():m.end() + 12]):
            return float(m.group(1))
    # 2) "45 years", "12 saal ka", "45 வயது"
    for m in re.finditer(r"(?<![0-9])(\d{1,3})\s*(?:-\s*)?(?:" + _alt(A["year_units"]) + r")", t):
        before = t[max(0, m.start() - 8):m.start()]
        after = t[m.end():m.end() + 6]
        if re.search(r"(for|since|past|last)\s*$", before) or re.match(r"\s*(se|से|aaga|ஆக)", after):
            continue  # a duration in years, not an age
        n = int(m.group(1))
        if 0 < n <= 120:
            return float(n)
    # 3) infants: "2 month old", "3 mahine ka bachcha" (but not "4 mahine ki garbhvati")
    for m in re.finditer(r"(?<![0-9])(\d{1,2})\s*(?:" + _alt(A["month_units_with_marker"]) + ")", t):
        if not re.match(preg, t[m.end():m.end() + 12]):
            return round(int(m.group(1)) / 12, 2)
    return None


def extract_severity(text: str) -> Optional[int]:
    t = normalize(text)
    m = re.search(r"(?<![0-9])(10|[0-9])\s*(?:/|out of|में से|il)\s*10", t)
    if m:
        return int(m.group(1))
    S = protocol()["severity_words"]
    if any_pattern(S["high"]["patterns"], t)[0]:
        return S["high"]["value"]
    if any_pattern(S["low"]["patterns"], t)[0]:
        return S["low"]["value"]
    return None


def extract(text: str) -> Dict:
    """Rule-based extraction from raw patient text."""
    P = protocol()
    concepts = match_concepts(text)
    symptoms, context, comorbid = [], [], []
    for cid, hit in concepts.items():
        c = P["concepts"][cid]
        entry = {"id": cid, "label": concept_label(cid), "category": c["category"],
                 "patient_words": hit["phrase"], "source": "rules"}
        if c.get("comorbidity"):
            comorbid.append(entry)
        elif c.get("context"):
            context.append(entry)
        else:
            symptoms.append(entry)
    med_dose = any(any_pattern(p, text)[0] for p in P["medication_dose"].values())
    injection, inj_phrase = any_pattern(P["injection_patterns"], text)
    duration = extract_duration(text)
    age = extract_age(text)
    severity = extract_severity(text)
    pregnant = True if "pregnancy" in concepts or "pregnancy_checkup" in concepts or "no_fetal_movement" in concepts else None
    if "newborn" in concepts and age is None:
        age = 0.08
    fields = {k: ("rules" if v is not None else None) for k, v in
              {"duration_days": duration, "age_years": age, "severity": severity, "pregnant": pregnant}.items()}
    return {
        "concept_ids": sorted(concepts.keys()),
        "symptoms": symptoms, "context": context, "comorbidities": comorbid,
        "duration_days": duration, "age_years": age, "severity": severity, "pregnant": pregnant,
        "med_dose": med_dose, "injection": injection, "injection_phrase": inj_phrase,
        "field_sources": fields,
    }
