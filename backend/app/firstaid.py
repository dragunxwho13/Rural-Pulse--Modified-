"""
"Do this now" cards: safe first steps while the patient travels or waits.

Plain first-aid principles only: no medicines, no doses, no diagnosis.
Cards are picked from the red flags that fired (emergencies) or the
recognised symptoms (everything else), and shown in the patient's
language when a translation exists (fallback chain otherwise; the website
can ask /api/translate for the rest).
"""
from typing import Dict, List

from .protocol import first_aid_doc, pick, pick_lang, prep_doc


def _key(k: str) -> str:
    doc = first_aid_doc()
    if k in doc["items"]:
        return k
    return doc["aliases"].get(k, "")


def keys_for(level: str, flags: List[Dict], symptoms: List[str], pregnant: bool) -> List[str]:
    keys: List[str] = []
    if level == "EMERGENCY":
        keys += [_key(f["id"]) for f in flags]
        keys.append("EMERGENCY")
    else:
        keys += [_key(s) for s in symptoms]
        if pregnant:
            keys.append("pregnancy")
        if level == "CANNOT_DETERMINE" or not any(keys):
            keys.append("general")
    out = []
    for k in keys:
        if k and k not in out:
            out.append(k)
    return out[:3]


def cards(level: str, flags: List[Dict], symptoms: List[str], pregnant: bool, lang: str) -> List[Dict]:
    items = first_aid_doc()["items"]
    out = []
    for k in keys_for(level, flags, symptoms, pregnant):
        it = items[k]
        out.append({"key": k, "lang": pick_lang(it["title"], lang), "title": pick(it["title"], lang),
                    "do": [pick(x, lang) for x in it["do"]], "dont": [pick(x, lang) for x in it["dont"]]})
    return out


def prep_for_clinician(flags: List[Dict], symptoms: List[str], pregnant: bool) -> List[str]:
    items = prep_doc()["items"]
    keys = [f["id"] for f in flags] + list(symptoms) + (["pregnancy"] if pregnant else [])
    out: List[str] = []
    for k in keys:
        for line in items.get(k, []):
            if line not in out:
                out.append(line)
    return out[:8] or items["general"]
