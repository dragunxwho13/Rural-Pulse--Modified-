#!/usr/bin/env sh
# Start RuralPulse locally on http://localhost:8000
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
[ -f .env ] || cp .env.example .env
python scripts/sync_data.py >/dev/null
echo "RuralPulse running at http://localhost:8000"
exec uvicorn backend.app.main:app --reload --port 8000
