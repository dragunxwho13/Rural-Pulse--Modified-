# API

The base URL is the server root. Interactive docs are at **`/docs`** (Swagger) once the server is running.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/meta` | Version, protocol version, whether the LLM is enabled, languages, emergency numbers |
| GET | `/api/protocol` | Red-flag rules and decision table |
| GET | `/api/facilities?at_time=2026-10-07T22:00` | Directory with freshness and open-now status |
| POST | `/api/interpret` | Step 1: understanding, red-flag screen, read-back, questions |
| POST | `/api/assess` | Step 2: decision, navigation, summary, audit |
| GET | `/api/eval` | Runs the safety suite and returns metrics and cases |
| GET | `/api/doctors` | Doctors listing (from the PDF) |
| POST | `/api/translate` | `{texts[], lang}` → Gemini translation (or originals with `engine: "none"`) |
| GET | `/api/osm/nearby?lat&lon&radius&dental` | Overpass proxy (cached): hospitals, clinics, doctors, pharmacies (+ dentists) |
| GET | `/api/osm/geocode?q=` / `/api/osm/reverse?lat&lon` | Nominatim proxy (village, town, 6-digit PIN) |
| GET | `/api/osm/route?from_lat&from_lon&to_lat&to_lon` | OSRM proxy with alternatives (the browser picks fastest / main-road) |
| POST | `/api/auth/otp` · `/api/auth/verify` · GET `/api/auth/me` | Phone + OTP login for ASHA / doctor / pharmacy (`demo_otp` returned when no SMS gateway) |
| POST | `/api/cases` | Notify a facility (optional ASHA bearer token). Body: level, symptoms, red_flags, lang, age, vitals, prep, facility{key,name,…}, slot |
| GET | `/api/cases?facility=` · PATCH `/api/cases/{id}` | Dashboard list / status (`seen`, `preparing`, `ready`, `done`), doctor login required |
| POST | `/api/rx` · GET `/api/rx/{id}?lang=` · PATCH `/api/rx/{id}` | Prescriptions (doctor login), public medicine card (phone removed), pharmacy status |
| GET | `/api/outbox` | SMS outbox (staff) |
| GET | `/api/events?facility=KEY&token=` | Server-sent events. Staff: cases/prescriptions. Public `case:ID` / `rx:ID`: status only |
| WS | `/api/live?lang=` | Live voice: 16 kHz PCM in, 24 kHz PCM out, JSON events (`user_text`, `ai_text`, `red_flag`, …) |

## POST /api/interpret
```json
{ "message": "3 din se bukhar aur khansi hai", "language": "auto", "mode": "patient",
  "answers": {}, "vitals": {"spo2": null, "temp_c": null}, "at_time": "2026-10-07T11:00", "consent_store": false }
```
The response has `stage` set to either `"confirm"` or `"emergency"`.
- `confirm` returns `interpretation_id`, `readback`, `questions[]`, `interpretation`, `symptom_options[]`.
- `emergency` returns a full result (same shape as `/api/assess`).

## POST /api/assess
The same fields as interpret, plus:
```json
{ "interpretation_id": "IN-…", "answers": {"age": 34, "duration_days": 3, "redflag_screen": "no"},
  "symptom_ids": null, "confirmed": true }
```
Response fields:
- `urgency{level,key,title,action}`
- `decision{rules_fired[],abstain_reasons[],abstain_text[],notes[],risk_factors[],human_review,category}`
- `interpretation`
- `navigation{primary,alternatives[],teleconsult,excluded[],warnings[],retrieval}`
- `summary{doctor,doctor_text,checklist[],questions_for_doctor[],sms}`
- `audit{…}`

Answer keys:
- `age`: years.
- `duration_days`
- `severity`: 1–10.
- `pregnant`: yes / no / na.
- `chronic`: yes / no.
- `redflag_screen`: yes / no.

## v3.1 endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` | Public view: `gemini_key_set`, masked key, model names, map service URLs, tile URL. Never returns the key. |
| POST | `/api/settings` | `{gemini_key?, overpass_url?, nominatim_url?, osrm_url?, tile_url?, tile_attribution?, save}`. Localhost only (403 otherwise) unless `RP_ALLOW_REMOTE_SETTINGS=1`. A key is tested with Gemini before it is applied. |
| POST | `/api/voice/turn` | `{audio_b64, mime:"audio/wav", history, ui_lang}` → `{ok, language_code, language_name, transcript, english_gist, reply, red_flag?}`. Gemini detects the language and replies in it. |
| POST | `/api/voice/turn_text` | `{text, history, ui_lang}`: the same, for typed text. |
| POST | `/api/voice/tts` | `{text}` → `{ok, pcm_b64, rate:24000}` (Gemini TTS, mono PCM16). |
| POST | `/api/demo/simulate` | Staff token. A doctor gets a simulated multilingual referral to their facility. A pharmacy gets a simulated prescription. |
| POST | `/api/demo/reset` | Staff token. Clears cases, prescriptions and the outbox, then reloads the sample reports. |
