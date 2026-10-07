# Architecture

## Principle
Safety-critical policy (urgency, escalation, abstention) is **deterministic and versioned**. Language models are optional helpers for understanding words. The model can only **add** concepts, and anything it adds can only **escalate**.

## Request flow
1. `POST /api/interpret`
   - `extract.extract()` (lexicon) and `language.detect()` run on the raw text.
   - `triage.red_flags()` runs on the raw text. **Any hit returns a full EMERGENCY result immediately; the LLM is not called.**
   - Otherwise `llm.interpret()` runs, if a key is set: Gemini with a Pydantic `response_schema`, the fixed concept list, temperature 0, a 12-second timeout and a fallback.
   - The rule and LLM outputs are merged as a union. Red flags are re-evaluated on the merged concepts.
   - The response is a read-back plus clarifying questions, and the interpretation is cached by id.
2. `POST /api/assess`
   - The cached interpretation, the patient's answers and edits, and any vitals are merged in `pipeline._facts()`. Red-flag concepts can't be removed by edits.
   - `triage.decide()` applies the decision table in order: red flags, then abstention (language / no symptom / dose / missing info), then the same-day rules, then the routine and self-care rules, then the risk modifier.
   - `navigation.navigate()` applies structured filters, then hybrid ranking, then provenance, warnings and exclusions.
   - `summary.build()` produces the doctor note, checklist, questions and SMS.
   - `audit.record()` writes the de-identified log entry.

## Navigation ranking
- Filters:
  - The facility must offer a required service.
  - For an emergency it must be open 24x7.
  - For same-day care it must be at least PHC level and open now.
  - Teleconsultation is offered separately, not as a primary facility.
- Score for non-emergencies: `0.55·proximity + 0.15·preferred service + 0.15·freshness + 0.10·language match + 0.05·relevance − 0.15·(level above ideal)`.
- Score for emergencies: `0.55·proximity + 0.20·preferred service + 0.10·relevance + 0.15·freshness`.
- Unverified records (more than 180 days old) take a −0.5 penalty and are never primary.
- Relevance comes from `gemini-embedding-001` when a key is set, and TF-IDF otherwise.

## Offline engine
`frontend/assets/js/engine.js` is a line-by-line port driven by the same JSON files. `scripts/parity_check.js` plus the Python suite confirm identical urgency, facility and rules on all vignettes. The website uses the server when `/api/meta` answers, and the browser engine otherwise. The service worker caches the site and data, so emergency screening works with no network.

## Data
- `data/protocol.json` holds the version, emergency numbers, supported languages, script ranges, the concept lexicon (en/hi/ta, script + romanised), red flags, the decision rules, category-to-service mapping and localised patient messages.
- `data/facilities.json` holds synthetic records with service lists, hours, level, travel time, map coordinates, languages, provenance and conflicts.
- `data/eval/vignettes.json` holds 41 synthetic safety cases.

## v3 additions
- **Languages:** `protocol.json → supported_languages` defines 23 languages with a tier, fallback chain, speech code and script. `language.py` detects the script and then picks within the script family using unique characters (ৰ for Assamese, ڪ for Sindhi), marker words and lexicon hits. Native digits are normalised.
- **Strings:** `i18n.json` holds the UI, slip and medicine-card labels for 14 full packs. Assisted-tier languages fall back through the chain (e.g. kok → mr → hi → en). Gemini translates free text on request.
- **Maps:** `geo.py` proxies Overpass, Nominatim and OSRM with caching. All ranking lives in `frontend/assets/js/geo.js` (tested with node), so the static deployment behaves identically.
- **Cases:** `cases.py` uses SQLite with an in-process pub/sub hub. Dashboards subscribe with SSE (`/api/events`). Prescriptions publish to the pharmacy and the patient's card. SMS goes through MSG91/Twilio, or an outbox.
- **Voice:** `live.py` bridges a browser WebSocket to `client.aio.live.connect()`, using native audio with affective dialog (retrying without it if unsupported) and input/output transcription. Every transcript chunk runs through `triage.red_flags`.
