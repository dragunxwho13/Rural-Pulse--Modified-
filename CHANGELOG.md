# Changelog

## 3.1.2: Hackathon-stable voice
Changed
- **Language switch beside "Talk to RuralPulse"** on the landing page, and beside the mic on the check screen: English · हिन्दी · தமிழ் · +19 more.
- **Voice assistant runs in English, Hindi and Tamil with no API key.** It uses browser speech: a guided conversation, read-back, danger-sign question, age, verdict and first aid, with the instant 108 banner. Gemini any-language voice is kept but switched off. Set `RP_VOICE_AI=1` and add a key to turn it back on later. `RP_VOICE_LANGS` sets the voice languages.
- Clear messages for a blocked mic, no internet for speech recognition, and silence. Listening retries automatically on silence.

## 3.1.1: Gemini model auto-selection
Fixed
- **"404 NOT_FOUND … gemini-2.5-flash is no longer available to new users".** RuralPulse no longer hard-codes model names:
  - `backend/app/gemini_models.py` lists the models the key can use and ranks them. Text uses `gemini-flash-latest`, then the newest stable Flash model. Live and TTS each use their newest model.
  - Every Gemini call (understanding, translation, voice turns, TTS, embeddings, Live) skips a retired model on 404 and moves to the next one.
  - The ⚙ key test reports which models were chosen.
  - Old model names left in `.env` are tried first, then skipped if retired.
- Clearer key errors: invalid key, API not enabled, region, quota. A key that has hit its quota is still accepted.

## 3.1.0: Settings, any-language voice, live demos, real-time map
Added
- **⚙ Settings sheet:** Gemini API key (tested, masked, applied without restart, optional save to `.env`), map tile presets and custom OpenStreetMap service URLs. Localhost-only unless `RP_ALLOW_REMOTE_SETTINGS=1`.
- **Any-language voice:**
  - Gemini Live answers in the language spoken.
  - New Gemini turn mode (`/api/voice/turn`, `/api/voice/turn_text`) detects any language.
  - Gemini TTS (`/api/voice/tts`) for languages the phone cannot speak.
  - Offline guided voice conversation in the chosen language.
- **Live demo data:**
  - Sample cases and medicine cards are seeded on first start.
  - Stats strip.
  - Simulate patient or prescription, with auto mode.
  - Reset demo data.
  - District preview for empty facilities.
  - Sample list on `rx.html`.
- **Real-time map:**
  - Live GPS follow with re-ranking and route refresh.
  - Re-centre and full-screen controls.
  - Auto-locate.
  - Resize handling.
- **Real-time site:**
  - Online/offline indicator with auto reconnect.
  - Dashboard SSE back-off and polling fallback.
  - Ticking relative times.
  - Stale-while-revalidate service worker.

## 3.0.0: Multilingual care network (hackathon day)
Added
- **22 scheduled languages + English** with tiers:
  - 3 tested languages.
  - 11 offline-draft languages with lexicon, native digits, number words and full UI/messages.
  - 9 AI-assisted languages.
- A first-screen language picker.
- **Nearest care on OpenStreetMap:**
  - GPS or village/PIN search, plus a Leaflet map.
  - Government-first ranking, and hospitals only for emergencies.
  - **Fastest and main-road routes** (OSRM), and a Navigate deep link.
- **Doctors listing** imported from the pan-India PDF. It matches doctors by distance and specialty, and links to a map hospital only when the listing names it.
- **Doctor/pharmacy dashboard:**
  - Phone + OTP login.
  - Live alerts (SSE, sound, notifications) and a clinician prep list.
  - Case status visible to the patient live.
  - Slot booking.
- **Medicine cards** in the patient's language, with pictograms, read-aloud, .ics reminders, pharmacy reservation and ready-for-pickup.
- An **SMS layer** (MSG91/Twilio) with a demo outbox.
- **Live voice assistant** (Gemini Live native audio, server WebSocket), with red-flag monitoring of the transcript and a basic-voice fallback.
- **"Do this now"** first-aid cards: do and don't steps, no medicines.
- A **one-page visit slip** in the patient's language, with print via an isolated frame (no blank pages) and WhatsApp/SMS share.
- A decluttered 3-screen app with a body map and symptom icons, an always-visible 108 button and emergency location sharing.
- 50-case safety suite (9 multilingual cases), 34 tests, an extended engine parity check and node tests for the map logic.

Changed
- Protocol `RP-PROTOCOL-1.1-demo`. The evaluation view no longer shows by-language / by-case-type bars.

## 2.0.0: Safety-first rebuild
Deterministic red flags, abstention, read-back, verified directory with provenance, offline engine, 3D site.

## 1.0.0: Kaggle capstone
Notebook demo with three Gemini agents.
