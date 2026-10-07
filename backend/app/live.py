"""
Live voice assistant: a WebSocket bridge between the browser microphone and
the Gemini Live API (native-audio model, natural expressive voice, speaks
Indian languages).

Browser -> server : binary frames of 16 kHz mono PCM16; JSON {"type":"text"} or {"type":"end"}
Server -> browser : binary frames of 24 kHz mono PCM16 (the assistant's voice);
                    JSON events: ready, user_text, ai_text, turn_complete, interrupted,
                    red_flag, error, unavailable

Safety: the API key never reaches the browser. Everything the user says is
transcribed and run through the same deterministic red-flag rules as the
text check; a danger sign immediately puts the 108 (or 14416) banner on
screen, whatever the model is saying. The model is instructed never to
diagnose or give medicines or doses.
"""
import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

from . import config, llm
from .protocol import match_concepts, msg, protocol
from .triage import red_flags

log = logging.getLogger("ruralpulse.live")

SYSTEM = """You are RuralPulse, a warm, calm and caring health helper for people in rural India.
Always reply in the SAME language the person is speaking, whatever it is: any Indian language, English, or mixed speech
like Hinglish. If they switch language, switch with them. Start in {lang_name} ({native}), the language chosen in the app.
Use simple everyday words with natural pronunciation for that language, a gentle and human tone, and short sentences. Show empathy ("that sounds
hard, I am here with you"). Ask one short question at a time.

Your job is to understand the problem and guide the person to the right care, never to diagnose:
1. Find out who is unwell, their age, what they feel, since when, and how bad it is.
2. Ask early whether there is chest pain, trouble breathing, fainting, fits, heavy bleeding, confusion, snake bite or poisoning.
3. If any danger sign is present, say calmly and clearly: call 108 for an ambulance now, do not travel alone. Then give
   only simple first-aid steps (keep calm, lie on the side if unconscious and breathing, press on bleeding). If someone
   talks about ending their life, stay kind, encourage them to call Tele-MANAS 14416 now, or 112 if in danger.
4. Otherwise say how soon to see a doctor (today, or in 2-3 days, or rest at home and watch), and suggest the nearest
   government health centre, the ASHA worker, or the 104 helpline. Mention free care under Ayushman Bharat (14555).
5. Give practical comfort advice only: rest, water, ORS for loose motions, light clothes for fever.

Never name a disease as a diagnosis. Never name or recommend a medicine or a dose; say the doctor decides medicines.
If you are unsure, say so and suggest the ASHA worker or 104. Keep every answer under about 40 words.
At the end, remind them they can tap "Check" in the app to get a visit slip and the nearest centre on the map."""


def _cfg(lang: str, affective: bool):
    from google.genai import types
    info = protocol()["supported_languages"].get(lang) or protocol()["supported_languages"]["hi"]
    kw = dict(
        response_modalities=["AUDIO"],
        system_instruction=SYSTEM.format(lang_name=info["name"], native=info["native"]),
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=config.LIVE_VOICE))),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )
    if affective:
        kw["enable_affective_dialog"] = True
    return types.LiveConnectConfig(**kw)


def _client(affective: bool):
    from google import genai
    if affective:
        return genai.Client(api_key=config.GOOGLE_API_KEY, http_options={"api_version": "v1alpha"})
    return genai.Client(api_key=config.GOOGLE_API_KEY)


async def handle(ws: WebSocket):
    await ws.accept()
    lang = ws.query_params.get("lang", "hi")
    if not llm.available():
        await ws.send_json({"type": "unavailable", "message": "Voice assistant needs GOOGLE_API_KEY on the server."})
        await ws.close()
        return
    from google.genai import types
    from . import gemini_models
    last_err = None
    try:   # make sure we know which Live models this key can use
        await asyncio.get_running_loop().run_in_executor(None, gemini_models.discover, llm._get_client())
    except Exception:
        pass
    for model in gemini_models.candidates("live")[:3]:
        for affective in (True, False):
            started = False
            try:
                async with _client(affective).aio.live.connect(model=model, config=_cfg(lang, affective)) as session:
                    started = True
                    config.LIVE_MODEL = model
                    await ws.send_json({"type": "ready", "model": model, "affective": affective})
                    await _bridge(ws, session, lang, types)
                    return
            except WebSocketDisconnect:
                return
            except Exception as e:  # retry without affective dialog, then the next model, then report
                last_err = e
                log.warning("Live connect failed (model=%s, affective=%s): %s", model, affective, e)
                if started:   # the session ran and then broke: report it, don't silently restart
                    return await _report(ws, e)
                if gemini_models.is_missing_model(e) or "1008" in str(e) or "not found" in str(e).lower():
                    gemini_models.mark_bad(model)
                    break
    await _report(ws, last_err)


async def _report(ws: WebSocket, err):
    try:
        await ws.send_json({"type": "error", "message": f"Live voice is not available on this key ({type(err).__name__}). Using turn-by-turn voice instead."})
        await ws.close()
    except Exception:
        pass


async def _bridge(ws: WebSocket, session, lang: str, types):
    heard = {"text": ""}
    fired = set()

    async def upstream():
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                return
            if m.get("bytes"):
                await session.send_realtime_input(audio=types.Blob(data=m["bytes"], mime_type="audio/pcm;rate=16000"))
            elif m.get("text"):
                j = json.loads(m["text"])
                if j.get("type") == "text" and j.get("text"):
                    await _check(j["text"])
                    try:   # newer Live models take text as realtime input
                        await session.send_realtime_input(text=j["text"])
                    except Exception:
                        await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=j["text"])]), turn_complete=True)
                elif j.get("type") == "end":
                    await session.send_realtime_input(audio_stream_end=True)

    async def _check(text: str):
        heard["text"] = (heard["text"] + " " + text)[-2000:]
        concepts = set(match_concepts(heard["text"]).keys())
        flags = [f for f in red_flags(concepts, None, {}, {}, {c: "rules" for c in concepts}) if f["id"] not in fired]
        if flags:
            fired.update(f["id"] for f in flags)
            key = "MENTAL_HEALTH_CRISIS" if all(f["action"] == "MENTAL_HEALTH_CRISIS" for f in flags) else "EMERGENCY"
            await ws.send_json({"type": "red_flag", "flags": [f["id"] for f in flags], "key": key,
                                "title": msg(f"levels.{key}.title", lang), "action": msg(f"levels.{key}.action", lang),
                                "number": "14416" if key == "MENTAL_HEALTH_CRISIS" else "108"})

    async def downstream():
        while True:
            async for r in session.receive():
                sc = r.server_content
                if sc is None:
                    continue
                if sc.interrupted:
                    await ws.send_json({"type": "interrupted"})
                if sc.model_turn and sc.model_turn.parts:
                    for part in sc.model_turn.parts:
                        if part.inline_data and part.inline_data.data:
                            await ws.send_bytes(part.inline_data.data)
                if sc.input_transcription and sc.input_transcription.text:
                    await ws.send_json({"type": "user_text", "text": sc.input_transcription.text})
                    await _check(sc.input_transcription.text)
                if sc.output_transcription and sc.output_transcription.text:
                    await ws.send_json({"type": "ai_text", "text": sc.output_transcription.text})
                if sc.turn_complete:
                    await ws.send_json({"type": "turn_complete"})

    tasks = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done:
        if t.exception() and not isinstance(t.exception(), WebSocketDisconnect):
            raise t.exception()
