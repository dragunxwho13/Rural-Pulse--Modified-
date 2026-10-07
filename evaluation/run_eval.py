"""Run the RuralPulse safety suite from the command line.

    python evaluation/run_eval.py            # summary
    python evaluation/run_eval.py --cases    # every case
    python evaluation/run_eval.py --json out.json
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("RP_USE_LLM", "0")
os.environ.setdefault("RP_AUDIT_LOG", "0")

from backend.app.evaluation import run_suite  # noqa: E402


def main():
    r = run_suite()
    print(f"{r['suite']}  ({r['n_cases']} cases)\n{r['suite_status']}\n")
    for k, v in r["metrics"].items():
        print(f"  {k:34s} {v}")
    print("\nBy language:", ", ".join(f"{k} {v['exact_pct']}% (n={v['n']})" for k, v in r["by_language"].items()))
    for u in r["under_triaged"]:
        print(f"\nUNDER-TRIAGE {u['id']}: expected {u['expected']}, got {u['got']}\n  {u['note']}")
    if "--cases" in sys.argv:
        print()
        for c in r["cases"]:
            mark = "ok " if c["got"] == c["expected"] else "MISS"
            print(f"{mark} {c['id']:6s} {c['expected']:17s} {c['got']:17s} {c['facility'] or '-':8s} {c['message'][:60]}")
    if "--json" in sys.argv:
        out = sys.argv[sys.argv.index("--json") + 1]
        Path(out).write_text(json.dumps(r, indent=2, ensure_ascii=False), encoding="utf-8")
        print("\nwritten", out)


if __name__ == "__main__":
    main()
