"""Compare the browser engine output (.parity_js.json from parity_check.js) with the Python server."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("RP_USE_LLM", "0")
os.environ.setdefault("RP_AUDIT_LOG", "0")
from backend.app.evaluation import run_suite  # noqa: E402
from backend.app.pipeline import assess, interpret  # noqa: E402
from backend.app.schemas import AssessRequest, InterpretRequest  # noqa: E402

js = json.loads((ROOT / ".parity_js.json").read_text(encoding="utf-8"))
py = {c["id"]: [c["got"], c["facility"], c["rules"]] for c in run_suite()["cases"]}
bad = [(c[0], py[c[0]], c[1:]) for c in js["cases"] if py[c[0]] != c[1:]]
for d in js["deep"]:
    base = dict(message=d["m"], at_time="2026-10-07T11:00", answers={"redflag_screen": "no"})
    i = interpret(InterpretRequest(**base), use_llm=False)
    a = assess(AssessRequest(**base, interpretation_id=i["interpretation_id"], confirmed=True), use_llm=False) if i["stage"] == "confirm" else i
    mine = {"m": d["m"], "lang": a["interpretation"]["language"], "readback": i.get("readback"), "q": [x["id"] for x in i.get("questions", [])],
            "level": a["urgency"]["level"], "title": a["urgency"]["title"], "rules": [x["id"] for x in a["decision"]["rules_fired"]],
            "slip": a["summary"]["slip"], "first_aid": a["first_aid"], "prep": a["clinician_prep"], "sms": a["summary"]["sms"]}
    for k in mine:
        if json.dumps(mine[k], sort_keys=True, ensure_ascii=False) != json.dumps(d[k], sort_keys=True, ensure_ascii=False):
            bad.append((d["m"], k, mine[k], d[k]))
print("vignettes:", len(js["cases"]), " multilingual samples:", len(js["deep"]), " mismatches:", len(bad))
for b in bad[:12]:
    print(" ", b)
sys.exit(1 if bad else 0)
