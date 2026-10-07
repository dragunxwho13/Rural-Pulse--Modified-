"""Model auto-selection: retired names (404 'no longer available to new users') must never break the app."""
from types import SimpleNamespace

import pytest

from backend.app import config, gemini_models as gm, llm, settings


class NotFound(Exception):
    code = 404

    def __init__(self, m):
        super().__init__(f"404 NOT_FOUND. {{'error': {{'code': 404, 'message': 'This model models/{m} is no longer available to new users.'}}}}")


LISTED = [
    ("models/gemini-2.5-flash", ["generateContent", "countTokens"]),
    ("models/gemini-3.5-flash", ["generateContent"]),
    ("models/gemini-3.8-flash", ["generateContent"]),
    ("models/gemini-3.8-flash-lite", ["generateContent"]),
    ("models/gemini-3.9-flash-preview", ["generateContent"]),
    ("models/gemini-flash-latest", ["generateContent"]),
    ("models/gemini-3.8-flash-image", ["generateContent"]),
    ("models/gemini-3.8-live", ["bidiGenerateContent"]),
    ("models/gemini-2.5-flash-native-audio-preview-12-2025", ["bidiGenerateContent"]),
    ("models/gemini-3.8-flash-tts", ["generateContent"]),
    ("models/gemini-2.5-flash-preview-tts", ["generateContent"]),
    ("models/gemini-embedding-001", ["embedContent"]),
]


class FakeClient:
    def __init__(self, dead=("gemini-2.5-flash", "gemini-flash-latest"), listed=LISTED, list_fails=False):
        self.dead, self.calls = set(dead), []
        outer = self

        class Models:
            def list(self_inner):
                if list_fails:
                    raise RuntimeError("list blocked")
                return [SimpleNamespace(name=n, supported_actions=a) for n, a in listed]

            def generate_content(self_inner, model, contents, config=None):
                outer.calls.append(model)
                if model in outer.dead:
                    raise NotFound(model)
                return SimpleNamespace(text="ok", parsed=None)
        self.models = Models()


@pytest.fixture(autouse=True)
def clean():
    old = (config.GOOGLE_API_KEY, config.USE_LLM, config.LLM_MODEL, config.LIVE_MODEL, config.TTS_MODEL, config._ENV_LLM_MODEL, llm._client)
    gm.reset()
    yield
    (config.GOOGLE_API_KEY, config.USE_LLM, config.LLM_MODEL, config.LIVE_MODEL, config.TTS_MODEL, config._ENV_LLM_MODEL, llm._client) = old
    gm.reset()


def test_ranking_prefers_latest_alias_then_newest_stable_flash():
    r = gm.classify([{"name": n.split("/")[-1], "actions": a} for n, a in LISTED])
    assert r["text"][0] == "gemini-flash-latest"
    assert r["text"][1] == "gemini-3.8-flash"          # stable beats newer preview; full beats lite
    assert "gemini-3.8-flash-image" not in r["text"] and "gemini-3.8-live" not in r["text"]
    assert r["live"][0] == "gemini-3.8-live"
    assert r["tts"][0] == "gemini-3.8-flash-tts"
    assert r["embed"] == ["gemini-embedding-001"]


def test_retired_model_is_skipped_automatically():
    config.GOOGLE_API_KEY = "k1"
    c = FakeClient()
    out = gm.call("text", c, lambda m: c.models.generate_content(model=m, contents="hi"))
    assert out.text == "ok"
    assert c.calls == ["gemini-flash-latest", "gemini-3.8-flash"]
    assert config.LLM_MODEL == "gemini-3.8-flash"
    # next call goes straight to the working model
    c.calls.clear(); gm.call("text", c, lambda m: c.models.generate_content(model=m, contents="hi"))
    assert c.calls == ["gemini-3.8-flash"]


def test_old_env_model_name_does_not_break(monkeypatch):
    config.GOOGLE_API_KEY = "k2"
    config._ENV_LLM_MODEL = "gemini-2.5-flash"         # left over in an old .env
    c = FakeClient(dead=("gemini-2.5-flash",))
    gm.call("text", c, lambda m: c.models.generate_content(model=m, contents="hi"))
    assert c.calls == ["gemini-2.5-flash", "gemini-flash-latest"]


def test_works_even_when_model_listing_is_blocked():
    config.GOOGLE_API_KEY = "k3"
    c = FakeClient(list_fails=True)
    gm.call("text", c, lambda m: c.models.generate_content(model=m, contents="hi"))
    assert c.calls[-1] == "gemini-3.8-flash" and "gemini-flash-latest" in c.calls


def test_other_errors_are_not_swallowed():
    config.GOOGLE_API_KEY = "k4"
    c = FakeClient(dead=())

    def boom(m):
        raise PermissionError("API key not valid")
    with pytest.raises(PermissionError):
        gm.call("text", c, boom)


def test_settings_key_accepted_when_default_model_is_retired(monkeypatch):
    fake = FakeClient()
    import google.genai as genai
    monkeypatch.setattr(genai, "Client", lambda api_key=None, **kw: fake)
    r = settings.set_gemini_key("AIzaFAKEKEY_for_test_123456")
    assert r["ok"], r
    assert "gemini-3.8-flash" in r["message"] and "gemini-3.8-live" in r["message"]
    assert config.USE_LLM and config.LLM_MODEL == "gemini-3.8-flash"
    # and the app's own calls now use the working model
    llm._client = fake
    fake.calls.clear()
    llm.generate("text", contents="hello")
    assert fake.calls == ["gemini-3.8-flash"]


def test_invalid_key_message_is_friendly(monkeypatch):
    import google.genai as genai

    class Bad:
        class models:
            @staticmethod
            def list():
                raise Exception("400 INVALID_ARGUMENT. API key not valid. Please pass a valid API key. API_KEY_INVALID")

            @staticmethod
            def generate_content(**kw):
                raise Exception("400 INVALID_ARGUMENT. API key not valid. API_KEY_INVALID")
    monkeypatch.setattr(genai, "Client", lambda api_key=None, **kw: Bad())
    config.GOOGLE_API_KEY, config.USE_LLM = "", False
    r = settings.set_gemini_key("AIzaWRONG")
    assert not r["ok"] and "not valid" in r["message"] and not config.USE_LLM and config.GOOGLE_API_KEY == ""
