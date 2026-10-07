"""
Privacy-preserving audit trail.

Each assessment gets an id and a de-identified record: protocol version,
rules fired, data records used and their verification dates, and a salted
hash of the input. Raw text is stored only if the user ticked consent.
"""
import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict

from . import config

_lock = threading.Lock()


def new_id() -> str:
    return "RP-" + uuid.uuid4().hex[:10].upper()


def input_hash(text: str) -> str:
    return hashlib.sha256((config.AUDIT_SALT + "|" + text).encode("utf-8")).hexdigest()[:16]


def record(entry: Dict, raw_text: str, consent: bool) -> Dict:
    entry = dict(entry)
    entry["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry["input_sha256_16"] = input_hash(raw_text)
    entry["raw_text_stored"] = bool(consent)
    stored = False
    if config.AUDIT_LOG:
        try:
            config.LOG_DIR.mkdir(parents=True, exist_ok=True)
            line = dict(entry)
            if consent:
                line["raw_text"] = raw_text
            with _lock, open(config.LOG_DIR / "audit.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
            stored = True
        except OSError:
            stored = False
    entry["logged"] = stored
    return entry
