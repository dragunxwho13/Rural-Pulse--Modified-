"""Request models for the HTTP API (responses are plain dicts, documented in docs/API.md)."""
from typing import Dict, List, Optional, Union

from pydantic import BaseModel, Field


class Vitals(BaseModel):
    spo2: Optional[float] = Field(default=None, ge=50, le=100, description="Pulse-oximeter SpO2 %")
    temp_c: Optional[float] = Field(default=None, ge=30, le=45, description="Temperature in Celsius")


class InterpretRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    language: str = Field(default="auto", description="auto | en | hi | ta (output language preference)")
    mode: str = Field(default="patient", description="patient | asha")
    answers: Dict[str, Union[str, float, int, None]] = Field(default_factory=dict)
    vitals: Vitals = Field(default_factory=Vitals)
    at_time: Optional[str] = Field(default=None, description="Local ISO time, e.g. 2026-10-07T10:30")
    consent_store: bool = False


class AssessRequest(InterpretRequest):
    interpretation_id: Optional[str] = None
    symptom_ids: Optional[List[str]] = Field(default=None, description="Patient-edited symptom list from the read-back step")
    confirmed: bool = False


class TranslateRequest(BaseModel):
    texts: List[str] = Field(max_length=60)
    lang: str


class OtpRequest(BaseModel):
    phone: str


class OtpVerify(BaseModel):
    phone: str
    code: str
    role: str = "asha"
    name: str = ""
    facility_key: str = ""
    facility_name: str = ""


class CaseRequest(BaseModel):
    """What the patient/ASHA app sends when notifying the nearest doctor."""
    assessment_id: Optional[str] = None
    level: str
    title: str = ""
    message: str = Field(default="", max_length=2000)
    symptoms: List[str] = Field(default_factory=list)
    red_flags: List[str] = Field(default_factory=list)
    lang: str = "en"
    age: Optional[float] = None
    duration_days: Optional[float] = None
    pregnant: Optional[bool] = None
    vitals: Dict[str, Optional[float]] = Field(default_factory=dict)
    doctor_note: str = Field(default="", max_length=4000)
    prep: List[str] = Field(default_factory=list)
    mode: str = "patient"
    patient_name: str = ""
    patient_phone: str = ""
    asha_name: str = ""
    slot: Optional[str] = None
    location: Optional[Dict[str, float]] = None
    facility: Dict = Field(default_factory=dict, description="{key, name, lat, lon, phone, kind, source}")


class CasePatch(BaseModel):
    status: str


class RxItem(BaseModel):
    name: str
    strength: str = ""
    form: str = "tablet"
    morning: float = 0
    afternoon: float = 0
    night: float = 0
    food: str = "after"
    days: int = 0
    note: str = ""


class RxRequest(BaseModel):
    case_id: str = ""
    items: List[RxItem] = Field(default_factory=list)
    notes: str = ""
    follow_up: Optional[str] = None
    lang: str = ""
    doctor: str = ""
    facility_name: str = ""
    patient_phone: str = ""
    pharmacy: Dict = Field(default_factory=dict)
    origin: str = ""


class RxPatch(BaseModel):
    status: str


class SettingsRequest(BaseModel):
    gemini_key: Optional[str] = Field(default=None, description="None = leave unchanged, '' = turn AI off")
    overpass_url: str = ""
    nominatim_url: str = ""
    osrm_url: str = ""
    tile_url: str = ""
    tile_attribution: str = ""
    save: bool = False


class VoiceTurnRequest(BaseModel):
    audio_b64: str
    mime: str = "audio/webm"
    history: List[Dict[str, str]] = Field(default_factory=list)
    ui_lang: str = "en"


class TTSRequest(BaseModel):
    text: str = Field(max_length=1200)


class VoiceTextRequest(BaseModel):
    text: str = Field(max_length=2000)
    history: List[Dict[str, str]] = Field(default_factory=list)
    ui_lang: str = "en"
