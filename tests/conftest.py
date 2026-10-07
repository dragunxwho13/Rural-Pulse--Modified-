import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("RP_USE_LLM", "0")       # tests are deterministic and offline
os.environ.setdefault("RP_LOG_DIR", str(ROOT / ".pytest_logs"))
os.environ.setdefault("RP_DB_PATH", str(ROOT / ".pytest_logs" / "test.db"))
