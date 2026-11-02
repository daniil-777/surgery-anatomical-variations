"""Public entry remains reversible without changing the existing studio bundle."""
from dataclasses import replace

import pytest
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

from services.web.studio_access import AccessConfig, AccessStore, StudioAccess, password_hash

ORIGIN = "http://127.0.0.1:5180"


@pytest.fixture(scope="module")
def digest():
    return password_hash("fixture-password-only")


@pytest.fixture
def setup(tmp_path, digest):
    config = AccessConfig("private-owner", digest, ORIGIN, tmp_path / "access.sqlite", public_welcome=True)
    app = FastAPI()
    @app.get("/{path:path}")
    def studio(path: str):
        return PlainTextResponse("studio asset")
    app.add_middleware(StudioAccess, config=config)
    return TestClient(app, base_url=ORIGIN, follow_redirects=False), config


def enter(client, next="/?mode=scene&scene=virtamed"):
    return client.post("/auth/enter", params={"next": next}, headers={"Origin": ORIGIN})


def test_welcome_replaces_form_and_disables_password_endpoint(setup):
    client, _ = setup
    page = client.get("/auth/login")
    assert page.status_code == 200
    assert 'id="welcome-button"' in page.text
    assert 'type="password"' not in page.text and 'id="username"' not in page.text
    assert client.get("/auth/ui/login.js").status_code == 404
    assert client.post("/auth/login", headers={"Origin": ORIGIN}, json={}).status_code == 404
    assert client.get("/auth/ui/welcome.js").status_code == 200
    assert client.get("/auth/ui/welcome.css").status_code == 200


def test_visitor_can_enter_refresh_and_leave_without_credentials(setup):
    client, _ = setup
    assert client.get("/models/organ.glb").status_code == 401
    response = enter(client)
    assert response.status_code == 200
    assert response.json()["next"] == "/?mode=scene&scene=virtamed"
    assert "HttpOnly" in response.headers["set-cookie"]
    assert client.get("/auth/session").json()["user"] == "Visitor"
    assert client.get("/models/organ.glb").text == "studio asset"
    assert client.get("/auth/login").status_code == 303
    assert client.post("/auth/logout", headers={"Origin": ORIGIN}).status_code == 200
    assert client.get("/auth/session").status_code == 401
    assert 'id="welcome-button"' in client.get("/auth/login").text


@pytest.mark.parametrize("next", ["https://evil.example", "//evil.example", "/%2fevil.example", "/auth/login"])
def test_welcome_cannot_redirect_offsite_or_loop(setup, next):
    client, _ = setup
    assert enter(client, next).json()["next"] == "/"


def test_entry_rejects_foreign_origins_and_get_requests(setup):
    client, _ = setup
    assert client.post("/auth/enter").status_code == 403
    assert client.post("/auth/enter", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/auth/enter").status_code == 404


def test_restoring_private_mode_rejects_visitor_sessions(setup):
    client, public = setup
    enter(client)
    token = client.cookies.get(public.cookie)
    private = replace(public, public_welcome=False)
    assert AccessStore(private).session(token) is None
    app = FastAPI()
    app.add_middleware(StudioAccess, config=private)
    with TestClient(app, base_url=ORIGIN) as restored:
        restored.cookies.set(private.cookie, token)
        assert restored.get("/auth/session").status_code == 401
        assert 'type="password"' in restored.get("/auth/login").text
        assert enter(restored).status_code == 404


def test_public_visitors_do_not_evict_each_other(setup):
    _, config = setup
    store = AccessStore(config)
    first, _ = store.create_session()
    for _ in range(22):
        store.create_session()
    assert store.session(first) is not None
