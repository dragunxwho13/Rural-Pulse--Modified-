"""
Deterministic, versioned urgency protocol.

Safety-critical policy lives here, separated from generative text (evidence
review, recommendation 1). Every outcome is tied to rule ids from
data/protocol.json so it can be audited and reviewed by clinicians.

Levels: EMERGENCY > URGENT_SAME_DAY > PROMPT_ROUTINE > INFO_SELF_CARE,
plus CANNOT_DETERMINE (explicit abstention).
"""
from typing import Dict, List, Optional, Set

from .protocol import protocol

LEVELS = ["INFO_SELF_CARE", "PROMPT_ROUTINE", "URGENT_SAME_DAY", "EMERGENCY"]


def rule_desc(rid: str) -> str:
    for r in protocol()["rules"]:
        if r["id"] == rid:
            return r["desc"]
    for r in protocol()["red_flags"] + protocol()["numeric_red_flags"]:
        if r["id"] == rid:
            return r["label"]
    return rid


def red_flags(concepts: Set[str], age: Optional[float], vitals: Dict, answers: Dict,
              sources: Dict[str, str]) -> List[Dict]:
    """Evaluate every red-flag rule. `sources` maps concept id -> where it came from."""
    P = protocol()
    out = []
    for rf in P["red_flags"]:
        if all(any(c in concepts for c in group) for group in rf["requires"]):
            used = [c for g in rf["requires"] for c in g if c in concepts]
            src = "llm" if all(sources.get(c) == "llm" for c in used) else sources.get(used[0], "rules")
            out.append({"id": rf["id"], "label": rf["label"], "action": rf["action"], "category": rf["category"],
                        "service": rf["service"], "evidence": used, "source": src})
    for rf in P["numeric_red_flags"]:
        w = rf["when"]
        hit = False
        if "concept" in w and w["concept"] in concepts and age is not None and age < w["age_years_lt"]:
            hit = True
        if "vital" in w and vitals.get(w["vital"]) is not None and float(vitals[w["vital"]]) < w["lt"]:
            hit = True
        if "answer" in w and str(answers.get(w["answer"], "")).lower() == w["eq"]:
            hit = True
        if hit:
            out.append({"id": rf["id"], "label": rf["label"], "action": rf["action"], "category": rf["category"],
                        "service": rf["service"], "evidence": [], "source": "rules"})
    return out


def _bump(level: str) -> str:
    i = LEVELS.index(level)
    return LEVELS[min(i + 1, LEVELS.index("URGENT_SAME_DAY"))] if i < LEVELS.index("URGENT_SAME_DAY") else level


def decide(f: Dict) -> Dict:
    """
    f = merged facts: concepts(set), symptoms(list of ids), flags(list), language(dict),
        age_years, duration_days, severity, pregnant, comorbidities(list ids),
        med_dose(bool), vitals(dict)
    """
    P = protocol()
    C = P["concepts"]
    fired: List[str] = []
    notes: List[str] = []
    abstain: List[str] = []
    age, dur, sev = f.get("age_years"), f.get("duration_days"), f.get("severity")
    symptoms = [s for s in f["symptoms"]]
    vitals = f.get("vitals") or {}

    risk = []
    if age is not None and age < 5:
        risk.append("Child under 5")
    if age is not None and age >= 65:
        risk.append("Age 65 or over")
    if f.get("pregnant"):
        risk.append("Pregnant")
    for c in f.get("comorbidities", []):
        risk.append(C[c]["label"]["en"].capitalize() if c in C else c)

    flags = f["flags"]
    if flags:
        crisis = any(x["action"] == "MENTAL_HEALTH_CRISIS" for x in flags)
        fired = ["R-EM-RF"] + [x["id"] for x in flags]
        if not f["language"]["supported"]:
            fired.append("R-LANG-ESC")
            notes.append("Danger sign detected in a language RuralPulse has not validated. Escalating is the safe direction; a human should confirm.")
        if f["language"].get("tier") in ("core", "assisted"):
            fired.append("R-LANG-DRAFT")
        if any(x["source"] == "llm" for x in flags):
            notes.append("At least one danger sign was recognised by the language model only. Treated as real (escalation only).")
        cat = flags[0]["category"]
        return _result("EMERGENCY", "MENTAL_HEALTH_CRISIS" if crisis and len({x['action'] for x in flags}) == 1 else "EMERGENCY",
                       fired, abstain, notes, risk, cat, True)

    if not f["language"]["supported"]:
        abstain.append("LANG_UNSUPPORTED")
        return _result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-LANG"], abstain, notes, risk, "general", True)

    real_symptoms = [s for s in symptoms if s != "pregnancy_checkup"]
    if f.get("med_dose"):
        notes.append("Medication-dose question detected. RuralPulse does not give doses; ask a doctor, pharmacist or call 104.")
        if not symptoms:
            abstain.append("MED_DOSE")
            return _result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-MED"], abstain, notes, risk, "general", True)
    if not symptoms:
        abstain.append("NO_SYMPTOMS")
        return _result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-NOSYM"], abstain, notes, risk, "general", True)
    if age is None or dur is None:
        abstain.append("MISSING_INFO")
        return _result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-MISSING"], abstain, notes, risk, "general", True)

    # ---- base level from the decision table
    level = None
    if any(C[s].get("urgent") for s in symptoms if s in C):
        level, fired = "URGENT_SAME_DAY", fired + ["R-UR-FLAGGED"]
    if sev is not None and sev >= 7:
        level = "URGENT_SAME_DAY"; fired.append("R-UR-SEV")
    if "fever" in symptoms and dur >= 3:
        level = "URGENT_SAME_DAY"; fired.append("R-UR-FEVER3")
    if age < 5 and any(s in symptoms for s in ("diarrhoea", "vomiting", "fever")):
        level = "URGENT_SAME_DAY"; fired.append("R-UR-CHILD-GI")
    spo2 = vitals.get("spo2")
    if spo2 is not None and 90 <= float(spo2) <= 93:
        level = "URGENT_SAME_DAY"; fired.append("R-UR-SPO2")
    temp = vitals.get("temp_c")
    if temp is not None and float(temp) >= 39.5:
        level = "URGENT_SAME_DAY"; fired.append("R-UR-TEMP")
    if f.get("pregnant") and real_symptoms:
        level = "URGENT_SAME_DAY"; fired.append("R-UR-PREG")

    category = None
    anc_only = symptoms == ["pregnancy_checkup"]
    if anc_only and level is None:
        return _result("PROMPT_ROUTINE", "PROMPT_ROUTINE", ["R-RT-ANC"], abstain, notes, risk, "maternal", bool(risk))
    if level is None:
        if "cough" in symptoms and dur >= 14:
            level = "PROMPT_ROUTINE"; fired.append("R-RT-COUGH14"); category = "tb"
        elif dur >= 7:
            level = "PROMPT_ROUTINE"; fired.append("R-RT-LONG")
        elif any(C[s]["category"] == "mental" for s in symptoms):
            level = "PROMPT_ROUTINE"; fired.append("R-RT-MENTAL")
        elif (all(C[s].get("minor") for s in symptoms) and dur < 3 and (sev is None or sev <= 3)):
            level = "INFO_SELF_CARE"; fired.append("R-IN-MINOR")
        else:
            level = "PROMPT_ROUTINE"; fired.append("R-RT-DEFAULT")
    elif "cough" in symptoms and dur >= 14:
        category = "tb"; fired.append("R-RT-COUGH14")

    human = bool(risk)
    if risk and level in ("INFO_SELF_CARE", "PROMPT_ROUTINE"):
        level = _bump(level); fired.append("R-MOD-RISK")
    elif risk:
        fired.append("R-MOD-RISK")

    if category is None:
        ranked = sorted(symptoms, key=lambda s: (not C[s].get("urgent"), bool(C[s].get("minor"))))
        if C[ranked[0]].get("urgent") and C[ranked[0]]["category"] in ("bite", "injury"):
            category = C[ranked[0]]["category"]
        elif f.get("pregnant"):
            category = "maternal"
        elif age < 12:
            category = "pediatric"
        else:
            category = C[ranked[0]]["category"]
    if f["language"].get("tier") == "core":
        fired.append("R-LANG-DRAFT")
        notes.append(f"{f['language']['name']} uses a draft offline vocabulary. A health worker should check this result.")
        human = True
    elif f["language"].get("tier") == "assisted":
        notes.append(f"{f['language']['name']} was understood by the AI layer, not the offline rules. A health worker should check this result.")
        human = True
    if f["language"].get("script") == "latin" and f["language"].get("confidence", 1) < 0.8:
        notes.append("Romanised input: understanding confidence is moderate, so the patient confirmed the read-back.")
    return _result(level, level, fired, abstain, notes, risk, category, human)


def _result(level, message_key, fired, abstain, notes, risk, category, human):
    seen, rules = set(), []
    for r in fired:
        if r not in seen:
            seen.add(r)
            rules.append({"id": r, "desc": rule_desc(r)})
    return {"level": level, "message_key": message_key, "rules_fired": rules, "abstain_reasons": abstain,
            "notes": notes, "risk_factors": risk, "category": category,
            "human_review": human or level == "CANNOT_DETERMINE"}
