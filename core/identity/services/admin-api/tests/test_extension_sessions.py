from concurrent.futures import ThreadPoolExecutor

from admin_api.app.extension_sessions import _challenge
from test_stack_admin_api import INTERNAL_SECRET, _admin, client


def test_binding_exchange_rotation_and_revocation(client):
    headers = {"X-Internal-Secret": INTERNAL_SECRET}
    extension = "a" * 32
    user = client.post("/admin/users", headers=_admin(), json={"email": "existing@example.test"}).json()
    other = client.post("/admin/users", headers=_admin(), json={"email": "another@example.test"}).json()
    binding = {"subject": "fixture-google-sub", "user_id": user["id"]}
    assert client.post("/internal/google-login", json=binding).status_code == 403
    assert client.post("/internal/google-login", headers=headers, json=binding).json()["id"] == user["id"]
    assert client.post("/internal/google-login", headers=headers, json={
        **binding, "user_id": other["id"],
    }).status_code == 409
    assert client.post("/internal/google-login", headers=headers, json={
        **binding, "subject": "other-google-sub",
    }).status_code == 409

    verifier = "b" * 43
    body = {**binding, "challenge": _challenge(verifier), "extension_id": extension}
    assert client.post("/internal/extension/code", headers=headers, json={
        **body, "user_id": other["id"],
    }).status_code == 403
    code = client.post("/internal/extension/code", headers=headers, json=body).json()["code"]

    def exchange(action, credential, **overrides):
        return client.post("/internal/extension/session", headers=headers, json={
            "action": action, "credential": credential, "extension_id": extension, **overrides,
        })

    assert exchange("exchange", code, verifier="c" * 43).status_code == 401
    assert exchange("exchange", code, verifier=verifier, extension_id="d" * 32).status_code == 401
    with ThreadPoolExecutor(max_workers=2) as workers:
        exchanges = list(workers.map(lambda _: exchange("exchange", code, verifier=verifier), range(2)))
    assert sorted(response.status_code for response in exchanges) == [200, 401]
    first = next(response.json() for response in exchanges if response.is_success)

    def validate(token, extension=True):
        return client.post("/internal/validate", headers=headers, json={"token": token, "extension": extension})

    verified = validate(first["access_token"]).json()
    assert verified["user_id"] == user["id"] and verified["scopes"] == ["bot", "tx"]
    assert verified["is_admin"] is False
    assert validate(first["access_token"], extension=False).status_code == 401
    assert validate(first["refresh_token"]).status_code == 401
    next_session = exchange("refresh", first["refresh_token"]).json()
    assert validate(first["access_token"]).status_code == 401
    assert exchange("refresh", first["refresh_token"]).status_code == 401
    assert validate(next_session["access_token"]).status_code == 200
    assert exchange("logout", next_session["refresh_token"]).status_code == 200
    assert validate(next_session["access_token"]).status_code == 401
