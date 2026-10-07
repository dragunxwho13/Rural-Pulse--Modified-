# RuralPulse

**The right care, in your language.** A person (or their ASHA worker) speaks or types a health problem in any of the **22 scheduled languages of India or English**. RuralPulse then:

1. **Checks for danger signs first.** It uses deterministic rules that work offline. If a danger sign matches, it shows *Call 108* at once.
2. **Says how urgent it is** (emergency, today, 2-3 days, self-care, or *"I can't safely decide"*) and **what to do right now** (safe first-aid steps, no medicines).
3. **Finds the nearest suitable health centre** on OpenStreetMap. Government and free care come first, and emergencies go to hospitals only. It draws the **fastest** and the **main-road (safer)** route and adds a one-tap *Navigate* button.
4. **Suggests doctors** from the pan-India doctors listing in the patient's area, by specialty.
5. **Notifies the nearest doctor live.** The doctor's dashboard rings with the symptoms, vitals and a preparation list, so medicines and equipment are ready before the patient arrives.
6. **Delivers the doctor's prescription as a medicine card** in the patient's language, with pictures (☀️ 🌤️ 🌙, before/after food), audio and phone reminders. The nearest pharmacy can reserve the medicines.
7. Prints a **one-page visit slip** in the patient's language, with a short English block for the doctor.

RuralPulse **never diagnoses and never chooses medicines or doses.** Only the doctor's prescription does that.

> Hackathon prototype, not a medical device. Demo directory facilities and pharmacies are fictional. OpenStreetMap places and the doctors listing are real-world data that RuralPulse has **not verified**, and they are labelled that way everywhere. The helplines 108, 112, 104, 14416 and 14555 are real.

---

## Quick start (2 minutes)

```bash
./run.sh          # macOS / Linux
run.bat           # Windows
```
Then open:
- **http://localhost:8000**: patient / ASHA app
- **http://localhost:8000/doctor.html**: doctor and pharmacy dashboard (phone + OTP login; in demo mode the code is shown on screen)

No keys are needed. To turn on AI understanding for the 9 AI-assisted languages, translation of free text, and the **any-language voice assistant**, click **⚙ (top bar) → paste a free Gemini key → Apply**. The key is tested with Google, the newest Gemini models your key can use are picked automatically (retired names like `gemini-2.5-flash` are skipped), applied at once (no restart), and saved to `.env` if you tick *Remember*. The same sheet lets you change the map style and the OpenStreetMap services (Overpass, Nominatim, OSRM). For safety, settings can only be changed from the computer running the server (`http://localhost:8000`), unless `RP_ALLOW_REMOTE_SETTINGS=1`. You also need internet for the map, the routes and the Google fonts.

Checks:
```bash
python -m pytest -q                 # 47 tests: safety, navigation, languages, notifications, prescriptions, privacy, settings, demo data, voice
python evaluation/run_eval.py       # safety metrics on the 50-case vignette suite
node tests/geo.test.js              # map ranking, doctor matching, route choice
```

---

## Voice (hackathon setting)
The **Talk to RuralPulse** assistant works in **English, Hindi and Tamil with no API key**, using the browser's speech recognition and voice. Use Chrome or Edge, allow the microphone, and stay online: Chrome's speech recognition uses Google's servers. Pick the language with the **English · हिन्दी · தமிழ்** switch beside the Talk button. The any-language Gemini voice is built in but switched off (`RP_VOICE_AI=1` turns it on).

## v3.1 changes

| # | Request | What was built |
|---|---|---|
| 1 | Key inputs for OpenStreetMap and Gemini | **⚙ Settings** sheet: Gemini key (tested live, masked, never sent back to the browser), map style presets (OSM, OSM Humanitarian, CARTO Voyager, custom tile URL) and advanced Overpass / Nominatim / OSRM endpoints. Applies instantly without a restart. Optional save to `.env`. |
| 2 | Voice that understands and answers in whatever language is spoken | **Gemini Live** is told to answer in the language heard and to switch when the person switches. If Live is not enabled on the key, it automatically falls back to **Gemini turn mode**: it records until you stop talking, Gemini detects the language (including Hinglish and Tanglish), transcribes it and replies in the same language. The reply is spoken by the phone, or by **Gemini TTS** when the phone has no voice for that language. **Offline / no key:** the browser recogniser in the language chosen from *"I will speak in"* (browsers cannot auto-detect), and a guided conversation in that language: read-back → danger-sign question → age → verdict + first aid. The red-flag rules check every word in every mode. |
| 3 | Dashboards never blank | 8 realistic **sample reports** (Hindi, Tamil, Bengali, Telugu, Marathi, Urdu, English) and 3 sample medicine cards are loaded on first start (`RP_SEED_DEMO=1`), marked *sample*. A **stats strip** (emergency, same day, waiting, preparing, done). **▶ Simulate incoming patient** (or prescription, for pharmacies), with *Auto every 45 s* for a live demo, and **↺ Reset demo data**. A facility with no cases yet shows the district's recent reports. `rx.html` without an id lists sample cards. |
| 4 | Real-time map and site | **📡 Live GPS** follows the person (`watchPosition`): the marker and accuracy circle move, the list re-ranks as you move, results reload after 3 km, and the active route redraws. ◎ re-centre and ⛶ full-screen map. The map auto-locates if location was already allowed, and resizes with the window. The online/offline dot re-checks the server every 20 s and reconnects. The dashboard live stream reconnects with back-off, falls back to polling, and relative times tick every 30 s. The service worker is now stale-while-revalidate, so updates show on the next load. |

## The 11 requested changes (v3.0), and where they are

| # | Request | What was built |
|---|---|---|
| 1 | Prescription in the patient's language | The doctor writes a structured prescription on the dashboard. The patient gets a **medicine card** (`rx.html`) where every label, the timing pictograms and the read-aloud text are in their language (14 languages built in). The doctor's free-text notes are translated by Gemini when a key is set, otherwise shown with a clear note. |
| 2 | 22 Indian languages for symptoms | All **22 scheduled languages + English** with honest tiers. **3 tested** (en/hi/ta), **11 offline-draft** (bn, te, mr, gu, kn, ml, pa, or, ur, as, ne) with an offline vocabulary, native digits, number words and full screens, and **9 AI-assisted** (mai, kok, doi, brx, sa, ks, sd, mni, sat). The language picker is the first screen, with names in their own scripts. Dictation and read-aloud use each language's speech code. |
| 3 | Clean slip, no blank pages | A new **one-page, prescription-style visit slip** in the patient's language. It prints through an isolated frame, so exactly one A4 page comes out (verified by PDF page count). It has WhatsApp/SMS share and an editable English note for the doctor. |
| 4 | Ask location, nearest centre, fast + safe routing | *Use my location* (GPS) or a typed village / town / PIN code. Health centres and pharmacies come live from **OpenStreetMap (Overpass)**, ranked for the triage result. **OSRM** routes are drawn as the **fastest route** and a **main-road route** (most distance on NH/SH highways, at most 30% slower), with a one-tap *Navigate* deep link to Google Maps. |
| 5 | Remove the screenshot panel | The by-language / by-case-type bars are gone from the evaluation. |
| 6 | txt improvements + better UI/UX | Voice-first big mic, a language picker as the first screen, a body map and symptom icons, 3 screens, big buttons, an always-visible **108 button**, *share my location* for emergencies, government/free care first, the Ayushman Bharat 14555 hint, phone + OTP login for staff (no sign-up for patients), slot booking, the prescription-to-pharmacy reservation with ready-for-pickup SMS, medicine reminders (.ics alarms), the SMS/WhatsApp fallback, an offline PWA, and low-bandwidth mode. |
| 7 | Doctors dataset, mapped to hospitals | `scripts/import_doctors.py` parses the PDF into `data/doctors.json` (99 listings, specialty mapped to care categories). Doctors near the patient are suggested by distance (or PIN prefix) and relevance. A doctor is **linked to a hospital on the map only when the listing itself names that hospital** and the name matches an OSM place. Nothing is invented. |
| 8 | ASHA registers, nearest doctor notified to prepare | The ASHA (phone + OTP) taps *Notify the nearest doctor*. The case goes to the chosen facility, and the doctor dashboard gets a **live alert** (server-sent events, sound and browser notification) with the patient's words, symptoms, vitals and a **suggested prep list** (for example anti-snake venom or anti-rabies vaccine stock). The patient sees live status: seen → preparing → ready. |
| 9 | Live voice assistant | **Talk to RuralPulse** uses the **Gemini Live API** (native audio model: expressive, natural, can be interrupted) through a server WebSocket. The key stays on the server. Every transcribed sentence goes through the red-flag rules, and a danger sign shows the 108 banner immediately. Without a key it falls back to basic browser voice. |
| 10 | Quick things to do while reaching care | **"Do this now"** cards: do and don't steps for each danger sign and common symptom (chest pain, breathing, fits, stroke, bleeding, snake bite, poisoning, burns, pregnancy, fever, loose motions, animal bite…). They contain first aid only, never medicines, are read aloud, and come in en/hi/ta plus key cards in all 11 offline-draft languages. |
| 11 | Less clutter | The patient sees only: describe → confirm → result with 4 tabs (*Do this now / Nearest care / Visit slip / Why*). Everything for judges (rules, languages, data sources, evaluation, evidence) sits in tabs and collapsed sections lower down. |

---

## Safety design (unchanged principles, from `docs/evidence_review.md`)

- Red flags run on the raw words **before** any AI. Emergencies bypass the model.
- The AI can only **add** symptoms and **escalate**. It can never lower urgency or remove a danger sign, and patient edits can't either.
- The system **abstains** for untested languages, missing age or duration, unrecognised input and medicine-dose questions.
- Prompt injection ("ignore previous instructions…") is detected and logged.
- Data is labelled by trust level: *verified directory* (with dates) vs *OpenStreetMap (not verified)* vs *doctors listing (not NMC-verified)*.
- Privacy: raw text is stored only with consent; the audit log is de-identified; public status streams show status only; phone numbers are masked on dashboards.

### Safety-suite results (rules-only, 50 synthetic cases, pending clinician review)
- Red-flag sensitivity: 94.7%
- Over-triage: 0%
- Correct abstention: 100%
- Facility match: 100%
- Multilingual cases: 9 of 9

The one miss is the documented atypical-cardiac case (EM-15).

---

## Architecture

```
Patient / ASHA (voice or text, 23 languages)          Doctor / pharmacy dashboard
   │                                                        ▲ live events (SSE)
   ├─► red-flag rules on raw words ──► EMERGENCY + first aid + 108
   ├─► language tier → offline lexicon (+ Gemini, add-only)
   ├─► read-back + targeted questions
   ├─► versioned urgency protocol (or abstain)
   ├─► first-aid cards · visit slip · English referral note
   ├─► OpenStreetMap: nearby centres (gov first) ─► OSRM fastest + main-road route
   ├─► doctors listing near the patient (by specialty)
   └─► notify facility ──► case ─► prep list ─► prescription ─► medicine card (patient language) + pharmacy reservation + SMS
```

The same JSON data (`data/*.json`) drives the Python server and the in-browser offline engine (`frontend/assets/js/engine.js`). A parity test checks they agree on all 50 vignettes and 21 multilingual samples.

## Repository layout
```
backend/app/
  main.py          API routes (+ /api/live websocket, /api/events SSE)
  pipeline.py      coordinator          triage.py   rules + abstention      language.py  23-language detection
  extract.py       offline extraction   firstaid.py "do this now" + prep    summary.py   slip + referral note
  geo.py           OpenStreetMap proxy  cases.py    cases, OTP, SMS, Rx     live.py      Gemini Live voice bridge
  translate.py     Gemini translation   llm.py      Gemini understanding    navigation.py verified directory
data/              protocol.json (rules, lexicon, messages) · i18n.json (UI, 14 packs) · first_aid.json · prep.json
                   facilities.json (demo directory + pharmacies) · doctors.json (from the PDF) · eval/vignettes.json
frontend/          index.html (patient/ASHA) · doctor.html (dashboard) · rx.html (medicine card)
                   assets/js: engine.js geo.js where.js voice.js slip.js app.js doctor.js rx.js scene.js
scripts/           import_doctors.py · sync_data.py · parity_check.js · parity_compare.py
tests/             pytest suite + geo.test.js + fixtures (synthetic Overpass/OSRM responses)
docs/              DEMO_SCRIPT · PITCH · DEPLOYMENT · ARCHITECTURE · API · SAFETY_CASE · evidence_review · source PDF
```

## Deploy
See `docs/DEPLOYMENT.md`. In short: use Render (`render.yaml`) or Docker for the full app. A static host (`frontend/`) gives the offline check, the map and routes, but no notifications, voice or medicine cards.

## License
MIT. Leaflet (BSD-2) and three.js (MIT) are vendored. Map data © OpenStreetMap contributors (ODbL).
"# Rural-Pulse--Modified-" 
