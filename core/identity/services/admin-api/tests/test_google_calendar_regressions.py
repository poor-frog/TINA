"""Calendar identity regressions through HTTP, with an in-memory user and no database."""
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

from admin_api.app.main import create_app, get_current_user, get_current_user_for_update, get_db
from admin_api.app.calendars import internal_connections
from admin_api.schema.models import User

ICS = "https://calendar.example.test/private/feed.ics"


@pytest.fixture
def calendar_client():
    user = User(id=1, email="owner@example.test", data={})
    db = Mock()
    db.commit = AsyncMock()
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_current_user_for_update] = lambda: user
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as client:
        yield client, user


def google_data(*, deleted=False):
    return {
        "google_calendar_accounts": [{"id": "account", "email": "linked@example.test",
                                      "calendars": [{"id": "calendar", "summary": "Work"}]}],
        "calendar_connections": [{"id": "google", "provider": "google", "name": "Work",
                                  "google_account_id": "account", "google_calendar_id": "calendar",
                                  "enabled": not deleted, "deleted": deleted, "auto_join": False}],
    }


def fill_ics(data):
    data["calendar_connections"].extend(
        {"id": str(i), "name": "ICS", "ics_url": ICS} for i in range(10)
    )


def test_calendar_list_without_google_account(calendar_client):
    client, user = calendar_client
    for data in ({}, {"calendar_ics_url": ICS}):
        user.data = data
        response = client.get("/user/calendars")
        assert response.status_code == 200
        assert response.json()["google_accounts"] == []


def test_first_google_account_link_encrypts_token(calendar_client, monkeypatch):
    client, user = calendar_client
    monkeypatch.setenv("INTERNAL_API_SECRET", "calendar-review-test-secret-" * 3)
    refresh_token = "synthetic-calendar-refresh-token"
    response = client.post("/user/calendars", json={"google_account": {
        "provider_account_id": "google-subject", "email": "linked@example.test",
        "refresh_token": refresh_token, "calendars": [{"id": "work", "summary": "Work"}],
    }})
    assert response.status_code == 201
    assert refresh_token not in response.text
    encrypted = user.data["google_calendar_accounts"][0]["refresh_token_encrypted"]
    from admin_api.app.calendar_crypto import decrypt_google_refresh_token
    assert encrypted != refresh_token
    assert decrypt_google_refresh_token(encrypted) == refresh_token


def test_restore_google_calendar_respects_cap(calendar_client):
    client, user = calendar_client
    user.data = google_data(deleted=True)
    fill_ics(user.data)
    response = client.post("/user/calendars", json={
        "name": "Work", "google_account_id": "account", "google_calendar_id": "calendar",
    })
    assert response.status_code == 409
    assert user.data["calendar_connections"][0]["deleted"] is True


def test_legacy_ics_create_read_disconnect_preserves_google(calendar_client):
    client, user = calendar_client
    user.data = google_data()
    assert client.get("/user/calendar").json()["ics_url_set"] is False
    response = client.put("/user/calendar", json={"ics_url": ICS})
    assert response.status_code == 200
    assert response.json()["ics_url_set"] is True
    configs = internal_connections(user.data, user.id)
    assert [cfg["provider"] for cfg in configs] == ["google", "ics"]
    assert "ics_url" not in user.data["calendar_connections"][0]
    assert client.put("/user/calendar", json={"ics_url": None}).status_code == 200
    assert user.data["calendar_connections"][0]["enabled"] is True
    assert client.get("/user/calendar").json()["ics_url_set"] is False


def test_legacy_ics_create_respects_cap(calendar_client):
    client, user = calendar_client
    user.data = google_data()
    # Ten Google calendars leave no ICS slot for a legacy client to create.
    connection = user.data["calendar_connections"][0]
    user.data["calendar_connections"] = [{**connection, "id": str(i)} for i in range(10)]
    response = client.put("/user/calendar", json={"ics_url": ICS})
    assert response.status_code == 409
    assert len(user.data["calendar_connections"]) == 10


def test_google_sync_receives_the_selected_calendars_timezone():
    data=google_data();data['google_calendar_accounts'][0]['calendars'][0]['time_zone']='Asia/Ho_Chi_Minh'
    config=internal_connections(data,1)[0]
    assert config['google_time_zone']=='Asia/Ho_Chi_Minh'
