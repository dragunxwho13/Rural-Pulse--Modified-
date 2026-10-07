"""Import the pan-India doctors PDF into data/doctors.json.

    python scripts/import_doctors.py path/to/doctors.pdf

The PDF columns are: Company_Name, State, City, Pincode, Locality,
Sub_Locality, Address, Landmarks, StdCode, Validated_Remarks, LEVEL1-3
(specialty in LEVEL3), Mobile x3, Telephone x3, Email.

What this script does NOT do: it never invents a hospital affiliation.
`practice_or_hospital` is only filled when the address itself names one
(for example "C/O Hayat Hospital"). Coordinates are approximate city
centres; precise matching to real hospitals happens at runtime against
OpenStreetMap (backend/app/geo.py).
"""
import json
import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]

CITY = {
    "Mumbai": (19.076, 72.8777), "Jabalpur": (23.1815, 79.9864), "Indore": (22.7196, 75.8577), "Pune": (18.5204, 73.8567),
    "Bhopal": (23.2599, 77.4126), "Kanpur": (26.4499, 80.3319), "Lucknow": (26.8467, 80.9462), "Kolkata": (22.5726, 88.3639),
    "Meerut": (28.9845, 77.7064), "Guwahati": (26.1445, 91.7362), "Bangalore": (12.9716, 77.5946), "Goa": (15.5915, 73.8090),
    "Ahmedabad": (23.0225, 72.5714), "Gwalior": (26.2183, 78.1828), "Bhubaneswar": (20.2961, 85.8245), "Panchkula": (30.6942, 76.8606),
    "Chandigarh": (30.7333, 76.7794), "Chennai": (13.0827, 80.2707), "Ludhiana": (30.9010, 75.8573), "Agra": (27.1767, 78.0081),
    "Kolar": (13.1362, 78.1290), "Coimbatore": (11.0168, 76.9558), "Secunderabad": (17.4399, 78.4983), "Dhandhuka": (22.3810, 71.9850),
    "Kota": (25.2138, 75.8648), "Kamrup": (26.1580, 91.6930), "Delhi": (28.6139, 77.2090), "Dhule": (20.9042, 74.7749),
    "Surat": (21.1702, 72.8311), "Panna": (24.7176, 80.1819), "Nashik": (19.9975, 73.7898), "Nagpur": (21.1458, 79.0882),
    "Greater Noida": (28.4744, 77.5040), "Noida": (28.5355, 77.3910), "Ratlam": (23.3315, 75.0367), "Ghaziabad": (28.6692, 77.4538),
    "Gurgaon": (28.4595, 77.0266), "Bhiwadi": (28.2090, 76.8606), "Durg": (21.1904, 81.2849), "Rewa": (24.5362, 81.3037),
    "Sagar": (23.8388, 78.7378), "Hyderabad": (17.3850, 78.4867), "Navi Mumbai": (19.0330, 73.0297), "Jamshedpur": (22.8046, 86.2029),
    "Saharanpur": (29.9680, 77.5552), "Karnal": (29.6857, 76.9905), "Vellore": (12.9165, 79.1325), "Aurangabad": (19.8762, 75.3433),
}
# Localities far from their listed city centre
LOCALITY = {"Vaniyambadi": (12.6820, 78.6200), "Kanker Khera": (29.0050, 77.7550)}
# The PDF wraps words across lines without hyphens ("Cardiolog y"); undo the common ones.
JOIN = [("Cardiolog y", "Cardiology"), ("Orthopae dics", "Orthopaedics"), ("Dermatol ogy", "Dermatology"), ("Gynaecolo gy", "Gynaecology"),
        ("Paediatric s", "Paediatrics"), ("Nephrolog y", "Nephrology"), ("Gastroent erology", "Gastroenterology"), ("Neurologi st", "Neurologist"),
        ("Ophthalm ologist", "Ophthalmologist"), ("(Ey e", "(Eye"), ("Specialists )", "Specialists)"), ("Orthodon tics", "Orthodontics"),
        ("Dentofaci al", "Dentofacial"), ("Orthopae dician", "Orthopaedician"), ("Physiatrist s", "Physiatrists"), ("Psychologi sts", "Psychologists"),
        ("Maxillofac ial", "Maxillofacial"), ("Anaesthes iology", "Anaesthesiology"), ("Algologist s", "Algologists"), ("Endodonti cs", "Endodontics"),
        ("Treatmen t", "Treatment"), ("Osteopath y", "Osteopathy"), ("Neurosurg eon", "Neurosurgeon"), ("Reconstru ctive", "Reconstructive"),
        ("Compoun d", "Compound"), ("Dharamsh ila", "Dharamshila"), ("Shrikhand e", "Shrikhande"), ("Transplan t", "Transplant"),
        ("Sama rth", "Samarth"), ("Plolyclinic", "Polyclinic"), ("Kolwalkar' s", "Kolwalkar's"), ("Abhyanka r", "Abhyankar"),
        ("Apartmen t", "Apartment"), ("Pratishtha n", "Pratishthan"), ("Mangeshk ar", "Mangeshkar"), ("Marutha malai", "Maruthamalai")]
# Specialty -> RuralPulse care categories (what problems this doctor can help with)
SPEC = [("paediatric cardio", ["pediatric", "cardiac"]), ("dent", ["dental"]), ("orthodon", ["dental"]), ("maxillofac", ["dental"]),
        ("endodont", ["dental"]), ("paediatric", ["pediatric"]), ("cardio", ["cardiac"]), ("obstetric", ["maternal"]), ("gynae", ["maternal"]),
        ("test tube", ["maternal"]), ("orthopae", ["musculoskeletal", "injury"]), ("spine", ["musculoskeletal"]), ("osteopath", ["musculoskeletal"]),
        ("physiatr", ["musculoskeletal"]), ("algolog", ["musculoskeletal"]), ("dermatol", ["skin"]), ("cosmetic", ["skin"]),
        ("urolog", ["urinary"]), ("nephrolog", ["urinary"]), ("gastro", ["digestive"]), ("neurosurg", ["neuro", "injury"]), ("neuro", ["neuro"]),
        ("migraine", ["neuro"]), ("ophthalm", ["eye"]), ("eye", ["eye"]), ("psychiat", ["mental"]), ("psycholog", ["mental"]),
        ("ear, nose", ["ent"]), ("general surgery", ["injury", "digestive"]),
        ("general medicine", ["general", "respiratory", "digestive", "urinary", "tb", "musculoskeletal", "skin", "ent", "maternal", "pediatric", "mental"])]


def clean(s):
    s = re.sub(r"\s+", " ", (s or "").replace("\n", " ").replace("‐", "-")).strip(" ,")
    for a, b in JOIN:
        s = s.replace(a, b)
    return s


def affiliation(addr):
    m = re.search(r"c\s*/\s*o\.?\s*-?\s*([^,]+)", addr, re.I)
    aff = clean(m.group(1)) if m else None
    if not aff:
        for part in addr.split(","):
            p = clean(part)
            if re.search(r"hospital|clinic|polyclinic|centre|center|dispensary", p, re.I) and not re.match(r"(near|opp|before|behind|beside)", p, re.I):
                aff = re.sub(r"^\d+[\w/-]*\s*", "", p)
                break
    if aff and not re.search(r"(Hospital|Clinic|Centre|Center|Polyclinic|Plus|Wellness|Alo|Surge|Christian|Ltd|Building|Dispensary.*)$", aff):
        aff += " (name cut off in source)"
    return aff


def main(pdf_path):
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for r in table:
                    if r and r[0] and not r[0].startswith("Company"):
                        rows.append([clean(c) for c in r])
    out = []
    for i, r in enumerate(rows):
        r = r + [""] * (20 - len(r))
        name, state, city, pin, loc, _sub, addr, land, _std, valid, _l1, _l2, l3 = r[:13]
        spec = re.sub(r"^Doctors-\s*", "", l3).replace("Dental Clinic/ Dentist", "Dental Clinic / Dentist")
        cats = next((v for k, v in SPEC if k in (spec + " " + name).lower()), [])
        lat, lon = LOCALITY.get(loc) or CITY.get(city, (None, None))
        phones = [x for x in r[13:19] if x]
        out.append({
            "id": f"DOC-{i + 1:03d}", "name": name, "specialty": spec, "categories": cats,
            "city": city, "state": state, "pincode": pin, "locality": loc, "address": addr, "landmark": land,
            "practice_or_hospital": affiliation(addr), "phone": phones[0] if phones else None, "phones": phones,
            "email": r[19].replace(" ", "") or None, "lat": lat, "lon": lon,
            "location_precision": ("locality (approximate)" if loc in LOCALITY else "city centre (approximate)") if lat else "unknown",
            "source_flag": valid, "nmc_verified": False,
        })
    doc = {"dataset": "Pan-India doctors listing (user-provided PDF)", "count": len(out),
           "note": "Listings as provided. Marked 'Valid Data' by the source but NOT verified against the NMC registry. "
                   "Coordinates are approximate city centres. Hospital affiliation is only shown where the source address names one; "
                   "RuralPulse never invents affiliations. Call before visiting.",
           "doctors": out}
    path = ROOT / "data" / "doctors.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(out)} doctors ({sum(1 for d in out if d['practice_or_hospital'])} with a named practice) -> {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__))
