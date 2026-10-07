"""Runtime configuration, read from environment variables (see .env.example)."""
import os
from pathlib import Path

try:  # optional: load a local .env during development
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:  # pragma: no cover
    pass

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("RP_DATA_DIR", ROOT / "data"))
FRONTEND_DIR = Path(os.getenv("RP_FRONTEND_DIR", ROOT / "frontend"))
LOG_DIR = Path(os.getenv("RP_LOG_DIR", ROOT / "logs"))

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "").strip()
USE_LLM = os.getenv("RP_USE_LLM", "1") == "1" and bool(GOOGLE_API_KEY) and "your_" not in GOOGLE_API_KEY
# Model names are only starting points: gemini_models.py lists what the key can use and picks the newest.
_ENV_LLM_MODEL = os.getenv("RP_LLM_MODEL") or None
LLM_MODEL = _ENV_LLM_MODEL or "gemini-flash-latest"
_ENV_EMBED_MODEL = os.getenv("RP_EMBED_MODEL") or None
EMBED_MODEL = _ENV_EMBED_MODEL or "gemini-embedding-001"
LLM_TIMEOUT_S = float(os.getenv("RP_LLM_TIMEOUT", "15"))
USE_EMBEDDINGS = os.getenv("RP_USE_EMBEDDINGS", "1") == "1" and USE_LLM

TIMEZONE = os.getenv("RP_TZ", "Asia/Kolkata")
AUDIT_LOG = os.getenv("RP_AUDIT_LOG", "1") == "1"
AUDIT_SALT = os.getenv("RP_AUDIT_SALT", "change-me-in-production")
CORS_ORIGINS = [o.strip() for o in os.getenv("RP_CORS_ORIGINS", "*").split(",") if o.strip()]

# Facility freshness thresholds (days since last verification)
FRESH_DAYS = int(os.getenv("RP_FRESH_DAYS", "90"))
STALE_DAYS = int(os.getenv("RP_STALE_DAYS", "180"))

# ---- v3: maps, notifications, voice
OVERPASS_URL = os.getenv("RP_OVERPASS_URL", "https://overpass-api.de/api/interpreter")
NOMINATIM_URL = os.getenv("RP_NOMINATIM_URL", "https://nominatim.openstreetmap.org")
OSRM_URL = os.getenv("RP_OSRM_URL", "https://router.project-osrm.org")
HTTP_USER_AGENT = os.getenv("RP_USER_AGENT", "RuralPulse/3.0 (hackathon prototype; contact: set RP_USER_AGENT)")
DB_PATH = Path(os.getenv("RP_DB_PATH", ROOT / "logs" / "ruralpulse.db"))
PUBLIC_URL = os.getenv("RP_PUBLIC_URL", "").rstrip("/")        # used in SMS links, e.g. https://ruralpulse.onrender.com
DEMO_OTP = os.getenv("RP_DEMO_OTP", "1") == "1"                 # show the OTP on screen when no SMS gateway is set
AUTH_SECRET = os.getenv("RP_AUTH_SECRET", AUDIT_SALT + "-auth")
SMS_PROVIDER = os.getenv("RP_SMS_PROVIDER", "").lower()          # "", "msg91" or "twilio"
MSG91_AUTH_KEY = os.getenv("MSG91_AUTH_KEY", "")
MSG91_SENDER = os.getenv("MSG91_SENDER", "RPULSE")
MSG91_TEMPLATE_ID = os.getenv("MSG91_TEMPLATE_ID", "")
TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM = os.getenv("TWILIO_FROM", "")
_ENV_LIVE_MODEL = os.getenv("RP_LIVE_MODEL") or None
LIVE_MODEL = _ENV_LIVE_MODEL or "gemini-2.5-flash-native-audio-preview-12-2025"
LIVE_VOICE = os.getenv("RP_LIVE_VOICE", "Aoede")
_ENV_TTS_MODEL = os.getenv("RP_TTS_MODEL") or None
TTS_MODEL = _ENV_TTS_MODEL or "gemini-2.5-flash-preview-tts"
TILE_URL = os.getenv("RP_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
TILE_ATTRIBUTION = os.getenv("RP_TILE_ATTRIBUTION", "© OpenStreetMap contributors")
SEED_DEMO = os.getenv("RP_SEED_DEMO", "1") == "1"

# Voice assistant: "basic" = browser speech in English / Hindi / Tamil, no API key needed (default, reliable).
# Set RP_VOICE_AI=1 to use Gemini Live / any-language voice when a Gemini key is configured.
VOICE_AI = os.getenv("RP_VOICE_AI", "0") == "1"
VOICE_LANGS = [x.strip() for x in os.getenv("RP_VOICE_LANGS", "en,hi,ta").split(",") if x.strip()]
