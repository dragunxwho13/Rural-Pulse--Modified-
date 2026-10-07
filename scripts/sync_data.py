"""Copy the canonical data files into frontend/data so the static site and
offline browser engine use exactly the same protocol, strings and directories."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ("protocol.json", "facilities.json", "i18n.json", "first_aid.json", "prep.json", "doctors.json", "eval/vignettes.json")
(ROOT / "frontend" / "data" / "eval").mkdir(parents=True, exist_ok=True)
for rel in FILES:
    shutil.copy2(ROOT / "data" / rel, ROOT / "frontend" / "data" / rel)
    print("synced", rel)
