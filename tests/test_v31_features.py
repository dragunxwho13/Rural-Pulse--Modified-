"""v3.1: runtime settings, demo data so dashboards are never empty, live simulation, any-language voice endpoints."""
from fastapi.testclient import TestClient

from backend.app import cases, config
from backend.app.main import app

client = TestClient(app)


def _token(role="doctor", facility="PHC-001", phone="9876511111", name="Sundarpur Primary Health Centre"):
    otp = client.post("/api/auth/otp", json={"phone": phone}).json()["demo_otp"]
    return client.post("/api/auth/verify", json={"phone": phone, "code": otp, "role": role, "name": "Dr Test",
                                                 "facility_key": facility, "facility_name": name}).json()["token"]


def test_settings_public_never_leaks_key():
    old = config.GOOGLE_API_KEY
    config.GOOGLE_API_KEY = "AIzaSyTESTKEY1234567890"
    try:
        s = client.get("/api/settings").json()
        assert s["gemini_key_set"] and "TESTKEY" not in str(s) and s["gemini_key_masked"].startswith("AIza")
    finally:
        config.GOOGLE_API_KEY = old


def test_settings_change_map_urls_and_reject_bad_url():
    old = (config.OVERPASS_URL, config.TILE_URL)
    try:
        r = client.post("/api/settings", json={"overpass_url": "https://overpass.example/api/interpreter",
                                               "tile_url": "https://{s}.tiles.example/{z}/{x}/{y}.png"})
        assert r.status_code == 200
        assert config.OVERPASS_URL == "https://overpass.example/api/interpreter"
        assert client.get("/api/meta").json()["tile_url"].startswith("https://{s}.tiles.example")
        client.post("/api/settings", json={"osrm_url": "javascript:alert(1)"})
        assert not config.OSRM_URL.startswith("javascript")
    finally:
        config.OVERPASS_URL, config.TILE_URL = old


def test_demo_reset_seeds_reports_for_dashboards():
    tok = _token()
    h = {"Authorization": "Bearer " + tok}
    assert client.post("/api/demo/reset", headers=h).json()["seeded"] == len(cases.DEMO_CASES)
    own = client.get("/api/cases?facility=PHC-001", headers=h).json()["cases"]
    assert len(own) >= 3 and all(c.get("demo") for c in own)
    rx = client.get("/api/rx?pharmacy=all", headers=h).json()["rx"]
    assert {r["id"] for r in rx} >= {"RX-DEMO1", "RX-DEMO2", "RX-DEMO3"}
    assert client.get("/api/rx/RX-DEMO1").status_code == 200   # patient view of a sample card


def test_simulate_patient_and_prescription():
    h = {"Authorization": "Bearer " + _token()}
    c = client.post("/api/demo/simulate", headers=h).json()["case"]
    assert c["facility_key"] == "PHC-001" and c["prep"]
    hp = {"Authorization": "Bearer " + _token("pharmacy", "PHARM-02", "9876522222", "Sundarpur PHC Dispensary (demo)")}
    rx = client.post("/api/demo/simulate", headers=hp).json()["rx"]
    assert rx["pharmacy_key"] == "PHARM-02" and rx["items"]


def test_demo_endpoints_need_staff_login():
    assert client.post("/api/demo/simulate").status_code in (401, 403)
    assert client.post("/api/demo/reset").status_code in (401, 403)


def test_voice_endpoints_explain_missing_key():
    old = config.GOOGLE_API_KEY, config.USE_LLM
    config.GOOGLE_API_KEY, config.USE_LLM = "", False
    try:
        for path, body in [("/api/voice/turn", {"audio_b64": "AAAA", "mime": "audio/wav"}),
                           ("/api/voice/turn_text", {"text": "mujhe bukhar hai"}),
                           ("/api/voice/tts", {"text": "नमस्ते"})]:
            r = client.post(path, json=body).json()
            assert r["ok"] is False and "Gemini" in r["error"], path
    finally:
        config.GOOGLE_API_KEY, config.USE_LLM = old
