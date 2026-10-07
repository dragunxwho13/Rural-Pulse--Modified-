"""
Runtime settings: paste a Gemini API key and map service URLs from the website
(⚙ Settings) instead of editing .env and restarting.

Safety: changing settings is only allowed from the computer running the server
(localhost) unless RP_ALLOW_REMOTE_SETTINGS=1. The key is never sent back to the
browser (only a masked version). "Save" writes it to .env so it survives a restart.
"""
import concurrent.futures as cf
import os
import re
from typing import Dict

from . import config, gemini_models, llm

_POOL = cf.ThreadPoolExecutor(max_workers=1)


def mask(key: str) -> str:
    return (key[:4] + "…" + key[-4:]) if len(key) > 10 else ("set" if key else "")


def public() -> Dict:
    return {"gemini_key_set": bool(config.GOOGLE_API_KEY), "gemini_key_masked": mask(config.GOOGLE_API_KEY),
            "ai_enabled": llm.available(), "llm_model": config.LLM_MODEL, "live_model": config.LIVE_MODEL, "tts_model": config.TTS_MODEL,
            "overpass_url": config.OVERPASS_URL, "nominatim_url": config.NOMINATIM_URL, "osrm_url": config.OSRM_URL,
            "tile_url": config.TILE_URL, "tile_attribution": config.TILE_ATTRIBUTION,
            "can_edit_remotely": os.getenv("RP_ALLOW_REMOTE_SETTINGS", "0") == "1"}


def allowed(client_host: str) -> bool:
    return client_host in ("127.0.0.1", "::1", "localhost", "testclient") or os.getenv("RP_ALLOW_REMOTE_SETTINGS", "0") == "1"


def _test_key(key: str) -> str:
    """List the models this key can use, pick the best ones, and make one tiny test call."""
    from google import genai
    c = genai.Client(api_key=key)
    gemini_models.discover(c, force=True)
    r = gemini_models.call("text", c, lambda m: c.models.generate_content(model=m, contents="Reply with the single word: ok"))
    return (r.text or "").strip()[:20]


def _friendly(e: Exception) -> str:
    s = str(e)
    if "API_KEY_INVALID" in s or "API key not valid" in s:
        return "That API key is not valid. Copy it again from aistudio.google.com/apikey."
    if "PERMISSION_DENIED" in s or getattr(e, "code", None) == 403:
        return "This key is not allowed to use the Gemini API. Enable the Generative Language API for its project, or create a new key in AI Studio."
    if gemini_models.is_missing_model(e):
        return "None of the Gemini models tried are available to this key. Set RP_LLM_MODEL in .env to a model listed in AI Studio."
    if "FAILED_PRECONDITION" in s and "location" in s.lower():
        return "Gemini is not available from this server's region."
    return f"Could not reach Gemini: {type(e).__name__}: {s[:140]}"


def set_gemini_key(key: str) -> Dict:
    key = (key or "").strip()
    if not key:
        config.GOOGLE_API_KEY, config.USE_LLM = "", False
        llm._client = None
        gemini_models.reset()
        return {"ok": True, "message": "AI turned off. Rules-only mode."}
    old_key, old_use = config.GOOGLE_API_KEY, config.USE_LLM
    config.GOOGLE_API_KEY = key          # discovery is cached per key
    note = ""
    try:
        reply = _POOL.submit(_test_key, key).result(timeout=40)
    except cf.TimeoutError:
        config.GOOGLE_API_KEY, config.USE_LLM = old_key, old_use
        return {"ok": False, "message": "Google did not answer in 40 s. Check the internet connection."}
    except Exception as e:
        if "RESOURCE_EXHAUSTED" in str(e) or getattr(e, "code", None) == 429:
            reply, note = "", " (the key works, but its free quota is used up for now; AI features resume when it resets)"
        else:
            config.GOOGLE_API_KEY, config.USE_LLM = old_key, old_use
            gemini_models.reset()
            return {"ok": False, "message": _friendly(e)}
    config.USE_LLM = True
    llm._client = None
    m = gemini_models.summary()
    return {"ok": True, "message": f"Gemini connected{note}. Using {m['text']} for understanding and translation, "
                                   f"{m['live']} for live voice and {m['tts']} for speech. AI voice in any language is on."}


def set_map_urls(d: Dict) -> None:
    for field, attr in (("overpass_url", "OVERPASS_URL"), ("nominatim_url", "NOMINATIM_URL"), ("osrm_url", "OSRM_URL"),
                        ("tile_url", "TILE_URL"), ("tile_attribution", "TILE_ATTRIBUTION")):
        v = (d.get(field) or "").strip()
        if v and (field == "tile_attribution" or v.startswith("https://") or v.startswith("http://")):
            setattr(config, attr, v.rstrip("/") if field != "tile_url" else v)


def save_env(values: Dict[str, str]) -> bool:
    path = config.ROOT / ".env"
    try:
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        for k, v in values.items():
            line = f"{k}={v}"
            if re.search(rf"^{k}=.*$", text, flags=re.M):
                text = re.sub(rf"^{k}=.*$", line.replace("\\", "\\\\"), text, flags=re.M)
            else:
                text += ("" if text.endswith("\n") or not text else "\n") + line + "\n"
        path.write_text(text, encoding="utf-8")
        return True
    except OSError:
        return False
