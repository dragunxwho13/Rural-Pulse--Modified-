"""
Doctor-ready summary and patient checklist.

Built from templates, not free generation, so nothing appears that the
patient did not say. The patient's original words are kept verbatim next
to the normalised terms, and the summary records whether the patient
confirmed the read-back (evidence review: confirmation and provenance).
"""
from typing import Dict, List

from .protocol import msg, protocol, concept_label, t

LEVEL_EN = {"EMERGENCY": "EMERGENCY - call 108", "URGENT_SAME_DAY": "Same-day assessment",
            "PROMPT_ROUTINE": "Routine visit within 2-3 days", "INFO_SELF_CARE": "Self-care with safety-net advice",
            "CANNOT_DETERMINE": "Not determined - routed to a human"}


def _fmt_days(d):
    if d is None:
        return "not stated"
    if d == 0:
        return "started today"
    if d >= 14 and d % 7 == 0:
        return f"{int(d // 7)} week(s)"
    return f"{d:g} day(s)"


def checklist(category: str, facts: Dict, lang: str) -> List[str]:
    keys = ["medicines", "id", "companion", "phone"]
    if facts.get("pregnant"):
        keys.insert(0, "mcp_card")
    if facts.get("age_years") is not None and facts["age_years"] < 12:
        keys.insert(0, "vaccination_card")
    if "dog_bite" in facts.get("symptoms", []):
        keys.insert(0, "wound_wash")
    if category in ("tb", "respiratory"):
        keys.append("old_reports")
    if any(c in facts.get("comorbidities", []) for c in ("diabetes", "hypertension", "heart_disease")):
        keys.append("sugar_records")
    return [msg(f"checklist.{k}", lang) for k in dict.fromkeys(keys)]


def doctor_questions(lang: str, level: str) -> List[str]:
    keys = ["cause", "warning", "medicines", "followup"]
    if level == "EMERGENCY":
        keys = ["cause", "warning"]
    return [msg(f"doctor_questions.{k}", lang) for k in keys]


def build(message: str, facts: Dict, decision: Dict, nav: Dict, lang: str, confirmed: bool, mode: str) -> Dict:
    P = protocol()
    level = decision["level"]
    flags = facts.get("flags", [])
    sym_lines = []
    for s in facts.get("symptom_entries", []):
        words = f' (patient: "{s["patient_words"]}")' if s.get("patient_words") else ""
        src = "" if s.get("source") == "rules" else f" [{s.get('source')}]"
        sym_lines.append(f"{concept_label(s['id'])}{words}{src}")
    screen = facts.get("answers", {}).get("redflag_screen")
    screen_txt = {"yes": "YES - danger sign reported", "no": "answered no"}.get(str(screen).lower(), "not asked / not answered")
    primary = nav.get("primary")
    doctor = {
        "triage": LEVEL_EN[level],
        "protocol": P["version"],
        "rules": [r["id"] for r in decision["rules_fired"]],
        "patient_words": message.strip(),
        "language": facts["language"]["name"],
        "interpreted_symptoms": sym_lines or ["none recognised"],
        "duration": _fmt_days(facts.get("duration_days")),
        "age": "not stated" if facts.get("age_years") is None else (f"{facts['age_years'] * 12:.0f} months" if facts["age_years"] < 1 else f"{facts['age_years']:g} years"),
        "severity": "not stated" if facts.get("severity") is None else f"{facts['severity']}/10 (patient-rated)",
        "pregnancy": {True: "yes", False: "no"}.get(facts.get("pregnant"), "not stated"),
        "chronic_conditions": [concept_label(c) for c in facts.get("comorbidities", [])] or ["none stated"],
        "vitals": facts.get("vitals") or {},
        "danger_signs": [x["label"] for x in flags] or ["none detected in text"],
        "danger_screen_question": screen_txt,
        "risk_factors": decision["risk_factors"] or ["none stated"],
        "read_back_confirmed": bool(confirmed),
        "referred_to": f"{primary['name']} ({primary['id']})" if primary else "no verified match",
        "intake_mode": "ASHA / CHW assisted" if mode == "asha" else "patient self-report",
        "notes": decision["notes"],
    }
    lines = [
        f"RURALPULSE REFERRAL NOTE  |  {doctor['triage']}  |  {P['version']}",
        f"Patient's own words ({doctor['language']}): \"{doctor['patient_words']}\"",
        "Interpreted: " + "; ".join(doctor["interpreted_symptoms"]),
        f"Duration: {doctor['duration']}  Age: {doctor['age']}  Severity: {doctor['severity']}  Pregnant: {doctor['pregnancy']}",
        "Chronic: " + ", ".join(doctor["chronic_conditions"]) + "   Risk factors: " + ", ".join(doctor["risk_factors"]),
        "Danger signs: " + ", ".join(doctor["danger_signs"]) + f"   Screening question: {screen_txt}",
    ]
    if doctor["vitals"]:
        lines.append("Vitals (ASHA): " + ", ".join(f"{k}={v}" for k, v in doctor["vitals"].items()))
    lines += [
        f"Read-back confirmed by patient: {'yes' if confirmed else 'no'}   Intake: {doctor['intake_mode']}",
        "Rules fired: " + ", ".join(doctor["rules"]),
        "No diagnosis has been made. This note is navigation support only.",
    ]
    title = msg(f"levels.{decision['message_key']}.title", lang)
    sms = title + ". "
    if level == "EMERGENCY":
        num = "14416" if decision["message_key"] == "MENTAL_HEALTH_CRISIS" else "108"
        sms += f"{msg('ui.call', lang)} {num}."
        if primary:
            sms += f" {msg('ui.go_to', lang)}: {primary['name']} ({primary['phone']})."
    else:
        if primary:
            sms += f"{msg('ui.go_to', lang)}: {primary['name']}, {primary['open']['hours']}, {primary['phone']}. "
        if nav.get("teleconsult"):
            sms += f"{msg('ui.teleconsult', lang)}: {nav['teleconsult']['phone']}. "
        sms += msg("ui.if_worse", lang)
    slip = build_slip(message, facts, decision, nav, lang)
    return {
        "slip": slip,
        "doctor": doctor,
        "doctor_text": "\n".join(lines),
        "checklist": checklist(decision["category"], facts, lang) if level != "EMERGENCY" else [msg("checklist.companion", lang), msg("checklist.medicines", lang)],
        "questions_for_doctor": doctor_questions(lang, level),
        "sms": sms.strip(),
    }


def fmt_days_local(d, lang):
    if d is None:
        return "-"
    return msg("readback.for_days", lang).replace("{n}", f"{d:g}")


def build_slip(message: str, facts: Dict, decision: Dict, nav: Dict, lang: str) -> Dict:
    """Patient-facing visit slip in the patient's language (rendered as a one-page template by the website)."""
    level = decision["level"]
    key = decision["message_key"]
    primary = nav.get("primary")
    labels = {k: t(k, lang) for k in ("slip_title", "patient", "age", "problem", "since", "urgency", "go_to", "bring", "ask_doctor",
                                     "danger", "none", "date", "slip_no", "not_diagnosis", "for_doctor", "years", "call")}
    danger = []
    for f in facts.get("flags", []):
        ev = [concept_label(c, lang) for c in f.get("evidence", [])]
        danger.append(", ".join(ev) if ev else f["label"])
    age = facts.get("age_years")
    return {
        "lang": lang,
        "labels": labels,
        "urgency_level": level,
        "urgency_title": msg(f"levels.{key}.title", lang),
        "urgency_action": msg(f"levels.{key}.action", lang),
        "problem": message.strip(),
        "symptoms": [concept_label(s, lang) for s in facts.get("symptoms", [])],
        "age": None if age is None else (f"{round(age * 12)} m" if age < 1 else f"{age:g}"),
        "since": fmt_days_local(facts.get("duration_days"), lang),
        "danger": danger,
        "go_to": None if not primary else {"name": primary["name"], "phone": primary["phone"], "hours": primary["open"]["hours"],
                                           "distance_km": primary["distance_km"], "source": "verified directory"},
        "bring": checklist(decision["category"], facts, lang) if level != "EMERGENCY" else [msg("checklist.companion", lang)],
        "ask_doctor": doctor_questions(lang, level),
        "emergency_number": "14416" if key == "MENTAL_HEALTH_CRISIS" else ("108" if level in ("EMERGENCY", "URGENT_SAME_DAY") else "104"),
    }
