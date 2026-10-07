"""Facility navigation: structured filters, opening hours, freshness, provenance."""
from datetime import datetime

from backend.app.navigation import freshness, navigate, open_status
from backend.app.protocol import facilities

WED_11 = datetime(2026, 10, 7, 11, 0)
WED_22 = datetime(2026, 10, 7, 22, 0)


def fac(fid):
    return next(f for f in facilities() if f["id"] == fid)


def test_unverified_record_is_never_primary():
    nav = navigate("PROMPT_ROUTINE", "mental", [], ["low mood"], WED_11)
    assert nav["primary"]["id"] != "MH-011"
    assert freshness(fac("MH-011"), WED_11.date())["status"] == "UNVERIFIED"


def test_stale_record_detected():
    assert freshness(fac("CARD-002"), WED_11.date())["status"] == "STALE"


def test_closed_facility_excluded_for_same_day():
    nav = navigate("URGENT_SAME_DAY", "general", [], ["fever"], WED_22)
    assert nav["primary"]["id"] != "PHC-001"
    assert any(e["id"] == "PHC-001" and "Closed" in e["reason"] for e in nav["excluded"])


def test_emergency_needs_24x7():
    nav = navigate("EMERGENCY", "cardiac", [{"service": ["cardiology"]}], ["chest pain"], WED_11)
    assert nav["primary"]["open"]["hours"] == "24x7"


def test_every_card_has_provenance():
    nav = navigate("PROMPT_ROUTINE", "general", [], ["fever"], WED_11)
    for c in [nav["primary"]] + nav["alternatives"]:
        p = c["provenance"]
        assert p["record_id"] and p["source"] and p["last_verified"]


def test_open_status_text():
    assert open_status(fac("PHC-001"), WED_11)["open_now"] is True
    assert "opens tomorrow" in open_status(fac("PHC-001"), WED_22)["text"]


def test_conflicting_sources_are_warned():
    nav = navigate("URGENT_SAME_DAY", "general", [], ["fever"], WED_22)
    assert nav["primary"]["id"] == "PHC-012"
    assert any("disagree" in w for w in nav["warnings"])
