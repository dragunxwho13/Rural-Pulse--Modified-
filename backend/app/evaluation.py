"""
Safety evaluation harness (evidence review: harm-weighted testing).

Runs the versioned vignette set in data/eval/vignettes.json through the
deterministic pipeline and reports the metrics recommended in the review:
red-flag sensitivity, under-triage (raw and severity-weighted),
over-triage, abstention, navigation match, and per-language results.
The vignettes are synthetic and authored by the team; they are a regression
and safety suite pending clinician review, not clinical validation.
"""
import json
from collections import defaultdict
from typing import Dict

from . import config
from .pipeline import assess, interpret
from .schemas import AssessRequest, InterpretRequest

ORDER = {"INFO_SELF_CARE": 0, "PROMPT_ROUTINE": 1, "URGENT_SAME_DAY": 2, "EMERGENCY": 3}


def run_case(v: Dict) -> Dict:
    base = dict(message=v["message"], language=v.get("language", "auto"), mode=v.get("mode", "patient"),
                answers=v.get("answers", {}), vitals=v.get("vitals", {}), at_time=v.get("at_time", "2026-10-07T11:00"))
    r = interpret(InterpretRequest(**base), use_llm=False)
    if r["stage"] == "confirm":
        r = assess(AssessRequest(**base, interpretation_id=r["interpretation_id"], confirmed=True), use_llm=False)
    got = r["urgency"]["level"]
    prim = (r["navigation"].get("primary") or {}).get("id")
    return {"id": v["id"], "group": v["group"], "lang": v.get("lang", "en"), "message": v["message"],
            "expected": v["expected"], "got": got, "facility": prim, "expected_facility": v.get("expected_facility"),
            "rules": [x["id"] for x in r["decision"]["rules_fired"]], "note": v.get("note", "")}


def run_suite() -> Dict:
    with open(config.DATA_DIR / "eval" / "vignettes.json", encoding="utf-8") as f:
        suite = json.load(f)
    rows = [run_case(v) for v in suite["cases"]]
    n = len(rows)
    exact = sum(r["got"] == r["expected"] for r in rows)
    em = [r for r in rows if r["expected"] == "EMERGENCY"]
    em_hit = sum(r["got"] == "EMERGENCY" for r in em)
    graded = [r for r in rows if r["expected"] in ORDER]
    under, over, sev_w = [], [], 0
    for r in graded:
        if r["got"] == "CANNOT_DETERMINE":
            continue
        diff = ORDER[r["got"]] - ORDER[r["expected"]]
        if diff < 0:
            under.append(r); sev_w += (-diff) * (1 + ORDER[r["expected"]])
        elif diff > 0:
            over.append(r)
    abst_expected = [r for r in rows if r["expected"] == "CANNOT_DETERMINE"]
    abst_correct = sum(r["got"] == "CANNOT_DETERMINE" for r in abst_expected)
    abstained = sum(r["got"] == "CANNOT_DETERMINE" for r in rows)
    nav = [r for r in rows if r["expected_facility"]]
    nav_ok = sum(r["facility"] == r["expected_facility"] for r in nav)
    by_lang = defaultdict(lambda: [0, 0])
    for r in rows:
        by_lang[r["lang"]][0] += 1
        by_lang[r["lang"]][1] += r["got"] == r["expected"]
    by_group = defaultdict(lambda: [0, 0])
    for r in rows:
        by_group[r["group"]][0] += 1
        by_group[r["group"]][1] += r["got"] == r["expected"]
    pct = lambda a, b: round(100 * a / b, 1) if b else None
    return {
        "suite": suite["name"], "suite_status": suite["status"], "n_cases": n,
        "metrics": {
            "exact_match_pct": pct(exact, n),
            "red_flag_sensitivity_pct": pct(em_hit, len(em)),
            "under_triage_pct": pct(len(under), len(graded)),
            "severity_weighted_under_triage": sev_w,
            "over_triage_pct": pct(len(over), len(graded)),
            "abstention_rate_pct": pct(abstained, n),
            "correct_abstention_pct": pct(abst_correct, len(abst_expected)),
            "facility_match_pct": pct(nav_ok, len(nav)),
        },
        "by_language": {k: {"n": a, "exact_pct": pct(b, a)} for k, (a, b) in sorted(by_lang.items())},
        "by_group": {k: {"n": a, "exact_pct": pct(b, a)} for k, (a, b) in sorted(by_group.items())},
        "under_triaged": [{"id": r["id"], "expected": r["expected"], "got": r["got"], "note": r["note"]} for r in under],
        "over_triaged": [{"id": r["id"], "expected": r["expected"], "got": r["got"], "note": r["note"]} for r in over],
        "cases": rows,
    }
