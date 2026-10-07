"""
Turn-based voice in ANY language (Gemini). The browser records a short clip,
Gemini listens (it detects the language itself, including code-mixed speech
like Hinglish or Tanglish), and replies as a caring helper in the SAME
language. The browser speaks the reply. Works even when the Live API model is
not available on the key, and the safety rules check every transcript.
"""
import base64
import concurrent.futures as cf
import json
from typing import Dict, List

from pydantic import BaseModel, Field

from . import config, llm
from .protocol import match_concepts, msg, protocol
from .triage import red_flags

_POOL = cf.ThreadPoolExecutor(max_workers=4)

SYSTEM = """You are RuralPulse, a warm, calm, caring health helper for rural India. You will receive the person's voice.
1. Work out which language they are speaking (any Indian language or English, including mixed speech like Hinglish).
2. Reply in EXACTLY that same language and script, in simple everyday words, short sentences, kind and human, under 45 words.
3. Help them decide where to go and how soon. Ask one question at a time: who is unwell, age, what they feel, since when.
   Ask about danger signs (chest pain, breathing trouble, fainting, fits, heavy bleeding, snake bite, poisoning).
   If any danger sign: calmly tell them to call 108 now and give only simple first aid. Self-harm thoughts: Tele-MANAS 14416.
4. Never diagnose. Never name or recommend a medicine or dose; the doctor decides medicines.
Return JSON only."""


class Turn(BaseModel):
    language_code: str = Field(description="BCP-47 code of the language the person spoke, e.g. hi-IN, ta-IN, bn-IN, en-IN")
    language_name: str = Field(description="Name of that language in English")
    transcript: str = Field(description="What the person said, in their own language and script")
    english_gist: str = Field(description="One-line English meaning of what they said")
    reply: str = Field(description="Your spoken reply, in the person's language")


def _call(audio_b64: str, mime: str, history: List[Dict], ui_lang: str, typed: str = "") -> Turn:
    from google.genai import types
    hist = "\n".join(f"{h.get('role', 'user')}: {h.get('text', '')}" for h in history[-8:])
    hint = protocol()["supported_languages"].get(ui_lang, {}).get("name", "English")
    ctx = types.Part(text=f"Conversation so far:\n{hist or '(start)'}\n\nThe app screen is set to {hint}, but reply in whatever language the person actually used.")
    first = (types.Part(text=f"The person typed: {typed}") if typed
             else types.Part.from_bytes(data=base64.b64decode(audio_b64), mime_type=mime or "audio/wav"))
    parts = [first, ctx]
    resp = llm.generate(
        "text", contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(system_instruction=SYSTEM, temperature=0.4, response_mime_type="application/json", response_schema=Turn))
    return resp.parsed if isinstance(resp.parsed, Turn) else Turn.model_validate_json(resp.text)


def turn(audio_b64: str, mime: str, history: List[Dict], ui_lang: str, typed: str = "") -> Dict:
    if not llm.available():
        return {"ok": False, "error": "Add a Gemini API key in Settings to use any-language voice."}
    if len(audio_b64) > 8_000_000:
        return {"ok": False, "error": "Clip too long. Speak for under 60 seconds."}
    try:
        t = _POOL.submit(_call, audio_b64, mime, history, ui_lang, typed).result(timeout=config.LLM_TIMEOUT_S * 3)
    except Exception as e:
        return {"ok": False, "error": f"Voice service failed: {type(e).__name__}"}
    out = t.model_dump()
    text = " ".join(h.get("text", "") for h in history if h.get("role") == "user") + " " + t.transcript + " " + t.english_gist
    concepts = set(match_concepts(text).keys())
    flags = red_flags(concepts, None, {}, {}, {c: "rules" for c in concepts})
    if flags:
        code = t.language_code.split("-")[0]
        lang = code if code in protocol()["supported_languages"] else "en"
        key = "MENTAL_HEALTH_CRISIS" if all(f["action"] == "MENTAL_HEALTH_CRISIS" for f in flags) else "EMERGENCY"
        out["red_flag"] = {"flags": [f["id"] for f in flags], "key": key, "title": msg(f"levels.{key}.title", lang),
                           "action": msg(f"levels.{key}.action", lang), "number": "14416" if key == "MENTAL_HEALTH_CRISIS" else "108"}
    return {"ok": True, **out}


def _tts(text: str) -> bytes:
    from google.genai import types
    resp = llm.generate(
        "tts", contents=f"Say this warmly and gently, like a caring nurse: {text}",
        config=types.GenerateContentConfig(response_modalities=["AUDIO"], speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=config.LIVE_VOICE)))))
    for part in resp.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data
    raise ValueError("no audio")


def tts(text: str) -> Dict:
    """Natural voice for languages the phone has no voice for. Returns 24 kHz mono PCM16, base64."""
    text = (text or "").strip()[:600]
    if not text:
        return {"ok": False, "error": "Nothing to say."}
    if not llm.available():
        return {"ok": False, "error": "Add a Gemini API key in Settings for a natural voice."}
    try:
        pcm = _POOL.submit(_tts, text).result(timeout=config.LLM_TIMEOUT_S * 3)
    except Exception as e:
        return {"ok": False, "error": f"Voice service failed: {type(e).__name__}"}
    return {"ok": True, "pcm_b64": base64.b64encode(pcm).decode(), "rate": 24000}
