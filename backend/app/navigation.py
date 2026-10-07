"""
Verified facility navigation (hybrid retrieval).

1. Structured filters first: required service, open now / 24x7, emergency
   capability, verification freshness.
2. Then ranking: semantic relevance (Gemini embeddings when available,
   TF-IDF otherwise) + travel time + freshness + language match.
3. Every recommendation carries provenance: record id, source, authority,
   last-verified date, freshness status, conflicts. Stale or unverified
   records are never presented as a confident first choice; excluded
   facilities are listed with the reason.
"""
import math
import re
from collections import Counter
from datetime import date, datetime
from typing import Dict, List, Optional

from . import config, llm
from .protocol import facilities, protocol, normalize

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


# ---------------------------------------------------------------- retrieval
def facility_text(f: Dict) -> str:
    return f"{f['name']}. {f['type']}. Services: {', '.join(s.replace('_', ' ') for s in f['services'])}. {f['description']}"


class Retriever:
    def __init__(self):
        self.docs = facilities()
        self.texts = [facility_text(f) for f in self.docs]
        self._emb = None
        self.method = "tfidf"
        toks = [self._tok(t) for t in self.texts]
        df = Counter(w for d in toks for w in set(d))
        n = len(toks)
        self.idf = {w: math.log((n + 1) / (c + 0.5)) for w, c in df.items()}
        self.vecs = [self._tfidf(d) for d in toks]

    @staticmethod
    def _tok(t: str) -> List[str]:
        return [w for w in re.findall(r"[a-z]+", normalize(t)) if len(w) > 2]

    def _tfidf(self, toks: List[str]) -> Dict[str, float]:
        tf = Counter(toks)
        v = {w: c * self.idf.get(w, 0.5) for w, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        return {w: x / norm for w, x in v.items()}

    def _ensure_embeddings(self):
        if self._emb is None and config.USE_EMBEDDINGS:
            self._emb = llm.embed(self.texts) or False
            if self._emb:
                self.method = "gemini-embedding"

    def scores(self, query: str) -> Dict[str, float]:
        self._ensure_embeddings()
        if self._emb:
            q = llm.embed([query], task="RETRIEVAL_QUERY")
            if q:
                qv = q[0]
                qn = math.sqrt(sum(x * x for x in qv)) or 1
                out = {}
                for f, e in zip(self.docs, self._emb):
                    en = math.sqrt(sum(x * x for x in e)) or 1
                    out[f["id"]] = sum(a * b for a, b in zip(qv, e)) / (qn * en)
                return out
        qv = self._tfidf(self._tok(query))
        return {f["id"]: sum(qv.get(w, 0) * x for w, x in v.items()) for f, v in zip(self.docs, self.vecs)}


_retriever: Optional[Retriever] = None


def retriever() -> Retriever:
    global _retriever
    if _retriever is None:
        _retriever = Retriever()
    return _retriever


# ---------------------------------------------------------------- facts
def freshness(f: Dict, today: date) -> Dict:
    try:
        d = date.fromisoformat(f.get("last_verified", ""))
        age = (today - d).days
    except ValueError:
        return {"status": "UNVERIFIED", "days": None, "score": 0.0}
    if age <= config.FRESH_DAYS:
        return {"status": "VERIFIED", "days": age, "score": 1.0}
    if age <= config.STALE_DAYS:
        return {"status": "STALE", "days": age, "score": 0.4}
    return {"status": "UNVERIFIED", "days": age, "score": 0.0}


def open_status(f: Dict, at: datetime) -> Dict:
    h = f["hours"]
    if h.get("open_24x7"):
        return {"open_now": True, "text": "Open 24x7", "hours": "24x7"}
    ds = sorted(h["days"])
    days = f"{DAYS[ds[0]]}-{DAYS[ds[-1]]}" if len(ds) > 2 and ds == list(range(ds[0], ds[-1] + 1)) else ", ".join(DAYS[d] for d in ds)
    hours = f"{days}, {h['open']}-{h['close']}"
    hm = at.strftime("%H:%M")
    is_open = at.weekday() in h["days"] and h["open"] <= hm < h["close"]
    if is_open:
        return {"open_now": True, "text": f"Open now, closes {h['close']}", "hours": hours}
    # next opening
    for k in range(0, 8):
        d = (at.weekday() + k) % 7
        if d in h["days"] and (k > 0 or hm < h["open"]):
            when = "today" if k == 0 else ("tomorrow" if k == 1 else DAYS[d])
            return {"open_now": False, "text": f"Closed now, opens {when} {h['open']}", "hours": hours}
    return {"open_now": False, "text": "Closed", "hours": hours}


def _card(f: Dict, fr: Dict, op: Dict, score: float, rel: float, reasons: List[str], lang_name: str) -> Dict:
    lang_ok = any(lang_name.lower().startswith(l.lower()) for l in f["languages"])
    return {
        "id": f["id"], "name": f["name"], "type": f["type"], "level": f["level"],
        "services": f["services"], "distance_km": f["distance_km"], "travel_time_min": f["travel_time_min"],
        "map_xy_km": f["map_xy_km"], "phone": f["phone"], "languages": f["languages"], "language_match": lang_ok,
        "referral_required": f["referral_required"], "wheelchair_access": f["wheelchair_access"],
        "telemedicine": f["telemedicine"], "description": f["description"],
        "open": op, "freshness": fr,
        "provenance": {"record_id": f["id"], "source": f["source"], "authority": f["authority"],
                       "last_verified": f["last_verified"], "verified_by": f.get("verified_by"),
                       "conflicts": f.get("conflicts", [])},
        "score": round(score, 3), "relevance": round(rel, 3), "why": reasons,
    }


def navigate(level: str, category: str, flags: List[Dict], symptom_labels: List[str],
             at: datetime, lang_name: str = "English") -> Dict:
    P = protocol()
    today = at.date()
    if level == "EMERGENCY":
        needs = {"required": ["emergency"], "preferred": [s for x in flags for s in x["service"] if s != "emergency"]}
    elif level == "CANNOT_DETERMINE":
        needs = {"required": ["general_medicine"], "preferred": ["teleconsultation"]}
    else:
        needs = P["category_services"].get(category, P["category_services"]["general"])
    query = f"{category} care for: {', '.join(symptom_labels) or 'general check-up'}. Needs {', '.join(needs['required'] + needs['preferred']).replace('_', ' ')}"
    rel = retriever().scores(query)
    maxrel = max(rel.values()) or 1
    max_t = max(f["travel_time_min"] for f in facilities())

    eligible, excluded = [], []
    for f in facilities():
        fr, op = freshness(f, today), open_status(f, at)
        reasons, why_not = [], None
        svc = [s for s in needs["required"] if s in f["services"]]
        if not svc:
            why_not = f"Does not list {' / '.join(needs['required']).replace('_', ' ')}"
        elif level == "EMERGENCY" and not f["hours"].get("open_24x7"):
            why_not = "Not open 24x7 for emergencies"
        elif level == "URGENT_SAME_DAY" and f["level"] < 2:
            why_not = "Sub-centre or teleconsultation: a doctor should see this today"
        elif level == "URGENT_SAME_DAY" and not op["open_now"]:
            why_not = op["text"]
        elif f["type"].startswith("Teleconsultation"):
            why_not = "Teleconsultation is offered separately below" if level not in ("EMERGENCY", "URGENT_SAME_DAY") else "Teleconsultation is not enough for this urgency"
        if why_not:
            excluded.append({"id": f["id"], "name": f["name"], "reason": why_not, "freshness": fr["status"]})
            continue
        r = rel.get(f["id"], 0) / maxrel
        pref = 1.0 if any(s in f["services"] for s in needs["preferred"]) else 0.0
        prox = 1 - f["travel_time_min"] / max_t
        lang_ok = any(lang_name.lower().startswith(l.lower()) for l in f["languages"])
        if level == "EMERGENCY":
            score = 0.55 * prox + 0.2 * pref + 0.1 * r + 0.15 * fr["score"]
        else:
            # Care at the lowest level that can handle it, as close as possible.
            ideal = 3 if level == "URGENT_SAME_DAY" else 2
            score = (0.55 * prox + 0.15 * pref + 0.15 * fr["score"] + 0.1 * (1 if lang_ok else 0)
                     + 0.05 * r - 0.15 * max(0, f["level"] - ideal))
        if fr["status"] == "UNVERIFIED":
            score -= 0.5
        reasons.append(f"Offers {', '.join(svc).replace('_', ' ')}")
        if pref:
            reasons.append(f"Has preferred service: {', '.join(s for s in needs['preferred'] if s in f['services']).replace('_', ' ')}")
        reasons.append(f"{f['travel_time_min']} min by road ({f['distance_km']} km)")
        reasons.append(op["text"])
        if lang_ok:
            reasons.append(f"Staff speak {lang_name.split(' ')[0]}")
        eligible.append(_card(f, fr, op, score, r, reasons, lang_name))

    eligible.sort(key=lambda c: c["score"], reverse=True)
    primary = next((c for c in eligible if c["freshness"]["status"] != "UNVERIFIED"), None)
    alternatives = [c for c in eligible if not primary or c["id"] != primary["id"]][:3]
    tele = None
    if level in ("PROMPT_ROUTINE", "INFO_SELF_CARE", "CANNOT_DETERMINE"):
        t = next((f for f in facilities() if f["type"].startswith("Teleconsultation")), None)
        if t:
            tele = _card(t, freshness(t, today), open_status(t, at), 0, 0, ["Assisted video consultation, no long travel"], lang_name)
    warnings = []
    if primary and primary["freshness"]["status"] == "STALE":
        warnings.append("Top match has not been verified in the last 90 days. Call before travelling.")
    if primary and primary["provenance"]["conflicts"]:
        warnings.append("Sources disagree about this facility: " + primary["provenance"]["conflicts"][0])
    if primary and primary["referral_required"]:
        warnings.append("This facility usually needs a referral letter.")
    if not primary:
        warnings.append("No verified facility matches right now. Call 104 (health helpline) or ask your ASHA worker.")
    return {"needs": needs, "query": query, "retrieval": retriever().method, "primary": primary,
            "alternatives": alternatives, "teleconsult": tele, "excluded": excluded, "warnings": warnings,
            "assessed_at": at.isoformat(timespec="minutes")}
