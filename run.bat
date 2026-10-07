@echo off
REM Start RuralPulse locally on http://localhost:8000
cd /d %~dp0
if not exist .venv python -m venv .venv
call .venv\Scripts\activate
pip install -q -r requirements.txt
if not exist .env copy .env.example .env
python scripts\sync_data.py
echo RuralPulse running at http://localhost:8000
uvicorn backend.app.main:app --reload --port 8000
