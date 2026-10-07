"""
RuralPulse coordinator.

    Patient text
      -> red-flag rules on raw text (deterministic; emergency bypasses the LLM)
      -> language detection (named, tested languages only)
      -> understanding: offline extractor (+ optional Gemini, schema-validated)
      -> red-flag rules again on everything understood (escalation only)
      -> read-back + targeted clarifying questions  [stage: confirm]
      -> patient confirms / corrects
      -> versioned urgency protocol with abstention   (triage.py)
      -> verified facility navigation with provenance (navigation.py)
      -> doctor summary, checklist, SMS text          (summary.py)
      -> de-identified audit record                   (audit.py)
"""
from collections import OrderedDict
from datetime import datetime
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from . import audit, config, firstaid, llm
from .extract import extract
from .language import detect
from .navigation import navigate
from .protocol import concept_label, msg, protocol, t
from .summary import build as build_summary
from .triage import decide, red_flags

_CACHE: "OrderedDict[str, Dict]" = OrderedDict()


def _now(at_time: Optional[str]) -> datetime:
    if at_time:
        try:
            return datetime.fromisoformat(at_time.replace("Z", "")).replace(tzinfo=None)
        except ValueError:
            pass
    return datetime.now(ZoneInfo(config.TIMEZONE)).replace(tzinfo=None)


def _out_lang(pref: str, detected: Dict) -> str:
    sup = protocol()["supported_languages"]
    if pref in sup:
        return pref
    return detected["code"] if detected["code"] in sup else "en"


def _num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def understand(message: str, use_llm: bool = True) -> Dict:
    """Rules + optional LLM -> merged interpretation (no urgency yet)."""
    lang = detect(message)
    ex = extract(message)
    sources = {c: "rules" for c in ex["concept_ids"]}
    concepts = set(ex["concept_ids"])
    phrases = {s["id"]: s["patient_words"] for s in ex["symptoms"] + ex["context"] + ex["comorbidities"]}
    llm_info = {"used": False, "status": "disabled" if not llm.available() else "skipped", "model": None, "gist": None,
                "unclear": []}
    # Emergency short-circuit: red flag in raw text -> never wait for the model.
    pre_flags = red_flags(concepts, ex["age_years"], {}, {}, sources)
    if use_llm and llm.available() and not pre_flags:
        res = llm.interpret(message)
        if res["ok"]:
            d = res["data"]
            llm_info.update(used=True, status="ok", model=config.LLM_MODEL, gist=d["english_gist"], unclear=d["unclear_phrases"])
            for c in d["concept_ids"]:
                if c not in concepts:
                    concepts.add(c)
                    sources[c] = "llm"
            for p in d["phrases"]:
                phrases.setdefault(p["concept_id"], p["phrase"])
            for k_ex, k_llm in (("duration_days", "duration_days"), ("age_years", "age_years"), ("severity", "severity_0_10"), ("pregnant", "pregnant")):
                if ex[k_ex] is None and d.get(k_llm) is not None:
                    ex[k_ex] = d[k_llm]
                    ex["field_sources"][k_ex] = "llm"
            ex["med_dose"] = ex["med_dose"] or d["is_medication_dose_question"]
            sup = protocol()["supported_languages"]
            if not lang["supported"] and d["concept_ids"]:
                code = d["language_code"] if d["language_code"] in sup else lang["code"]
                base = sup.get(code, {})
                lang = {"code": code, "name": base.get("name", code) + " (understood by AI)", "native": base.get("native"),
                        "tier": "assisted", "supported": True, "script": lang["script"], "confidence": 0.7}
            elif not lang["supported"]:
                lang["name"] = f"{lang['name']} (AI saw no clear symptom)"
        else:
            llm_info.update(status="fallback", error=res["error"])
    elif pre_flags:
        llm_info["status"] = "bypassed: red flag found by rules"
    if ex["pregnant"] is None and "pregnancy" in concepts:
        ex["pregnant"] = True
    return {"language": lang, "concepts": sorted(concepts), "sources": sources, "phrases": phrases,
            "duration_days": ex["duration_days"], "age_years": ex["age_years"], "severity": ex["severity"],
            "pregnant": ex["pregnant"], "med_dose": ex["med_dose"], "injection": ex["injection"],
            "field_sources": ex["field_sources"], "llm": llm_info}


def _facts(u: Dict, answers: Dict, vitals: Dict, symptom_ids: Optional[List[str]] = None) -> Dict:
    C = protocol()["concepts"]
    concepts = set(u["concepts"])
    sources = dict(u["sources"])
    if symptom_ids is not None:
        rf_concepts = {c for rf in protocol()["red_flags"] for g in rf["requires"] for c in g}
        keep = {c for c in concepts if c in rf_concepts or C.get(c, {}).get("context") or C.get(c, {}).get("comorbidity")}
        for s in symptom_ids:
            if s in C and s not in concepts:
                sources[s] = "patient-edit"
        concepts = keep | {s for s in symptom_ids if s in C}
    age = _num(answers.get("age")) if _num(answers.get("age")) is not None else u["age_years"]
    dur = _num(answers.get("duration_days")) if _num(answers.get("duration_days")) is not None else u["duration_days"]
    sev = _num(answers.get("severity")) if _num(answers.get("severity")) is not None else u["severity"]
    preg = u["pregnant"]
    pa = str(answers.get("pregnant", "")).lower()
    if pa == "yes":
        preg = True; concepts.add("pregnancy"); sources.setdefault("pregnancy", "answer")
    elif pa in ("no", "na"):
        preg = False if "pregnancy" not in u["concepts"] else preg
    comorb = [c for c in concepts if C.get(c, {}).get("comorbidity")]
    if str(answers.get("chronic", "")).lower() == "yes" and not comorb:
        comorb.append("chronic illness (type not stated)")
    symptoms = [c for c in sorted(concepts) if c in C and not C[c].get("context") and not C[c].get("comorbidity")]
    v = {k: x for k, x in (vitals or {}).items() if x is not None}
    flags = red_flags(concepts, age, v, answers, sources)
    entries = [{"id": s, "label": concept_label(s), "patient_words": u["phrases"].get(s), "source": sources.get(s, "rules")}
               for s in symptoms]
    return {"concepts": concepts, "symptoms": symptoms, "symptom_entries": entries, "flags": flags,
            "language": u["language"], "age_years": age, "duration_days": dur,
            "severity": int(sev) if sev is not None else None, "pregnant": preg, "comorbidities": comorb,
            "med_dose": u["med_dose"], "vitals": v, "answers": answers, "injection": u["injection"]}


def _questions(u: Dict, facts: Dict, lang: str, answers: Dict) -> List[Dict]:
    q = []
    def add(qid, kind, required, options=None):
        if qid in answers and answers[qid] not in (None, ""):
            return
        q.append({"id": qid, "text": msg(f"questions.{qid}", lang), "type": kind, "required": required, "options": options})
    add("redflag_screen", "yesno", True, ["yes", "no"])
    if facts["age_years"] is None:
        add("age", "number", True)
    if facts["duration_days"] is None:
        add("duration_days", "number", True)
    if facts["severity"] is None:
        add("severity", "scale", False)
    age = facts["age_years"]
    if facts["pregnant"] is None and (age is None or 12 <= age <= 50):
        add("pregnant", "yesno", False, ["yes", "no", "na"])
    if not facts["comorbidities"]:
        add("chronic", "yesno", False, ["yes", "no"])
    return q


def _readback(message: str, facts: Dict, lang: str) -> str:
    parts = [concept_label(s, lang) for s in facts["symptoms"]]
    if facts["pregnant"]:
        parts.append(concept_label("pregnancy", lang))
    if facts["duration_days"] is not None:
        parts.append(msg("readback.for_days", lang).replace("{n}", f"{facts['duration_days']:g}"))
    if facts["age_years"] is not None:
        parts.append(msg("readback.age", lang).replace("{n}", f"{facts['age_years']:g}"))
    understood = ", ".join(parts) if facts["symptoms"] else msg("readback.nothing", lang)
    return f"{msg('readback.you_said', lang)}: “{message.strip()}”. {msg('readback.understood', lang)}: {understood}. {msg('readback.correct', lang)}"


def _result(message: str, u: Dict, facts: Dict, lang: str, mode: str, at: datetime, confirmed: bool,
            consent: bool, stage: str) -> Dict:
    d = decide(facts)
    labels = [concept_label(s) for s in facts["symptoms"]]
    nav = navigate(d["level"], d["category"], facts["flags"], labels, at, protocol()["supported_languages"].get(lang, {}).get("name", "English"))
    summ = build_summary(message, facts, d, nav, lang, confirmed, mode)
    fa = firstaid.cards(d["level"], facts["flags"], facts["symptoms"], bool(facts["pregnant"]), lang)
    prep = firstaid.prep_for_clinician(facts["flags"], facts["symptoms"], bool(facts["pregnant"]))
    aid = audit.new_id()
    used = [c for c in [nav.get("primary")] + nav.get("alternatives", []) + [nav.get("teleconsult")] if c]
    notes = list(d["notes"])
    if facts.get("injection"):
        notes.append("Instruction-like text was found in the message and ignored. Rules ran on the raw text.")
        d["rules_fired"].append({"id": "SEC-INJ", "desc": "Prompt-injection pattern detected and ignored"})
    d["notes"] = notes
    a = audit.record({
        "assessment_id": aid, "engine": "server", "protocol_version": protocol()["version"],
        "level": d["level"], "rules_fired": [r["id"] for r in d["rules_fired"]],
        "llm": {k: u["llm"].get(k) for k in ("used", "status", "model")},
        "retrieval": nav["retrieval"], "language": facts["language"]["code"], "mode": mode,
        "read_back_confirmed": confirmed,
        "facility_records": [{"id": c["id"], "last_verified": c["provenance"]["last_verified"], "status": c["freshness"]["status"]} for c in used],
        "field_sources": u["field_sources"],
    }, message, consent)
    key = d["message_key"]
    return {
        "stage": stage, "assessment_id": aid,
        "urgency": {"level": d["level"], "key": key, "title": msg(f"levels.{key}.title", lang), "action": msg(f"levels.{key}.action", lang)},
        "decision": {**d, "abstain_text": [msg(f"abstain_reasons.{r}", lang) for r in d["abstain_reasons"]]},
        "interpretation": _public_interp(u, facts),
        "navigation": nav, "summary": summ, "language_out": lang, "first_aid": fa, "clinician_prep": prep,
        "category": d["category"], "needs": nav["needs"],
        "emergency_numbers": protocol()["emergency_numbers"], "audit": a,
    }


def _public_interp(u: Dict, facts: Dict) -> Dict:
    return {"language": facts["language"], "symptoms": facts["symptom_entries"],
            "red_flags": [{"id": f["id"], "label": f["label"], "source": f["source"]} for f in facts["flags"]],
            "age_years": facts["age_years"], "duration_days": facts["duration_days"], "severity": facts["severity"],
            "pregnant": facts["pregnant"], "comorbidities": facts["comorbidities"], "med_dose": facts["med_dose"],
            "injection_detected": facts["injection"], "field_sources": u["field_sources"], "llm": u["llm"]}


def interpret(req, use_llm: bool = True) -> Dict:
    u = understand(req.message, use_llm)
    facts = _facts(u, req.answers, req.vitals.model_dump())
    lang = _out_lang(req.language, u["language"])
    at = _now(req.at_time)
    if facts["flags"]:
        return _result(req.message, u, facts, lang, req.mode, at, False, req.consent_store, "emergency")
    iid = audit.new_id().replace("RP-", "IN-")
    _CACHE[iid] = {"message": req.message, "u": u}
    while len(_CACHE) > 1000:
        _CACHE.popitem(last=False)
    return {"stage": "confirm", "interpretation_id": iid, "language_out": lang,
            "readback": _readback(req.message, facts, lang),
            "questions": _questions(u, facts, lang, req.answers),
            "interpretation": _public_interp(u, facts),
            "symptom_options": [{"id": cid, "label": concept_label(cid, lang)} for cid, c in protocol()["concepts"].items()
                                if not c.get("context") and not c.get("comorbidity")]}


def assess(req, use_llm: bool = True) -> Dict:
    cached = _CACHE.get(req.interpretation_id or "")
    u = cached["u"] if cached and cached["message"] == req.message else understand(req.message, use_llm)
    facts = _facts(u, req.answers, req.vitals.model_dump(), req.symptom_ids)
    lang = _out_lang(req.language, u["language"])
    stage = "emergency" if facts["flags"] else "result"
    return _result(req.message, u, facts, lang, req.mode, _now(req.at_time), req.confirmed, req.consent_store, stage)
