"""
Pick Gemini models that actually exist for THIS key, instead of hard-coding names.

Google retires model names often (for example "gemini-2.5-flash ... is no longer
available to new users"). So when a key is added, and again whenever a call
returns 404 NOT_FOUND, RuralPulse lists the models the key can use and picks
the best one for each job:
  text : newest stable Flash model that supports generateContent ("gemini-flash-latest" alias first)
  live : newest model that supports bidiGenerateContent (Live API, native audio)
  tts  : newest Flash text-to-speech model
  embed: newest embedding model
A name set in .env (RP_LLM_MODEL, RP_LIVE_MODEL, RP_TTS_MODEL, RP_EMBED_MODEL) is
tried first if the key can use it.
"""
import logging
import re
import threading
import time
from typing import Callable, Dict, List, Optional

from . import config

log = logging.getLogger("ruralpulse.models")
_lock = threading.Lock()

# Used only when listing models is impossible. Newest first.
FALLBACK = {
    "text": ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
             "gemini-3-flash-preview", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"],
    "live": ["gemini-3.8-live", "gemini-live-latest", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025",
             "gemini-2.5-flash-native-audio-preview-09-2025", "gemini-live-2.5-flash-preview"],
    "tts": ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"],
    "embed": ["gemini-embedding-001", "text-embedding-004"],
}
_ENV = {"text": "LLM_MODEL", "live": "LIVE_MODEL", "tts": "TTS_MODEL", "embed": "EMBED_MODEL"}
_state: Dict = {"key": None, "ranked": {}, "bad": set(), "listed_at": 0.0, "count": 0}


def _version(name: str) -> float:
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
    return float(m.group(1)) if m else 0.0


def _score(name: str, kind: str) -> tuple:
    n = name.lower()
    latest = "latest" in n
    stable = not any(w in n for w in ("preview", "exp", "experimental"))
    lite = "lite" in n
    extra = any(w in n for w in ("thinking", "extended", "computer", "robotics", "customtools"))
    dated = bool(re.search(r"-\d{2}-\d{4}$|-\d{3}$", n))
    if kind == "text":
        return (latest and not lite, stable, not lite, not extra, _version(n), not dated)
    if kind == "live":
        return ("native-audio" in n or "live" in n, stable, not extra, _version(n), latest, not dated)
    if kind == "tts":
        return (stable, not lite, _version(n), not dated)
    return (stable, "gemini" in n, _version(n))


def classify(models: List[Dict]) -> Dict[str, List[str]]:
    """models: [{"name": "gemini-x", "actions": [...]}] -> ranked names per job."""
    out = {"text": [], "live": [], "tts": [], "embed": []}
    for m in models:
        n, acts = m["name"].lower(), set(m.get("actions") or [])
        if "tts" in n:
            if not acts or "generateContent" in acts:
                out["tts"].append(m["name"])
            continue
        if "embedContent" in acts or "embedding" in n:
            out["embed"].append(m["name"])
            continue
        if "bidiGenerateContent" in acts or (not acts and ("live" in n or "native-audio" in n)):
            out["live"].append(m["name"])
        if ("generateContent" in acts or not acts) and "flash" in n and not any(
                w in n for w in ("live", "native-audio", "image", "audio", "video", "veo", "imagen", "lyria", "aqa", "gemma", "nano")):
            out["text"].append(m["name"])
    for k in out:
        out[k].sort(key=lambda x: _score(x, k), reverse=True)
    return out


def _list(client) -> List[Dict]:
    res = []
    for m in client.models.list():
        name = (m.name or "").split("/")[-1]
        if name.startswith("gemini") or name.startswith("text-embedding"):
            res.append({"name": name, "actions": list(m.supported_actions or [])})
    return res


def discover(client, force: bool = False) -> Dict[str, List[str]]:
    """List the key's models (cached 30 min) and rank them per job."""
    with _lock:
        fresh = _state["key"] == config.GOOGLE_API_KEY and time.time() - _state["listed_at"] < 1800
        if fresh and not force and _state["ranked"]:
            return _state["ranked"]
    try:
        listed = _list(client)
        ranked = classify(listed)
        log.info("Gemini models for this key: %s", {k: v[:3] for k, v in ranked.items()})
    except Exception as e:   # listing failed: keep going with the built-in list
        log.warning("Could not list Gemini models (%s); using built-in names", e)
        listed, ranked = [], {k: list(v) for k, v in FALLBACK.items()}
    with _lock:
        if _state["key"] != config.GOOGLE_API_KEY:
            _state["bad"] = set()
        _state.update(key=config.GOOGLE_API_KEY, ranked=ranked, listed_at=time.time(), count=len(listed))
    _apply()
    return ranked


def candidates(kind: str) -> List[str]:
    """Models to try for a job, best first: the .env choice (if usable), then the ranked list, then fallbacks."""
    ranked = _state["ranked"].get(kind) or []
    known = set(ranked)
    pref = getattr(config, "_ENV_" + _ENV[kind], None)
    out = []
    if pref and (not known or pref in known):
        out.append(pref)
    out += ranked
    if not ranked:
        out += FALLBACK[kind]
    seen, res = set(), []
    for m in out:
        if m not in seen and m not in _state["bad"]:
            seen.add(m); res.append(m)
    return res


def _apply():
    for kind, attr in _ENV.items():
        c = candidates(kind)
        if c:
            setattr(config, attr, c[0])


def is_missing_model(e: Exception) -> bool:
    s = str(e)
    return getattr(e, "code", None) == 404 or "NOT_FOUND" in s or "no longer available" in s or "is not found" in s \
        or "not supported for" in s


def mark_bad(model: str):
    with _lock:
        _state["bad"].add(model)
    _apply()


def call(kind: str, client, fn: Callable[[str], object], tries: int = 4):
    """Run fn(model_name) with the best model; on 'model not found' move to the next one."""
    if not _state["ranked"] or _state["key"] != config.GOOGLE_API_KEY:
        discover(client)
    last = None
    for model in candidates(kind)[:tries]:
        try:
            out = fn(model)
            if getattr(config, _ENV[kind]) != model:
                setattr(config, _ENV[kind], model)
            return out
        except Exception as e:
            if not is_missing_model(e):
                raise
            log.warning("Model %s unavailable for this key (%s); trying the next one", model, str(e)[:120])
            mark_bad(model)
            last = e
    raise last or RuntimeError("No usable Gemini model for " + kind)


def summary() -> Dict:
    return {"listed": _state["count"], "text": config.LLM_MODEL, "live": config.LIVE_MODEL, "tts": config.TTS_MODEL,
            "embed": config.EMBED_MODEL, "alternatives": {k: v[:4] for k, v in _state["ranked"].items()}}


def reset():
    with _lock:
        _state.update(key=None, ranked={}, bad=set(), listed_at=0.0, count=0)
