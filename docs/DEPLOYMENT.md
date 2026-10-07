# Deployment

## Option A: Render (full app, recommended)
1. Push this folder to GitHub.
2. On Render choose **New → Blueprint** and pick the repo. `render.yaml` sets the build and start commands and the health check.
3. Set **GOOGLE_API_KEY** (optional: AI, translation, voice) and **RP_PUBLIC_URL**. For example, `https://ruralpulse.onrender.com` makes SMS medicine-card links absolute.
4. Open `/` for patients and `/doctor.html` for doctors.

Notes:
- Free instances sleep when idle. Open the URL a minute before presenting.
- The free disk is temporary: cases and prescriptions (SQLite) reset on redeploy. For a pilot, use a persistent disk or a managed database.
- WebSockets (voice) and server-sent events (live alerts) work on Render.

## Option B: Docker (any VM, Railway, Fly.io, Cloud Run)
```bash
docker build -t ruralpulse .
docker run -p 8000:8000 --env-file .env -v $(pwd)/logs:/app/logs ruralpulse
```

## Option C: static only (Netlify, Vercel, GitHub Pages)
Publish `frontend/` (the configs are included). What works: the offline triage in every tier, first aid, the slip, and the map and routes (the browser calls Overpass/OSRM directly). What doesn't: doctor notifications, the dashboard, medicine cards, live voice and translation, because they need the server.

## Option D: hackathon laptop
`./run.sh` or `run.bat`. To reach the dashboard or app from phones on the same Wi-Fi:
```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```
Browsers only allow microphone and GPS on **https** or **localhost**. On a phone over plain http, those two features need a tunnel such as `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`. Typing and the place search work everywhere.

## Configuration (see `.env.example`)
| Variable | Purpose |
|---|---|
| `GOOGLE_API_KEY` | Gemini: AI-assisted languages, translation, live voice |
| `RP_LIVE_MODEL` | Gemini Live native-audio model name. Check ai.google.dev for the current one |
| `RP_PUBLIC_URL` | Absolute links in SMS |
| `RP_SMS_PROVIDER`, `MSG91_*`, `TWILIO_*` | Real SMS. India requires a DLT-registered template for MSG91 |
| `RP_DEMO_OTP` | `1` shows login codes on screen when no SMS gateway is set. **Set `0` in production** |
| `RP_AUTH_SECRET` | Signs staff login tokens |
| `RP_OVERPASS_URL`, `RP_NOMINATIM_URL`, `RP_OSRM_URL` | Point at your own OSM services for real traffic (the public ones have fair-use limits) |

## Keeping the demo directory "fresh"
Freshness is computed against today's date: VERIFIED up to 90 days, STALE up to 180, UNVERIFIED after that. If you present much later, update `last_verified` in `data/facilities.json`. Keep `MH-011` old and `CARD-002` at about 100 days so the stale examples still show. Then run `python scripts/sync_data.py`.

## Updating the doctors listing
```bash
pip install pdfplumber
python scripts/import_doctors.py path/to/doctors.pdf
python scripts/sync_data.py
```
