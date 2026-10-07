"""
Cases, live notifications, prescriptions, pharmacy reservations, OTP login
and the SMS outbox.

Flow (feature: "ASHA registers, nearest doctor is notified"):
  1. Patient or ASHA finishes a check and taps "Notify the nearest doctor".
     A case is stored with the triage result, symptoms, vitals and the
     target facility (nearest suitable one, picked on the map).
  2. Every dashboard subscribed to that facility (or to "all") receives a
     server-sent event instantly, with a sound and a browser notification,
     plus a clinician prep list so medicines/equipment can be readied.
  3. The doctor writes a prescription (the doctor decides medicines and
     doses, never RuralPulse). The patient gets a link to a medicine card
     in their own language, with pictures and audio; the nearest pharmacy
     gets a reservation and marks it ready.
  4. SMS go through MSG91 or Twilio when configured; otherwise they are
     kept in an outbox shown on the dashboard (demo mode).

Storage is SQLite (one file, logs/ruralpulse.db). For production use a
managed database and encrypt data at rest (DPDP Act).
"""
import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx

from . import config

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript("""
        CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, status TEXT,
            facility_key TEXT, facility_name TEXT, data TEXT);
        CREATE TABLE IF NOT EXISTS rx (id TEXT PRIMARY KEY, case_id TEXT, created_at TEXT, status TEXT,
            pharmacy_key TEXT, data TEXT);
        CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, channel TEXT,
            to_number TEXT, body TEXT, status TEXT, detail TEXT);
        CREATE TABLE IF NOT EXISTS otp (phone TEXT PRIMARY KEY, code_hash TEXT, expires REAL, tries INTEGER);
        """)
    return _conn


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------- live events (SSE)
class Hub:
    def __init__(self):
        self.subs: Dict[str, List[asyncio.Queue]] = {}

    def subscribe(self, key: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self.subs.setdefault(key, []).append(q)
        return q

    def unsubscribe(self, key: str, q: asyncio.Queue):
        if q in self.subs.get(key, []):
            self.subs[key].remove(q)

    def publish(self, keys: List[str], event: Dict):
        for k in set(keys + ["all"]):
            for q in list(self.subs.get(k, [])):
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass


hub = Hub()


# --------------------------------------------------------------- auth (phone + OTP)
def _sign(payload: Dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(config.AUTH_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{raw}.{sig}"


def verify_token(token: str) -> Optional[Dict]:
    try:
        raw, sig = token.split(".")
        good = hmac.new(config.AUTH_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, good):
            return None
        data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        return data if data.get("exp", 0) > time.time() else None
    except Exception:
        return None


def clean_phone(p: str) -> str:
    digits = "".join(ch for ch in (p or "") if ch.isdigit())
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    return digits


async def request_otp(phone: str) -> Dict:
    phone = clean_phone(phone)
    if len(phone) != 10:
        return {"ok": False, "error": "Enter a 10-digit mobile number"}
    code = f"{secrets.randbelow(1_000_000):06d}"
    with _lock:
        db().execute("REPLACE INTO otp VALUES (?,?,?,0)", (phone, hashlib.sha256(code.encode()).hexdigest(), time.time() + 600))
        db().commit()
    sent = await send_sms(phone, f"RuralPulse login code: {code}. Valid for 10 minutes. Do not share it.")
    out = {"ok": True, "sent_via": sent["status"]}
    if config.DEMO_OTP and sent["status"] != "sent":
        out["demo_otp"] = code   # no SMS gateway configured: show it on screen for the demo
    return out


def verify_otp(phone: str, code: str, role: str, name: str, facility_key: str = "", facility_name: str = "") -> Dict:
    phone = clean_phone(phone)
    with _lock:
        row = db().execute("SELECT * FROM otp WHERE phone=?", (phone,)).fetchone()
        if not row or row["expires"] < time.time() or row["tries"] >= 5:
            return {"ok": False, "error": "Code expired. Ask for a new one."}
        if not hmac.compare_digest(row["code_hash"], hashlib.sha256((code or "").strip().encode()).hexdigest()):
            db().execute("UPDATE otp SET tries=tries+1 WHERE phone=?", (phone,))
            db().commit()
            return {"ok": False, "error": "Wrong code"}
        db().execute("DELETE FROM otp WHERE phone=?", (phone,))
        db().commit()
    user = {"phone": phone, "role": role if role in ("asha", "doctor", "pharmacy") else "asha", "name": (name or "")[:60],
            "facility_key": facility_key, "facility_name": facility_name, "exp": time.time() + 30 * 86400}
    return {"ok": True, "token": _sign(user), "user": user}


# --------------------------------------------------------------- SMS
async def send_sms(to: str, body: str) -> Dict:
    to = clean_phone(to)
    status, detail = "outbox", "No SMS gateway configured (demo): message kept in the outbox."
    try:
        if config.SMS_PROVIDER == "msg91" and config.MSG91_AUTH_KEY and config.MSG91_TEMPLATE_ID:
            async with httpx.AsyncClient(timeout=10) as cl:
                r = await cl.post("https://control.msg91.com/api/v5/flow/",
                                  headers={"authkey": config.MSG91_AUTH_KEY, "Content-Type": "application/json"},
                                  json={"template_id": config.MSG91_TEMPLATE_ID, "short_url": "0",
                                        "recipients": [{"mobiles": "91" + to, "message": body}]})
                status, detail = ("sent" if r.status_code < 300 else "failed"), r.text[:200]
        elif config.SMS_PROVIDER == "twilio" and config.TWILIO_SID:
            async with httpx.AsyncClient(timeout=10, auth=(config.TWILIO_SID, config.TWILIO_TOKEN)) as cl:
                r = await cl.post(f"https://api.twilio.com/2010-04-01/Accounts/{config.TWILIO_SID}/Messages.json",
                                  data={"To": "+91" + to, "From": config.TWILIO_FROM, "Body": body})
                status, detail = ("sent" if r.status_code < 300 else "failed"), r.text[:200]
    except Exception as e:  # network or provider failure: keep it in the outbox
        status, detail = "failed", f"{type(e).__name__}"
    with _lock:
        db().execute("INSERT INTO outbox (created_at, channel, to_number, body, status, detail) VALUES (?,?,?,?,?,?)",
                     (now(), "sms", to, body, status, detail))
        db().commit()
    hub.publish(["outbox"], {"type": "sms", "to": to[-4:].rjust(10, "•"), "body": body, "status": status})
    return {"status": status, "detail": detail}


def outbox(limit: int = 30) -> List[Dict]:
    rows = db().execute("SELECT * FROM outbox ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(r), "to_number": "••••••" + r["to_number"][-4:]} for r in rows]


# --------------------------------------------------------------- cases
def _row(r) -> Dict:
    d = json.loads(r["data"])
    d.update({"id": r["id"], "status": r["status"], "created_at": r["created_at"], "updated_at": r["updated_at"],
              "facility_key": r["facility_key"], "facility_name": r["facility_name"]})
    return d


async def create_case(payload: Dict, user: Optional[Dict]) -> Dict:
    cid = "CASE-" + uuid.uuid4().hex[:8].upper()
    fac = payload.get("facility") or {}
    data = {
        "level": payload.get("level"), "title": payload.get("title"), "symptoms": payload.get("symptoms", []),
        "red_flags": payload.get("red_flags", []), "message": (payload.get("message") or "")[:2000],
        "patient_lang": payload.get("lang", "en"), "age": payload.get("age"), "duration_days": payload.get("duration_days"),
        "pregnant": payload.get("pregnant"), "vitals": payload.get("vitals", {}), "doctor_note": payload.get("doctor_note", ""),
        "prep": payload.get("prep", []), "patient_phone": clean_phone(payload.get("patient_phone", "")),
        "patient_name": (payload.get("patient_name") or "")[:60], "slot": payload.get("slot"),
        "assessment_id": payload.get("assessment_id"), "mode": payload.get("mode", "patient"),
        "location": payload.get("location"), "facility": fac,
        "sent_by": {"name": (user or {}).get("name") or payload.get("asha_name", ""), "phone": (user or {}).get("phone", ""),
                    "role": (user or {}).get("role", "patient"), "verified": bool(user)},
    }
    key = fac.get("key") or "unassigned"
    with _lock:
        db().execute("INSERT INTO cases VALUES (?,?,?,?,?,?,?)", (cid, now(), now(), "new", key, fac.get("name", ""), json.dumps(data, ensure_ascii=False)))
        db().commit()
    case = get_case(cid)
    hub.publish([key], {"type": "case", "case": case})
    if fac.get("phone") and str(fac["phone"]).replace(" ", "").isdigit():
        await send_sms(fac["phone"], f"RuralPulse: new {data['level']} patient coming. {', '.join(data['symptoms'])[:80]}. Case {cid}.")
    return case


def get_case(cid: str) -> Optional[Dict]:
    r = db().execute("SELECT * FROM cases WHERE id=?", (cid,)).fetchone()
    return _row(r) if r else None


def list_cases(facility_key: str = "", limit: int = 50) -> List[Dict]:
    if facility_key and facility_key != "all":
        rows = db().execute("SELECT * FROM cases WHERE facility_key=? ORDER BY created_at DESC LIMIT ?", (facility_key, limit)).fetchall()
    else:
        rows = db().execute("SELECT * FROM cases ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [_row(r) for r in rows]


async def update_case(cid: str, status: str, user: Optional[Dict]) -> Optional[Dict]:
    if status not in ("new", "seen", "preparing", "ready", "done"):
        return None
    with _lock:
        db().execute("UPDATE cases SET status=?, updated_at=? WHERE id=?", (status, now(), cid))
        db().commit()
    case = get_case(cid)
    if case:
        hub.publish([case["facility_key"], "case:" + cid], {"type": "case_update", "case": case})
        if status == "ready" and case.get("patient_phone"):
            await send_sms(case["patient_phone"], f"RuralPulse: {case['facility_name'] or 'The doctor'} is ready for you. Case {cid}.")
    return case


# --------------------------------------------------------------- prescriptions + pharmacy
async def create_rx(payload: Dict, user: Optional[Dict]) -> Dict:
    rid = "RX-" + uuid.uuid4().hex[:8].upper()
    items = []
    for it in payload.get("items", [])[:20]:
        if not (it.get("name") or "").strip():
            continue
        items.append({"name": it["name"].strip()[:80], "strength": (it.get("strength") or "")[:30],
                      "form": it.get("form", "tablet"), "morning": float(it.get("morning") or 0), "afternoon": float(it.get("afternoon") or 0),
                      "night": float(it.get("night") or 0), "food": it.get("food", "after"), "days": int(it.get("days") or 0),
                      "note": (it.get("note") or "")[:200]})
    case = get_case(payload.get("case_id", "")) if payload.get("case_id") else None
    data = {"items": items, "notes": (payload.get("notes") or "")[:600], "follow_up": payload.get("follow_up"),
            "lang": payload.get("lang") or (case or {}).get("patient_lang", "en"), "doctor": payload.get("doctor") or (user or {}).get("name", ""),
            "facility": payload.get("facility_name") or (case or {}).get("facility_name", ""),
            "pharmacy": payload.get("pharmacy") or {}, "patient_name": (case or {}).get("patient_name", ""),
            "patient_phone": clean_phone(payload.get("patient_phone") or (case or {}).get("patient_phone", "")),
            "translations": {}}
    pkey = (data["pharmacy"] or {}).get("key", "")
    with _lock:
        db().execute("INSERT INTO rx VALUES (?,?,?,?,?,?)", (rid, payload.get("case_id", ""), now(), "sent" if pkey else "issued", pkey,
                                                            json.dumps(data, ensure_ascii=False)))
        db().commit()
    rx = get_rx(rid)
    hub.publish([pkey, "pharmacy", "rx:" + rid], {"type": "rx", "rx": rx})
    if data["patient_phone"]:
        link = (config.PUBLIC_URL or (payload.get("origin") or "").rstrip("/")) + f"/rx.html?id={rid}"
        await send_sms(data["patient_phone"], f"RuralPulse medicine card from {data['doctor'] or 'your doctor'}: {link}")
    if case:
        await update_case(case["id"], "done", user)
    return rx


def get_rx(rid: str) -> Optional[Dict]:
    r = db().execute("SELECT * FROM rx WHERE id=?", (rid,)).fetchone()
    if not r:
        return None
    d = json.loads(r["data"])
    d.update({"id": r["id"], "case_id": r["case_id"], "created_at": r["created_at"], "status": r["status"], "pharmacy_key": r["pharmacy_key"]})
    return d


def save_rx_translation(rid: str, lang: str, texts: Dict) -> None:
    rx = get_rx(rid)
    if not rx:
        return
    data = {k: v for k, v in rx.items() if k not in ("id", "case_id", "created_at", "status", "pharmacy_key")}
    data.setdefault("translations", {})[lang] = texts
    with _lock:
        db().execute("UPDATE rx SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), rid))
        db().commit()


def list_rx(pharmacy_key: str = "", limit: int = 50) -> List[Dict]:
    if pharmacy_key and pharmacy_key != "all":
        rows = db().execute("SELECT id FROM rx WHERE pharmacy_key=? ORDER BY created_at DESC LIMIT ?", (pharmacy_key, limit)).fetchall()
    else:
        rows = db().execute("SELECT id FROM rx ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [get_rx(r["id"]) for r in rows]


async def update_rx(rid: str, status: str) -> Optional[Dict]:
    if status not in ("issued", "sent", "reserved", "ready", "collected", "out_of_stock"):
        return None
    with _lock:
        db().execute("UPDATE rx SET status=? WHERE id=?", (status, rid))
        db().commit()
    rx = get_rx(rid)
    if rx:
        hub.publish([rx["pharmacy_key"], "pharmacy", "rx:" + rid], {"type": "rx_update", "rx": rx})
        if status == "ready" and rx.get("patient_phone"):
            ph = (rx.get("pharmacy") or {}).get("name", "the pharmacy")
            await send_sms(rx["patient_phone"], f"RuralPulse: your medicines are ready at {ph}. Show code {rid}.")
    return rx


# --------------------------------------------------------------- demo data (so dashboards never open empty)
DEMO_CASES = [
    dict(h=0.3, fac=("CHC-004", "Rampur Community Health Centre"), level="EMERGENCY", title="Emergency: get help now", lang="hi", status="preparing",
         message="साँप ने काटा है पैर पर, 20 मिनट पहले, खेत में", symptoms=["snake bite"], red_flags=["Snake bite"], age=34, duration_days=0,
         name="Ramesh Yadav", asha="ASHA Sunita Devi", vitals={"spo2": 97}, prep=["Anti-snake venom (ASV) vials: check stock", "Anaphylaxis kit", "20-minute whole blood clotting test (20WBCT)"]),
    dict(h=0.8, fac=("PHC-001", "Sundarpur Primary Health Centre"), level="URGENT_SAME_DAY", title="See a doctor today", lang="ta", status="new",
         message="மூன்று நாட்களாக காய்ச்சல், உடம்பு வலி, வயது 45", symptoms=["fever", "body ache"], red_flags=[], age=45, duration_days=3,
         name="Lakshmi M", asha="ASHA Kavitha", vitals={"spo2": 96, "temp_c": 38.7}, prep=["Thermometer", "Malaria / dengue rapid tests", "ORS"]),
    dict(h=1.5, fac=("MCH-003", "Ma-Shishu Maternal & Child Health Centre"), level="EMERGENCY", title="Emergency: get help now", lang="bn", status="ready",
         message="সাত মাসের গর্ভবতী, রক্তপাত হচ্ছে", symptoms=["bleeding"], red_flags=["Pregnancy danger sign"], age=24, duration_days=0, pregnant=True,
         name="Mousumi Das", asha="ASHA Rina", vitals={}, prep=["Labour room / obstetric emergency kit", "Check blood availability", "Arrange referral to FRU if needed"]),
    dict(h=2.2, fac=("PHC-001", "Sundarpur Primary Health Centre"), level="URGENT_SAME_DAY", title="See a doctor today", lang="hi", status="seen",
         message="kutte ne kata hai, 12 saal ka beta, kal se", symptoms=["dog or animal bite"], red_flags=[], age=12, duration_days=1,
         name="Arjun (12)", asha="ASHA Sunita Devi", vitals={}, prep=["Anti-rabies vaccine (ARV): check stock", "Rabies immunoglobulin (RIG) for category III bites", "Wound-wash station"]),
    dict(h=3.0, fac=("AAM-021", "Sundarpur Ayushman Arogya Mandir"), level="PROMPT_ROUTINE", title="Get checked in the next 2-3 days", lang="te", status="done",
         message="మూడు వారాలుగా దగ్గు, వయస్సు 52", symptoms=["cough"], red_flags=[], age=52, duration_days=21,
         name="Venkat Rao", asha="", vitals={"spo2": 95}, prep=["Sputum container if cough 2+ weeks (NTEP)", "Pulse oximeter"]),
    dict(h=4.5, fac=("DH-007", "Sundarpur District Hospital"), level="EMERGENCY", title="Emergency: get help now", lang="mr", status="done",
         message="वडिलांच्या छातीत दुखत आहे, घाम येतोय, वय 61", symptoms=["chest pain"], red_flags=["Chest pain or pressure"], age=61, duration_days=0,
         name="Shankar Patil", asha="", vitals={"spo2": 93}, prep=["ECG machine ready", "Cardiac emergency tray and oxygen", "Arrange referral transport to a cardiac centre if needed"]),
    dict(h=5.5, fac=("PHC-012", "Kalyanpur 24x7 Primary Health Centre"), level="URGENT_SAME_DAY", title="See a doctor today", lang="ur", status="done",
         message="بچے کو 2 دن سے دست ہیں، عمر 3 سال", symptoms=["loose motions / diarrhoea"], red_flags=[], age=3, duration_days=2,
         name="Ayaan", asha="ASHA Nasreen", vitals={"temp_c": 37.9}, prep=["ORS and zinc (children)", "IV fluids for dehydration"]),
    dict(h=7.0, fac=("PHC-001", "Sundarpur Primary Health Centre"), level="INFO_SELF_CARE", title="Rest and watch at home", lang="en", status="done",
         message="Runny nose and mild cough since yesterday, age 25", symptoms=["cold / runny nose", "cough"], red_flags=[], age=25, duration_days=1,
         name="Priya S", asha="", vitals={}, prep=["Routine OPD"]),
]
DEMO_RX = [
    dict(case=1, ph=("PHARM-01", "Pradhan Mantri Bhartiya Janaushadhi Kendra, Sundarpur (demo)"), status="reserved", lang="ta", doctor="Dr. Meera Iyer",
         fac="Sundarpur Primary Health Centre", notes="Drink plenty of water and rest. Come back if the fever continues after 3 days.",
         items=[dict(name="Paracetamol", strength="500 mg", form="tablet", morning=1, afternoon=0, night=1, food="after", days=3, note="Only if the fever is high"),
                dict(name="ORS", strength="1 sachet in 1 litre water", form="syrup", morning=1, afternoon=1, night=1, food="any", days=3, note="")]),
    dict(case=3, ph=("PHARM-02", "Sundarpur PHC Dispensary (demo)"), status="ready", lang="hi", doctor="Dr. R. K. Verma",
         fac="Sundarpur Primary Health Centre", notes="Complete all 5 vaccine doses on the dates given. Keep the wound clean.",
         items=[dict(name="Anti-rabies vaccine", strength="0.1 ml ID", form="injection", morning=1, afternoon=0, night=0, food="any", days=1, note="Next doses on day 3, 7 and 28")]),
    dict(case=6, ph=("PHARM-03", "Rampur Medical Store (demo)"), status="collected", lang="ur", doctor="Dr. Fatima Khan",
         fac="Kalyanpur 24x7 Primary Health Centre", notes="Give ORS after every loose motion. Continue feeding.",
         items=[dict(name="Zinc", strength="20 mg", form="tablet", morning=1, afternoon=0, night=0, food="after", days=14, note="Dissolve in a spoon of water")]),
]


def seed_demo(force: bool = False) -> int:
    """Fill an empty database with realistic demo reports (marked demo=true)."""
    from datetime import timedelta
    with _lock:
        if not force and db().execute("SELECT COUNT(*) FROM cases").fetchone()[0]:
            return 0
        base = datetime.now(timezone.utc)
        ids = []
        for i, c in enumerate(DEMO_CASES):
            cid = f"DEMO-{i + 1:03d}"
            ts = (base - timedelta(hours=c["h"])).isoformat(timespec="seconds")
            data = {"level": c["level"], "title": c["title"], "symptoms": c["symptoms"], "red_flags": c["red_flags"], "message": c["message"],
                    "patient_lang": c["lang"], "age": c["age"], "duration_days": c["duration_days"], "pregnant": c.get("pregnant"),
                    "vitals": c["vitals"], "doctor_note": f"RURALPULSE REFERRAL NOTE | {c['title']}\nPatient's own words: \"{c['message']}\"\n(Demo record)",
                    "prep": c["prep"], "patient_phone": "", "patient_name": c["name"], "slot": None, "assessment_id": None,
                    "mode": "asha" if c["asha"] else "patient", "location": None, "facility": {"key": c["fac"][0], "name": c["fac"][1]},
                    "sent_by": {"name": c["asha"], "phone": "", "role": "asha" if c["asha"] else "patient", "verified": bool(c["asha"])}, "demo": True}
            db().execute("REPLACE INTO cases VALUES (?,?,?,?,?,?,?)", (cid, ts, ts, c["status"], c["fac"][0], c["fac"][1], json.dumps(data, ensure_ascii=False)))
            ids.append(cid)
        for j, r in enumerate(DEMO_RX):
            ts = (base - timedelta(hours=DEMO_CASES[r["case"]]["h"] - 0.2)).isoformat(timespec="seconds")
            data = {"items": r["items"], "notes": r["notes"], "follow_up": None, "lang": r["lang"], "doctor": r["doctor"], "facility": r["fac"],
                    "pharmacy": {"key": r["ph"][0], "name": r["ph"][1]}, "patient_name": DEMO_CASES[r["case"]]["name"], "patient_phone": "",
                    "translations": {}, "demo": True}
            db().execute("REPLACE INTO rx VALUES (?,?,?,?,?,?)", (f"RX-DEMO{j + 1}", ids[r["case"]], ts, r["status"], r["ph"][0], json.dumps(data, ensure_ascii=False)))
        for to, body, st in [("9000000001", "RuralPulse: Rampur CHC is ready for you. Case DEMO-001.", "outbox"),
                             ("9000000002", "RuralPulse: your medicines are ready at Sundarpur PHC Dispensary. Show code RX-DEMO2.", "outbox"),
                             ("9000000003", "RuralPulse medicine card from Dr. Meera Iyer: /rx.html?id=RX-DEMO1", "outbox")]:
            db().execute("INSERT INTO outbox (created_at, channel, to_number, body, status, detail) VALUES (?,?,?,?,?,?)",
                         (now(), "sms", to, body, st, "demo"))
        db().commit()
    return len(DEMO_CASES)


SIM = [
    ("EMERGENCY", "Emergency: get help now", "ta", "அம்மாவுக்கு மூச்சு விட முடியவில்லை, வயது 68", ["difficulty breathing"], ["Difficulty breathing"], 68, 0, {"spo2": 86},
     ["Oxygen cylinder and pulse oximeter", "Nebuliser", "Airway equipment"]),
    ("URGENT_SAME_DAY", "See a doctor today", "hi", "4 din se tez bukhar, ulti bhi ho rahi hai, umar 19", ["fever", "vomiting"], [], 19, 4, {"temp_c": 39.1},
     ["Thermometer", "Malaria / dengue rapid tests", "ORS"]),
    ("URGENT_SAME_DAY", "See a doctor today", "kn", "ಮಗುವಿಗೆ 2 ದಿನದಿಂದ ಜ್ವರ, ವಯಸ್ಸು 2", ["fever"], [], 2, 2, {"temp_c": 38.9},
     ["Thermometer", "Paediatric review", "ORS"]),
    ("EMERGENCY", "Emergency: get help now", "bn", "কীটনাশক খেয়ে ফেলেছে, বয়স ২৮", ["poisoning / swallowed pesticide"], ["Poisoning or pesticide ingestion"], 28, 0, {},
     ["Ask for the pesticide or medicine container", "Atropine availability for organophosphate poisoning (per protocol)", "Suction and oxygen"]),
    ("PROMPT_ROUTINE", "Get checked in the next 2-3 days", "ml", "ഒരാഴ്ചയായി ചൊറിച്ചിൽ, പ്രായം 30", ["skin rash / itching"], [], 30, 7, {}, ["Dermatology teleconsult option"]),
]


async def simulate(facility_key: str, facility_name: str) -> Dict:
    lvl, title, lang, m, sym, rf, age, dur, vit, prep = SIM[secrets.randbelow(len(SIM))]
    names = ["Kamala", "Ravi", "Fatima", "Suresh", "Anjali", "Imran", "Lakshmi", "Gopal"]
    return await create_case({"level": lvl, "title": title, "lang": lang, "message": m, "symptoms": sym, "red_flags": rf, "age": age,
                              "duration_days": dur, "vitals": vit, "prep": prep, "mode": "asha", "patient_name": names[secrets.randbelow(len(names))] + " (simulated)",
                              "asha_name": "ASHA (simulated)", "facility": {"key": facility_key or "PHC-001", "name": facility_name or "Sundarpur Primary Health Centre"}},
                             {"name": "ASHA (simulated)", "role": "asha", "phone": ""})


SIM_RX = [
    ("ta", "Dr. Meera Iyer", [dict(name="Paracetamol", strength="500 mg", form="tablet", morning=1, afternoon=0, night=1, food="after", days=3, note="Only if fever is high")]),
    ("hi", "Dr. R. K. Verma", [dict(name="Amoxicillin", strength="500 mg", form="capsule", morning=1, afternoon=1, night=1, food="after", days=5, note="Finish the full course"),
                               dict(name="ORS", strength="1 sachet / litre", form="syrup", morning=1, afternoon=1, night=1, food="any", days=3, note="")]),
    ("bn", "Dr. S. Banerjee", [dict(name="Salbutamol inhaler", strength="100 mcg", form="inhaler", morning=1, afternoon=0, night=1, food="any", days=14, note="2 puffs when breathless")]),
    ("kn", "Dr. Anil Gowda", [dict(name="Iron + folic acid", strength="IFA", form="tablet", morning=0, afternoon=0, night=1, food="after", days=30, note="Pregnancy supplement")]),
]


async def simulate_rx(pharmacy_key: str, pharmacy_name: str) -> Dict:
    lang, doc, items = SIM_RX[secrets.randbelow(len(SIM_RX))]
    return await create_rx({"items": items, "notes": "Simulated prescription (demo).", "lang": lang, "doctor": doc,
                            "facility_name": "Sundarpur Primary Health Centre",
                            "pharmacy": {"key": pharmacy_key or "PHARM-01", "name": pharmacy_name or "Janaushadhi Kendra (demo)"}},
                           {"name": doc, "role": "doctor"})
