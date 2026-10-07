"""
FastAPI app: JSON API under /api, the website at /, shared data at /data.

Run locally:  uvicorn backend.app.main:app --reload --port 8000
"""
import asyncio
import json
import logging
from typing import Dict, Optional

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, cases, config, geo, live, llm, settings, translate, voiceturn
from .evaluation import run_suite
from .navigation import freshness, open_status
from .pipeline import _now, assess, interpret
from .protocol import doctors_doc, facilities, facilities_doc, protocol
from .schemas import (AssessRequest, CasePatch, CaseRequest, InterpretRequest, OtpRequest, OtpVerify, RxPatch, RxRequest,
                      SettingsRequest, TranslateRequest, VoiceTurnRequest, TTSRequest, VoiceTextRequest)

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="RuralPulse API", version=__version__,
              description="Safety-first rural care navigation: red-flag rules, abstention, verified facilities, "
                          "OSM maps, doctor notifications and multilingual medicine cards.")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=800)


def _user(authorization: Optional[str]) -> Optional[Dict]:
    if authorization and authorization.lower().startswith("bearer "):
        return cases.verify_token(authorization[7:])
    return None


def _require(authorization: Optional[str], roles=("doctor", "pharmacy", "asha")) -> Dict:
    u = _user(authorization)
    if not u or u["role"] not in roles:
        raise HTTPException(401, "Log in with your phone number first")
    return u


@app.on_event("startup")
def _seed():
    if config.USE_LLM:   # pick the Gemini models this key can use, without delaying startup
        import threading
        from . import gemini_models
        threading.Thread(target=lambda: gemini_models.discover(llm._get_client()), daemon=True).start()
    if config.SEED_DEMO:
        try:
            cases.seed_demo()
        except Exception as e:  # never block startup on demo data
            logging.warning("demo seed failed: %s", e)


@app.get("/api/settings")
def get_settings(request: Request):
    return {**settings.public(), "can_edit": settings.allowed(request.client.host if request.client else "")}


@app.post("/api/settings")
def post_settings(req: SettingsRequest, request: Request):
    if not settings.allowed(request.client.host if request.client else ""):
        raise HTTPException(403, "Settings can only be changed on the computer running RuralPulse (open http://localhost:8000 there).")
    out = {"ok": True, "messages": []}
    if req.gemini_key is not None:
        r = settings.set_gemini_key(req.gemini_key)
        out["ok"] = r["ok"]; out["messages"].append(r["message"])
    settings.set_map_urls(req.model_dump())
    out["messages"].append("Map settings applied.")
    if req.save and out["ok"]:
        vals = {k: v for k, v in {"GOOGLE_API_KEY": config.GOOGLE_API_KEY if req.gemini_key is not None else None,
                                  "RP_OVERPASS_URL": config.OVERPASS_URL, "RP_NOMINATIM_URL": config.NOMINATIM_URL,
                                  "RP_OSRM_URL": config.OSRM_URL, "RP_TILE_URL": config.TILE_URL,
                                  "RP_TILE_ATTRIBUTION": config.TILE_ATTRIBUTION}.items() if v is not None}
        out["messages"].append("Saved to .env." if settings.save_env(vals) else "Could not write .env (settings apply until restart).")
    return {**out, "settings": settings.public()}


@app.post("/api/voice/turn")
def voice_turn(req: VoiceTurnRequest):
    return voiceturn.turn(req.audio_b64, req.mime, req.history, req.ui_lang)


@app.post("/api/voice/turn_text")
def voice_turn_text(req: VoiceTextRequest):
    return voiceturn.turn("", "", req.history, req.ui_lang, typed=req.text)


@app.post("/api/voice/tts")
def voice_tts(req: TTSRequest):
    return voiceturn.tts(req.text)


@app.post("/api/demo/simulate")
async def demo_simulate(authorization: Optional[str] = Header(None)):
    u = _require(authorization, ("doctor", "pharmacy"))
    own = u.get("facility_key") not in ("", "all", None)
    if u.get("role") == "pharmacy":
        return {"rx": await cases.simulate_rx(u["facility_key"] if own else "PHARM-01", u.get("facility_name") if own else "")}
    key = u["facility_key"] if own else "PHC-001"
    name = u.get("facility_name") if own else "Sundarpur Primary Health Centre"
    return {"case": await cases.simulate(key, name)}


@app.post("/api/demo/reset")
def demo_reset(authorization: Optional[str] = Header(None)):
    _require(authorization, ("doctor", "pharmacy"))
    with cases._lock:
        for t in ("cases", "rx", "outbox"):
            cases.db().execute(f"DELETE FROM {t}")
        cases.db().commit()
    return {"seeded": cases.seed_demo(force=True)}


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/api/meta")
def meta():
    P = protocol()
    return {"version": __version__, "protocol_version": P["version"], "protocol_status": P["status"],
            "llm_enabled": llm.available(), "voice_ai": config.VOICE_AI and llm.available(), "voice_langs": config.VOICE_LANGS, "llm_model": config.LLM_MODEL if llm.available() else None,
            "live_voice": llm.available(), "retrieval": "gemini-embedding" if config.USE_EMBEDDINGS else "tfidf",
            "sms": config.SMS_PROVIDER or "outbox (demo)", "demo_otp": config.DEMO_OTP,
            "tile_url": config.TILE_URL, "tile_attribution": config.TILE_ATTRIBUTION,
            "supported_languages": P["supported_languages"], "emergency_numbers": P["emergency_numbers"],
            "dataset": facilities_doc()["dataset"]}


@app.get("/api/protocol")
def get_protocol():
    P = protocol()
    return {"version": P["version"], "status": P["status"], "red_flags": P["red_flags"] + P["numeric_red_flags"],
            "rules": P["rules"], "levels": P["levels"] + ["CANNOT_DETERMINE"]}


@app.get("/api/facilities")
def get_facilities(at_time: str = None):
    at = _now(at_time)
    out = [{**f, "freshness": freshness(f, at.date()), "open": open_status(f, at)} for f in facilities()]
    return {"dataset": facilities_doc()["dataset"], "note": facilities_doc()["note"], "facilities": out}


@app.get("/api/doctors")
def get_doctors():
    return doctors_doc()


@app.post("/api/interpret")
def api_interpret(req: InterpretRequest):
    return interpret(req)


@app.post("/api/assess")
def api_assess(req: AssessRequest):
    return assess(req)


@app.get("/api/eval")
def api_eval():
    try:
        return run_suite()
    except FileNotFoundError:
        raise HTTPException(404, "Evaluation suite not found")


@app.post("/api/translate")
def api_translate(req: TranslateRequest):
    return translate.translate(req.texts, req.lang)


# ------------------------------------------------------------------ maps (OpenStreetMap proxy)
@app.get("/api/osm/nearby")
async def osm_nearby(lat: float, lon: float, radius: int = 15000, dental: bool = False):
    try:
        return await geo.nearby(lat, lon, radius, dental)
    except Exception as e:
        raise HTTPException(502, f"OpenStreetMap is not reachable right now ({type(e).__name__})")


@app.get("/api/osm/geocode")
async def osm_geocode(q: str):
    try:
        return await geo.geocode(q)
    except Exception as e:
        raise HTTPException(502, f"Place search is not reachable right now ({type(e).__name__})")


@app.get("/api/osm/reverse")
async def osm_reverse(lat: float, lon: float):
    try:
        return await geo.reverse(lat, lon)
    except Exception as e:
        raise HTTPException(502, f"Place lookup failed ({type(e).__name__})")


@app.get("/api/osm/route")
async def osm_route(from_lat: float, from_lon: float, to_lat: float, to_lon: float):
    try:
        return await geo.route(from_lat, from_lon, to_lat, to_lon)
    except Exception as e:
        raise HTTPException(502, f"Routing is not reachable right now ({type(e).__name__})")


# ------------------------------------------------------------------ login (phone + OTP)
@app.post("/api/auth/otp")
async def auth_otp(req: OtpRequest):
    return await cases.request_otp(req.phone)


@app.post("/api/auth/verify")
def auth_verify(req: OtpVerify):
    r = cases.verify_otp(req.phone, req.code, req.role, req.name, req.facility_key, req.facility_name)
    if not r["ok"]:
        raise HTTPException(400, r["error"])
    return r


@app.get("/api/auth/me")
def auth_me(authorization: Optional[str] = Header(None)):
    return {"user": _user(authorization)}


# ------------------------------------------------------------------ cases, notifications, prescriptions
@app.post("/api/cases")
async def create_case(req: CaseRequest, authorization: Optional[str] = Header(None)):
    return await cases.create_case(req.model_dump(), _user(authorization))


@app.get("/api/cases")
def list_cases(facility: str = "all", authorization: Optional[str] = Header(None)):
    _require(authorization, ("doctor", "pharmacy"))
    return {"cases": cases.list_cases(facility)}


@app.get("/api/cases/{cid}")
def get_case(cid: str):
    c = cases.get_case(cid)
    if not c:
        raise HTTPException(404, "No such case")
    return {"id": c["id"], "status": c["status"], "facility_name": c["facility_name"], "level": c["level"]}


@app.patch("/api/cases/{cid}")
async def patch_case(cid: str, req: CasePatch, authorization: Optional[str] = Header(None)):
    u = _require(authorization, ("doctor",))
    c = await cases.update_case(cid, req.status, u)
    if not c:
        raise HTTPException(404, "No such case or status")
    return c


@app.post("/api/rx")
async def create_rx(req: RxRequest, authorization: Optional[str] = Header(None)):
    u = _require(authorization, ("doctor",))
    return await cases.create_rx(req.model_dump(), u)


@app.get("/api/rx")
def list_rx(pharmacy: str = "all", authorization: Optional[str] = Header(None)):
    _require(authorization, ("doctor", "pharmacy"))
    return {"rx": cases.list_rx(pharmacy)}


@app.get("/api/rx/{rid}")
def get_rx(rid: str, lang: str = ""):
    rx = cases.get_rx(rid)
    if not rx:
        raise HTTPException(404, "No such medicine card")
    target = lang or rx["lang"]
    if target != "en" and target not in rx.get("translations", {}) and llm.available():
        texts = [rx["notes"]] + [i["note"] for i in rx["items"]]
        tr = translate.translate(texts, target)
        if tr["engine"] == "gemini":
            cases.save_rx_translation(rid, target, {"notes": tr["texts"][0], "item_notes": tr["texts"][1:]})
            rx = cases.get_rx(rid)
    rx.pop("patient_phone", None)
    return rx


@app.patch("/api/rx/{rid}")
async def patch_rx(rid: str, req: RxPatch, authorization: Optional[str] = Header(None)):
    _require(authorization, ("doctor", "pharmacy"))
    rx = await cases.update_rx(rid, req.status)
    if not rx:
        raise HTTPException(404, "No such medicine card or status")
    return rx


@app.get("/api/outbox")
def get_outbox(authorization: Optional[str] = Header(None)):
    _require(authorization, ("doctor", "pharmacy"))
    return {"messages": cases.outbox()}


@app.get("/api/events")
async def events(request: Request, facility: str = "all", token: str = ""):
    """Server-sent events for dashboards (EventSource cannot send headers, so the token is a query parameter)."""
    keys = [facility]
    u = cases.verify_token(token) if token else None
    if not u:
        keys = [k for k in [facility] if k.startswith("case:") or k.startswith("rx:")]
        if not keys:
            raise HTTPException(401, "Log in first")
    queues = [(k, cases.hub.subscribe(k)) for k in keys]
    if u and u["role"] == "pharmacy":
        queues.append(("pharmacy", cases.hub.subscribe("pharmacy")))
    if u:
        queues.append(("outbox", cases.hub.subscribe("outbox")))

    async def stream():
        try:
            idle = 0
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                got = False
                for _, q in queues:
                    try:
                        ev = q.get_nowait()
                        got = True
                        if not u:   # public patient-side streams only ever see the status, never case details
                            if ev.get("case"):
                                ev = {"type": ev["type"], "case": {k: ev["case"].get(k) for k in ("id", "status", "facility_name")}}
                            elif ev.get("rx"):
                                ev = {"type": ev["type"], "rx": {k: ev["rx"].get(k) for k in ("id", "status")}}
                            else:
                                continue
                        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    except asyncio.QueueEmpty:
                        pass
                if not got:
                    idle += 1
                    await asyncio.sleep(0.4)
                    if idle % 40 == 0:
                        yield ": keep-alive\n\n"
                else:
                    idle = 0
        finally:
            for k, q in queues:
                cases.hub.unsubscribe(k, q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.websocket("/api/live")
async def live_ws(ws: WebSocket):
    await live.handle(ws)


# Shared data (protocol + facilities) for the offline browser engine.
app.mount("/data", StaticFiles(directory=config.DATA_DIR), name="data")
if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="site")
