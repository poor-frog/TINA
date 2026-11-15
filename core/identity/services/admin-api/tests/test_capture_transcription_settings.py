"""Offline identity-bound capture configuration: central precedence and closed secret boundary."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from admin_api.app import db as app_db
from admin_api.app.main import create_app, _transcription_summary


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "internal-test-secret")
    monkeypatch.setenv("ADMIN_API_TOKEN", "admin-test-secret")
    monkeypatch.setenv("DEV_MODE", "true")
    user = SimpleNamespace(id=7, email="test@example.test", max_concurrent_bots=1,
                           data={"transcription_prefs": {"backend": "funasr"}})
    token = SimpleNamespace(user_id=7, expires_at=None, scopes=["bot"], last_used_at=None)
    platform = {"default_backend": "sherpa", "sherpa_url": "http://host.docker.internal:18001",
                "funasr_url": "http://host.docker.internal:18000", "token": "not-for-clients"}

    class DB:
        async def get(self, *_):
            return SimpleNamespace(value=platform)

        async def execute(self, statement):
            values = list(statement.compile().params.values())
            row = (token, user) if "valid-key" in values else None
            entity = token if "FROM api_tokens" in str(statement) and "JOIN" not in str(statement) else user
            return SimpleNamespace(first=lambda: row, scalar_one_or_none=lambda: user,
                                   scalar_one=lambda: user,
                                   scalars=lambda: SimpleNamespace(first=lambda: entity))

        def add(self, _):
            pass

        async def commit(self):
            pass

    app = create_app()

    async def database():
        yield DB()

    app.dependency_overrides[app_db.get_db] = database
    with TestClient(app) as client:
        client.fixture_user = user
        client.fixture_platform = platform
        yield client, token


def test_capture_config_uses_same_precedence_and_never_trusts_a_user_id(client):
    c, _ = client
    headers = {"X-Internal-Secret": "internal-test-secret"}
    url = "/internal/transcription/resolve"
    global_config = c.post(url, headers=headers, json={}).json()
    assert global_config["backend"] == "sherpa"
    assert global_config["summary"]["source"] == "platform"
    personal = c.post(url, headers=headers, json={"token": "valid-key", "user_id": 999}).json()
    assert personal["backend"] == "funasr"
    assert personal["summary"]["source"] == "user"
    assert personal["model"] == "custom"
    assert "url" not in personal["summary"] and "token" not in personal["summary"]
    assert c.post(url, headers=headers, json={"token": "bad-key"}).status_code == 401


def test_capture_door_rejects_missing_secret_and_wrong_scopes_even_in_dev(client, monkeypatch):
    c, token = client
    url = "/internal/transcription/resolve"
    assert c.post(url, json={}).status_code == 403
    token.scopes = ["browser"]
    assert c.post(url, headers={"X-Internal-Secret": "internal-test-secret"},
                  json={"token": "valid-key"}).status_code == 403
    monkeypatch.delenv("INTERNAL_API_SECRET")
    assert c.post(url, json={}).status_code == 503


def test_public_summary_is_safe_for_personal_custom_service_and_environment_fallback():
    summary = _transcription_summary({"backend": "custom", "url": "https://private.example", "token": "secret"}, {})
    assert summary == {"backend": "custom", "label": "Custom endpoint", "model": None, "source": "user"}
    assert _transcription_summary({}, {})["source"] == "environment"
    assert _transcription_summary({"backend": "default"}, {"default_backend": "sherpa"})["source"] == "platform"


def test_voice_preference_is_account_scoped_and_delivered_in_existing_spawn_context(client,monkeypatch):
    from sqlalchemy.orm import attributes
    monkeypatch.setattr(attributes,'flag_modified',lambda *a:None)
    c,_=client;headers={'X-API-Key':'valid-key'}
    defaults={'speech_voice':'auto','pronunciations':{}}
    assert c.get('/user/voice',headers=headers).json()=={'prepare_new_bots':None,**defaults}
    assert c.put('/user/voice',headers=headers,json={'prepare_new_bots':False}).json()=={'prepare_new_bots':False,**defaults}
    context=c.get('/internal/users/7/bot-context',headers={'X-Internal-Secret':'internal-test-secret'}).json()
    assert context['voice']=={'prepare_new_bots':False,**defaults}
    assert c.get('/user/voice').status_code==401
    assert c.put('/user/voice',headers=headers,json={'prepare_new_bots':'false'}).status_code==422
    assert c.put('/user/voice',headers=headers,json={'prepare_new_bots':False,'user_id':8}).status_code==422
    assert c.fixture_user.data['transcription_prefs']=={'backend':'funasr'}
    assert c.put('/user/voice',headers=headers,json={'prepare_new_bots':None}).json()=={'prepare_new_bots':None,**defaults}


def test_voice_profile_partial_updates_are_account_scoped_and_reject_markup(client,monkeypatch):
    from sqlalchemy.orm import attributes
    monkeypatch.setattr(attributes,'flag_modified',lambda *a:None)
    c,_=client;headers={'X-API-Key':'valid-key'}
    response=c.put('/user/voice',headers=headers,json={'speech_voice':'Mai Anh','pronunciations':{'PostgreSQL':'pốt gờ rét'}})
    assert response.status_code==200,response.text
    c.put('/user/voice',headers=headers,json={'prepare_new_bots':False})
    profile=c.get('/user/voice',headers=headers).json()
    assert profile['speech_voice']=='Mai Anh' and profile['pronunciations']=={'PostgreSQL':'pốt gờ rét'}
    assert c.put('/user/voice',headers=headers,json={'pronunciations':{'TINA':'<script>'}}).status_code==422
    assert c.put('/user/voice',headers=headers,json={'speech_voice':'http://private/model'}).status_code==422


def test_managed_viegem_uses_only_platform_credentials_and_does_not_leak_them(client, monkeypatch):
    c, _ = client
    c.fixture_platform.update(viegem_url="http://host.docker.internal:18005", viegem_token="managed-secret")
    c.fixture_user.data = {"transcription_prefs": {"backend": "viegem", "url": "https://attacker.example", "token": "foreign-token"}}
    response = c.post("/internal/transcription/resolve", headers={"X-Internal-Secret": "internal-test-secret"}, json={"token": "valid-key"})
    assert response.status_code == 200
    config = response.json()
    assert config["backend"] == "viegem"
    assert config["url"] == "http://host.docker.internal:18005"
    assert config["token"] == "managed-secret"
    assert config["model"] == "5CD-AI/VieGem-ASR"
    public = c.get("/user/transcription", headers={"X-API-Key": "valid-key"})
    assert public.status_code == 200
    assert "managed-secret" not in public.text
    assert "viegem" in public.json()["available_backends"]
    assert public.json()["effective"]["label"] == "VieGem + LM"
    # A subsequent arbitrary custom endpoint never borrows the platform credential.
    c.fixture_user.data = {"transcription_prefs": {"backend": "custom", "url": "https://attacker.example"}}
    config = c.post("/internal/transcription/resolve", headers={"X-Internal-Secret": "internal-test-secret"}, json={"token": "valid-key"}).json()
    assert config["url"] == "https://attacker.example"
    assert "token" not in config
    monkeypatch.setattr("sqlalchemy.orm.attributes.flag_modified", lambda *_: None)
    response = c.put("/user/transcription", headers={"X-API-Key": "valid-key"}, json={"backend": "viegem"})
    assert response.status_code == 200
    assert response.json()["backend"] == "viegem"
    assert c.fixture_user.data["transcription_prefs"].get("token") is None


def test_managed_viegem_requires_configured_url_and_token(client):
    c, _ = client
    r = c.put("/user/transcription", headers={"X-API-Key": "valid-key"}, json={"backend": "viegem"})
    assert r.status_code == 422
    assert c.fixture_user.data["transcription_prefs"]["backend"] == "funasr"
