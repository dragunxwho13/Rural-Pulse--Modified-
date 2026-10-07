"""Multilingual extraction and the full vignette suite."""
import json

from backend.app.config import DATA_DIR, ROOT
from backend.app.evaluation import run_suite
from backend.app.extract import extract
from backend.app.language import detect


def test_language_detection():
    assert detect("मुझे बुखार है")["code"] == "hi"
    assert detect("எனக்கு காய்ச்சல்")["code"] == "ta"
    assert detect("mujhe bukhar hai")["code"] == "hi"
    assert detect("enakku kaichal irukku")["code"] == "ta"
    assert detect("I have a fever")["code"] == "en"
    assert detect("আমার জ্বর")["code"] == "bn" and detect("আমার জ্বর")["tier"] == "core"
    assert detect("ڏينهن کان بخار آهي")["code"] == "sd" and detect("ڏينهن کان بخار آهي")["supported"] is False
    assert detect("मलाई ज्वरो छ")["code"] == "ne"
    assert detect("मला ताप आहे")["code"] == "mr"


def test_duration_age_severity():
    e = extract("teen din se bukhar, umar 45, bahut tez dard")
    assert e["duration_days"] == 3 and e["age_years"] == 45 and e["severity"] == 8
    e = extract("ஒரு வாரமாக இருமல், வயது 30")
    assert e["duration_days"] == 7 and e["age_years"] == 30
    e = extract("4 महीने की गर्भवती हूं, 2 दिन से उल्टी, उम्र 26")
    assert e["age_years"] == 26 and e["duration_days"] == 2 and e["pregnant"] is True
    assert extract("my 2 month old baby has fever")["age_years"] < 0.25


def test_suite_meets_safety_floor():
    r = run_suite()
    m = r["metrics"]
    assert m["correct_abstention_pct"] == 100
    assert m["red_flag_sensitivity_pct"] >= 90
    assert m["over_triage_pct"] <= 10
    # the only accepted miss is the documented atypical-cardiac gap
    assert [u["id"] for u in r["under_triaged"]] == ["EM-15"]
    assert r["by_group"]["multilingual"]["exact_pct"] == 100


def test_frontend_data_in_sync():
    for name in ("protocol.json", "facilities.json", "i18n.json", "first_aid.json", "prep.json", "doctors.json"):
        a = json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
        b = json.loads((ROOT / "frontend" / "data" / name).read_text(encoding="utf-8"))
        assert a == b, f"frontend/data/{name} is out of date: run python scripts/sync_data.py"


def test_native_digits_and_number_words():
    e = extract("মোৰ ৩ দিনৰ পৰা জ্বৰ, বয়স ৪৫")
    assert e["duration_days"] == 3 and e["age_years"] == 45
    assert extract("मला दोन दिवसांपासून ताप आहे, वय 30")["duration_days"] == 2


def test_every_full_pack_language_has_every_string():
    from backend.app.protocol import i18n, protocol
    packs = [c for c, i in protocol()["supported_languages"].items() if i["ui_pack"]]
    assert len(packs) == 14
    for key, by in i18n()["strings"].items():
        missing = [c for c in packs if c not in by]
        assert not missing, (key, missing)
    for lv in protocol()["messages"]["levels"].values():
        for leaf in lv.values():
            assert all(c in leaf for c in packs)


def test_22_scheduled_languages_plus_english():
    from backend.app.protocol import protocol, lang_chain
    sup = protocol()["supported_languages"]
    assert len(sup) == 23
    assert lang_chain("kok") == ["kok", "mr", "hi", "en"]
