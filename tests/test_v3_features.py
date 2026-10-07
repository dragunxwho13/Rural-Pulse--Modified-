"""v3 features: first aid, slip, clinician prep, doctor notifications, prescriptions, privacy, node-side tests."""
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.pipeline import assess, interpret
from backend.app.schemas import AssessRequest, InterpretRequest

ROOT = Path(__file__).resolve().parents[1]
T = "2026-10-07T11:00"
client = TestClient(app)


def run(message, **kw):
    base = dict(message=message, answers={"redflag_screen": "no", **kw.pop("answers", {})}, at_time=T, **kw)
    r = interpret(InterpretRequest(**base), use_llm=False)
    if r["stage"] == "confirm":
        r = assess(AssessRequest(**base, interpretation_id=r["interpretation_id"], confirmed=True), use_llm=False)
    return r


def test_first_aid_cards_never_mention_doses():
    for m in ["chest pain", "snake bite", "fever for 4 days, age 30", "dog bite, age 30, since today", "loose motions 2 days, age 3"]:
        for card in run(m)["first_aid"]:
            text = " ".join([card["title"], *card["do"], *card["dont"]]).lower()
            assert " mg" not in text and "tablet" not in text, m


def test_first_aid_in_patient_language():
    r = run("ఛాతీ నొప్పి")
    assert r["urgency"]["level"] == "EMERGENCY"
    assert r["first_aid"][0]["key"] == "RF-CHEST" and r["first_aid"][0]["lang"] == "te"


def test_slip_is_in_patient_language():
    r = run("ಹಾವು ಕಚ್ಚಿದೆ")
    slip = r["summary"]["slip"]
    assert slip["lang"] == "kn" and slip["labels"]["slip_title"] == "ಆರೋಗ್ಯ ಚೀಟಿ" and slip["emergency_number"] == "108"


def test_clinician_prep_for_snake_bite():
    assert any("ASV" in x for x in run("snake bite on leg")["clinician_prep"])


def _login(role="doctor", phone="9876500001", facility="PHC-001"):
    otp = client.post("/api/auth/otp", json={"phone": phone}).json()["demo_otp"]
    return client.post("/api/auth/verify", json={"phone": phone, "code": otp, "role": role, "name": "Dr Test", "facility_key": facility}).json()["token"]


def test_case_notification_and_prescription_flow():
    case = client.post("/api/cases", json={"level": "URGENT_SAME_DAY", "symptoms": ["fever"], "lang": "ta", "patient_phone": "9123456780",
                                           "facility": {"key": "PHC-001", "name": "Sundarpur PHC"}}).json()
    assert case["status"] == "new"
    assert client.get("/api/cases").status_code == 401, "case list needs a login"
    H = {"Authorization": "Bearer " + _login()}
    assert any(c["id"] == case["id"] for c in client.get("/api/cases?facility=PHC-001", headers=H).json()["cases"])
    assert client.patch(f"/api/cases/{case['id']}", headers=H, json={"status": "preparing"}).json()["status"] == "preparing"
    rx = client.post("/api/rx", headers=H, json={"case_id": case["id"], "items": [{"name": "Paracetamol", "morning": 1, "night": 1, "days": 3}],
                                                 "pharmacy": {"key": "PHARM-01", "name": "Jan Aushadhi"}}).json()
    assert rx["lang"] == "ta" and rx["status"] == "sent"
    public = client.get(f"/api/rx/{rx['id']}").json()
    assert "patient_phone" not in public, "the public medicine card never exposes the phone number"
    PH = {"Authorization": "Bearer " + _login("pharmacy", "9876500002", "PHARM-01")}
    assert client.patch(f"/api/rx/{rx['id']}", headers=PH, json={"status": "ready"}).json()["status"] == "ready"
    sms = client.get("/api/outbox", headers=H).json()["messages"]
    assert any("ready" in m["body"] for m in sms) and all(m["to_number"].startswith("••") for m in sms)


def test_wrong_otp_rejected():
    client.post("/api/auth/otp", json={"phone": "9876500003"})
    assert client.post("/api/auth/verify", json={"phone": "9876500003", "code": "000000", "role": "doctor"}).status_code == 400


def test_prescription_needs_a_doctor_login():
    assert client.post("/api/rx", json={"items": [{"name": "X"}]}).status_code == 401


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_geo_logic_node():
    out = subprocess.run(["node", str(ROOT / "tests" / "geo.test.js")], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_browser_engine_parity():
    assert subprocess.run(["node", str(ROOT / "scripts" / "parity_check.js")], capture_output=True).returncode == 0
    out = subprocess.run(["python3", str(ROOT / "scripts" / "parity_compare.py")], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout
