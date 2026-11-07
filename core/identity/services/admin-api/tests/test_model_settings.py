"""Settings → Models (identity side) — /user/models + /user/transcription self-serve, the
platform_settings internal CRUD, and the resolution edges dispatch/bot_spawn consume.

Secrets (api_key, transcription token) are masked on every user-facing read and cross in the
clear ONLY over the X-Internal-Secret edges (`/internal/users/{id}/model-config`, bot-context).
Effective config resolves FIELD-BY-FIELD user > platform; env fallback stays downstream.

Same testcontainers-PG harness as O-STACK-3 (skips without docker).
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker

PROVIDER_MODELS = [
    ("groq", "openai/gpt-oss-20b", "openai/gpt-oss-120b"),
    ("deepseek", "deepseek-chat", "deepseek-reasoner"),
    ("gemini", "gemini-2.5-flash", "gemini-2.5-pro"),
]
PROVIDER_MODES = [provider for provider, _, _ in PROVIDER_MODELS]
PROVIDER_SWITCHES = (
    [("custom", provider) for provider in PROVIDER_MODES]
    + [(provider, "openai-api") for provider in PROVIDER_MODES]
    + [(before, after) for before in PROVIDER_MODES for after in PROVIDER_MODES if before != after]
)


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _internal():
    return {"X-Internal-Secret": INTERNAL_SECRET}


def _user_token(client, email="models@example.test"):
    uid = client.post("/admin/users", headers=_admin(), json={"email": email}).json()["id"]
    tok = client.post(f"/admin/users/{uid}/tokens?scopes=bot", headers=_admin()).json()["token"]
    return uid, tok


def test_user_models_set_masked_readback_and_clear(client):
    _uid, tok = _user_token(client)
    h = {"X-API-Key": tok}

    r = client.put("/user/models", headers=h, json={
        "mode": "custom", "model": "qwen3-coder", "base_url": "https://llm.example.com/v1",
        "api_key": "sk-secret-1234abcd",
    })
    assert r.status_code == 200, r.text
    cfg = r.json()
    assert cfg["mode"] == "custom"
    assert cfg["model"] == "qwen3-coder"
    assert cfg["api_key_set"] is True
    # masked: the secret NEVER echoes in the clear
    assert "sk-secret" not in (cfg["api_key"] or "")
    assert cfg["api_key"].endswith("abcd")

    # partial update leaves other fields; empty string clears one
    r = client.put("/user/models", headers=h, json={"model": ""})
    cfg = r.json()
    assert cfg["model"] is None
    assert cfg["mode"] == "custom"          # untouched
    assert cfg["api_key_set"] is True       # untouched


def test_user_models_validation(client):
    _uid, tok = _user_token(client, email="val@example.test")
    h = {"X-API-Key": tok}
    assert client.put("/user/models", headers=h, json={"mode": "yolo"}).status_code == 422
    assert client.put("/user/models", headers=h, json={"base_url": "not-a-url"}).status_code == 422
    assert client.put("/user/transcription", headers=h, json={"url": "ftp://x"}).status_code == 422


@pytest.mark.parametrize("provider,chat_model,meeting_model", PROVIDER_MODELS)
def test_api_provider_user_models_mask_secret_and_resolve_meeting_model(client, provider, chat_model, meeting_model):
    uid, tok = _user_token(client, email=f"{provider}@example.test")
    headers = {"X-API-Key": tok}
    key = f"test-{provider}-credential-1234abcd"
    response = client.put("/user/models", headers=headers, json={
        "mode": provider, "model": chat_model, "meeting_model": meeting_model, "api_key": key,
    })

    assert response.status_code == 200, response.text
    public = response.json()
    assert public["mode"] == provider
    assert public["model"] == chat_model
    assert public["meeting_model"] == meeting_model
    assert public["api_key_set"] is True
    assert public["api_key"].endswith("abcd")
    assert key not in response.text
    readback = client.get("/user/models", headers=headers)
    assert key not in readback.text
    assert readback.json()["mode"] == provider

    resolved = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert resolved == {
        "mode": provider, "model": chat_model, "meeting_model": meeting_model, "api_key": key,
    }


@pytest.mark.parametrize("scope", ["user", "platform"])
@pytest.mark.parametrize("key_length", [4096, 32768])
def test_bedrock_long_api_key_roundtrip_is_masked(client, scope, key_length):
    uid, tok = _user_token(client)
    path = "/user/models" if scope == "user" else "/internal/settings/models"
    headers = {"X-API-Key": tok} if scope == "user" else _internal()
    key = "test-bedrock-" + "a" * (key_length - len("test-bedrock-") - 4) + "abcd"
    response = client.put(path, headers=headers, json={
        "mode": "bedrock", "region": "us-east-1", "api_key": key,
    })
    assert response.status_code == 200
    if scope == "user":
        assert key not in response.text
    public = client.get("/user/models", headers={"X-API-Key": tok})
    assert key not in public.text
    resolved = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert resolved["api_key"] == key


@pytest.mark.parametrize("scope", ["user", "platform"])
@pytest.mark.parametrize("field,length", [("api_key", 32769), ("model", 2049)])
def test_model_settings_length_limits_do_not_echo_rejected_values(client, scope, field, length):
    _uid, tok = _user_token(client)
    path = "/user/models" if scope == "user" else "/internal/settings/models"
    headers = {"X-API-Key": tok} if scope == "user" else _internal()
    value = "x" * length
    response = client.put(path, headers=headers, json={field: value})
    assert response.status_code == 422
    assert value not in response.text
    assert field in response.json()["detail"]


@pytest.mark.parametrize("provider,chat_model,meeting_model", PROVIDER_MODELS)
def test_api_provider_platform_models_apply_to_default_user(client, provider, chat_model, meeting_model):
    uid, tok = _user_token(client, email=f"{provider}-default@example.test")
    key = f"test-platform-{provider}-credential-1234abcd"
    response = client.put("/internal/settings/models", headers=_internal(), json={
        "mode": provider, "model": chat_model, "meeting_model": meeting_model, "api_key": key,
    })
    assert response.status_code == 200, response.text
    resolved = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert resolved == {"mode": provider, "model": chat_model, "meeting_model": meeting_model, "api_key": key}
    # User-facing preferences still describe only this person's values, without platform secrets.
    public = client.get("/user/models", headers={"X-API-Key": tok})
    assert key not in public.text
    assert public.json()["api_key_set"] is False


@pytest.mark.parametrize("before,after", PROVIDER_SWITCHES)
@pytest.mark.parametrize("scope", ["user", "platform"])
def test_api_provider_mode_switch_does_not_retain_another_provider_credential(client, before, after, scope):
    uid, tok = _user_token(client, email="provider-switch@example.test")
    path = "/user/models" if scope == "user" else "/internal/settings/models"
    headers = {"X-API-Key": tok} if scope == "user" else _internal()
    old_key = "test-old-provider-key-1234abcd"
    first = client.put(path, headers=headers, json={
        "mode": before, "model": "previous-model", "meeting_model": "previous-meeting",
        "base_url": "https://old-provider.example.test/v1", "api_key": old_key,
        "region": "us-east-1", "effort": "high",
    })
    assert first.status_code == 200, first.text
    switched = client.put(path, headers=headers, json={"mode": after})
    assert switched.status_code == 200, switched.text
    if scope == "user":
        assert switched.json()["api_key_set"] is False
    else:
        assert "api_key" not in switched.json()["value"]
    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective == {"mode": after}


@pytest.mark.parametrize("provider,chat_model,_meeting_model", PROVIDER_MODELS)
@pytest.mark.parametrize("scope", ["user", "platform"])
def test_api_provider_same_mode_partial_update_keeps_credential_and_explicit_switch_key(client, provider, chat_model, _meeting_model, scope):
    uid, tok = _user_token(client, email="provider-preserve@example.test")
    path = "/user/models" if scope == "user" else "/internal/settings/models"
    headers = {"X-API-Key": tok} if scope == "user" else _internal()
    old_key, new_key = "test-provider-key-1234abcd", "test-openai-key-5678efgh"
    client.put(path, headers=headers, json={"mode": provider, "api_key": old_key})
    client.put(path, headers=headers, json={"mode": provider, "model": chat_model})
    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective["api_key"] == old_key
    switched = client.put(path, headers=headers, json={
        "mode": "openai-api", "model": "chosen-openai-model", "api_key": new_key,
    })
    assert switched.status_code == 200, switched.text
    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective == {"mode": "openai-api", "model": "chosen-openai-model", "api_key": new_key}


@pytest.mark.parametrize("platform,user", PROVIDER_SWITCHES)
def test_api_provider_selection_does_not_inherit_other_provider_fields(client, platform, user):
    uid, tok = _user_token(client, email="provider-isolate@example.test")
    client.put("/internal/settings/models", headers=_internal(), json={
        "mode": platform, "api_key": "test-platform-key-1234abcd", "model": "platform-model",
        "meeting_model": "platform-meeting", "base_url": "https://platform.example.test/v1",
        "effort": "high", "region": "us-east-1",
    })
    changed = client.put("/user/models", headers={"X-API-Key": tok}, json={"mode": user})
    assert changed.status_code == 200, changed.text
    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective == {"mode": user}


@pytest.mark.parametrize("provider,chat_model,meeting_model", PROVIDER_MODELS)
@pytest.mark.parametrize("platform_has_key", [True, False])
def test_api_provider_default_ignores_unbound_personal_credential(client, provider, chat_model, meeting_model, platform_has_key):
    uid, tok = _user_token(client, email="provider-follower@example.test")
    headers = {"X-API-Key": tok}
    old_key = "test-unbound-personal-key-1234abcd"
    client.put("/user/models", headers=headers, json={
        "mode": "custom", "api_key": old_key,
        "base_url": "https://old-provider.example.test/v1", "region": "us-east-1",
    })
    # Legacy custom -> deployment-default could leave a credential with no provider provenance.
    cleared = client.put("/user/models", headers=headers, json={
        "mode": "", "model": chat_model, "meeting_model": meeting_model,
    })
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["api_key_set"] is True
    platform = {"mode": provider, "model": "platform-model",
                "base_url": "https://platform-provider.example.test/v1", "region": "eu-west-1"}
    if platform_has_key:
        platform["api_key"] = "test-platform-provider-key-5678efgh"
    client.put("/internal/settings/models", headers=_internal(), json=platform)
    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective == {**platform, "model": chat_model, "meeting_model": meeting_model}
    assert old_key not in effective.values()

    # A personal key is used only after this person explicitly binds it to the same provider.
    new_key = "test-explicit-personal-provider-key-9012ijkl"
    client.put("/user/models", headers=headers, json={"mode": provider, "api_key": new_key})
    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective["mode"] == provider
    assert effective["api_key"] == new_key


def test_antigravity_user_mode_requires_and_persists_terms_acknowledgment(client):
    uid, tok = _user_token(client, email="agy@example.test")
    headers = {"X-API-Key": tok}

    assert client.put("/user/models", headers=headers, json={
        "mode": "antigravity",
    }).status_code == 422

    response = client.put("/user/models", headers=headers, json={
        "mode": "antigravity",
        "model": "gemini-3.1-pro",
        "api_key": "gemini-secret-1234abcd",
        "antigravity_terms_acknowledged": "true",
    })
    assert response.status_code == 200, response.text
    prefs = response.json()
    assert prefs["mode"] == "antigravity"
    assert prefs["antigravity_terms_acknowledged"] == "true"
    assert prefs["api_key_set"] is True
    assert prefs["api_key"].endswith("abcd")
    assert "gemini-secret" not in prefs["api_key"]

    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective["mode"] == "antigravity"
    assert effective["antigravity_terms_acknowledged"] == "true"
    assert effective["api_key"] == "gemini-secret-1234abcd"


def test_platform_settings_crud_and_gate(client):
    # internal edge only — no/wrong secret fails closed
    assert client.get("/internal/settings/models").status_code == 403
    assert client.put("/internal/settings/models",
                      headers={"X-Internal-Secret": "wrong"}, json={}).status_code == 403
    # unknown key 404s
    assert client.get("/internal/settings/nope", headers=_internal()).status_code == 404

    r = client.put("/internal/settings/models", headers=_internal(),
                   json={"model": "haiku", "mode": "subscription"})
    assert r.status_code == 200, r.text
    assert r.json()["value"] == {"model": "haiku", "mode": "subscription"}
    # partial update + clear
    r = client.put("/internal/settings/models", headers=_internal(), json={"mode": ""})
    assert r.json()["value"] == {"model": "haiku"}
    assert client.get("/internal/settings/models", headers=_internal()).json()["value"] == {"model": "haiku"}
    # same field rules as the user tier
    assert client.put("/internal/settings/models", headers=_internal(),
                      json={"mode": "yolo"}).status_code == 422


def test_model_config_resolves_user_over_platform(client):
    uid, tok = _user_token(client, email="resolve@example.test")
    client.put("/internal/settings/models", headers=_internal(),
               json={"model": "global-model", "meeting_model": "global-meeting",
                     "base_url": "https://global.example.com"})
    client.put("/user/models", headers={"X-API-Key": tok},
               json={"model": "my-model", "api_key": "sk-user-key"})

    r = client.get(f"/internal/users/{uid}/model-config", headers=_internal())
    assert r.status_code == 200, r.text
    models = r.json()["models"]
    assert models["model"] == "my-model"                       # user beats platform
    assert models["meeting_model"] == "global-meeting"         # platform fills the gap
    assert models["base_url"] == "https://global.example.com"  # field-by-field, not all-or-nothing
    assert models["api_key"] == "sk-user-key"                  # the secret crosses ONLY here

    # unknown subject → 404 (dispatch treats it as env defaults)
    assert client.get("/internal/users/999999/model-config", headers=_internal()).status_code == 404


def test_bot_context_carries_effective_transcription(client):
    uid, tok = _user_token(client, email="stt@example.test")
    # nothing configured → no transcription key at all (bot_spawn keeps its env)
    r = client.get(f"/internal/users/{uid}/bot-context", headers=_internal())
    assert "transcription" not in r.json()

    client.put("/internal/settings/transcription", headers=_internal(),
               json={"url": "https://stt-global.example.com", "token": "tok-global"})
    r = client.get(f"/internal/users/{uid}/bot-context", headers=_internal())
    assert r.json()["transcription"] == {
        "url": "https://stt-global.example.com",
        "token": "tok-global",
        "provider": "tina",
    }

    client.put("/user/transcription", headers={"X-API-Key": tok},
               json={"url": "https://stt-mine.example.com"})
    r = client.get(f"/internal/users/{uid}/bot-context", headers=_internal())
    # A customer URL never inherits the platform credential.
    assert r.json()["transcription"] == {
        "url": "https://stt-mine.example.com",
        "provider": "customer",
    }

    # masked user-facing read-back
    cfg = client.get("/user/transcription", headers={"X-API-Key": tok}).json()
    assert cfg["url"] == "https://stt-mine.example.com"
    assert cfg["token_set"] is False


def test_managed_viegem_persists_without_personal_credentials(client):
    uid, tok = _user_token(client, email="viegem@example.test")
    h = {"X-API-Key": tok}
    assert client.put("/user/transcription", headers=h, json={"backend": "viegem"}).status_code == 422
    r = client.put("/internal/settings/transcription", headers=_internal(), json={
        "viegem_url": "https://asr.example.test", "viegem_token": "managed-secret",
    })
    assert r.status_code == 200
    r = client.put("/user/transcription", headers=h, json={"backend": "viegem"})
    assert r.status_code == 200
    cfg = client.get("/user/transcription", headers=h).json()
    assert cfg["backend"] == "viegem"
    assert cfg["token_set"] is False
    assert cfg["url"] is None
    assert "managed-secret" not in str(cfg)
    effective = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()["transcription"]
    assert effective["backend"] == "viegem"
    assert effective["url"] == "https://asr.example.test"
    assert effective["token"] == "managed-secret"
    assert effective["provider"] == "tina"


def test_deployment_viegem_token_never_persists_in_settings(client, monkeypatch):
    monkeypatch.setenv("TINA_VIEGEM_TOKEN", "dotenvx-injected-secret")
    fresh = client.get("/internal/settings/transcription", headers=_internal()).json()
    assert fresh["configured"] is False
    assert fresh["value"]["viegem_token"] == "dotenvx-injected-secret"
    uid, tok = _user_token(client, email="encrypted-viegem@example.test")
    payload = {"viegem_url": "https://asr.example.test", "default_backend": "viegem"}
    r = client.put("/internal/settings/transcription", headers=_internal(), json=payload)
    assert r.status_code == 200
    assert r.json()["value"] == payload
    assert client.get("/internal/settings/transcription", headers=_internal()).json()["configured"] is True
    assert client.put("/internal/settings/transcription", headers=_internal(),
                      json={"viegem_token": "must-not-store"}).status_code == 422
    assert client.put("/user/transcription", headers={"X-API-Key": tok},
                      json={"backend": "viegem"}).status_code == 200
    effective = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()["transcription"]
    assert effective["token"] == "dotenvx-injected-secret"
    assert "dotenvx-injected-secret" not in client.get("/user/transcription", headers={"X-API-Key": tok}).text
    from sqlalchemy import text
    engine = create_engine(app_db._engine.url.set(drivername="postgresql+psycopg"))
    try:
        with engine.connect() as db:
            assert db.execute(text("SELECT value FROM platform_settings WHERE key = 'transcription'")).scalar_one() == payload
    finally:
        engine.dispose()


def test_asr_runtime_keeps_accounts_independent_and_fences_stale_updates(client):
    h = _internal()
    assert client.put("/internal/settings/transcription", headers=h, json={
        "gipformer_url": "http://gipformer.example.test", "gipformer_token": "gip-secret",
        "viegem_url": "http://viegem.example.test", "viegem_token": "vie-secret"}).status_code == 200
    first, one = _user_token(client, email="asr-one@example.test")
    second, two = _user_token(client, email="asr-two@example.test")
    for token in (one, two):
        assert client.put("/user/transcription", headers={"X-API-Key": token}, json={"backend": "viegem"}).status_code == 200
    before = client.get(f"/internal/transcription/runtime?user_id={first}", headers=h).json()
    assert before["counts"] == {"gipformer": 0, "viegem": 2}
    assert set(before) == {"counts", "account"}
    assert set(before["account"]) == {"backend", "enabled", "revision"}
    assert "token" not in str(before) and "email" not in str(before)
    revision = before["account"]["revision"]
    payload = {"backend": "gipformer", "enabled": "true", "expected_revision": revision}
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers=h, json=payload).status_code == 200
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers=h, json=payload).status_code == 409
    runtime = client.get(f"/internal/transcription/runtime?user_id={first}", headers=h).json()
    assert runtime["counts"] == {"gipformer": 1, "viegem": 1}
    assert "secret" not in str(runtime) and "asr-two" not in str(runtime)
    assert client.get("/user/transcription", headers={"X-API-Key": two}).json()["backend"] == "viegem"
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers={"X-API-Key": two}, json=payload).status_code == 403
    payload = {"backend": "gipformer", "enabled": "false", "expected_revision": runtime["account"]["revision"]}
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers=h, json=payload).status_code == 200
    config = client.get(f"/internal/users/{first}/transcription", headers=h).json()
    assert config["disabled"] is True and not config.get("url") and "token" not in config


def test_translation_model_round_trip_and_partial_clear(client):
    uid, token = _user_token(client)
    headers = {"X-API-Key": token}
    saved = client.put("/user/models", headers=headers, json={
        "mode": "openai-api", "model": "sol", "meeting_model": "meeting", "translation_model": "luna"})
    assert saved.status_code == 200
    assert saved.json()["translation_model"] == "luna"
    effective = client.get(f"/internal/users/{uid}/model-config", headers=_internal()).json()
    assert effective["models"]["translation_model"] == "luna"
    cleared = client.put("/user/models", headers=headers, json={"translation_model": ""}).json()
    assert cleared["translation_model"] is None
    assert cleared["model"] == "sol" and cleared["meeting_model"] == "meeting"
