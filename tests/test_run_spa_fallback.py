"""Tests for the SPA static mount's 404-fallback behaviour (api.spa.mount_spa).

BrowserRouter routes (extension-less paths) must fall back to index.html, but a
MISSING static asset (e.g. /assets/index-OLDHASH.js after an update) must return
a real 404 — NOT index.html. Serving index.html (text/html) for a .js request
makes Chromium reject it as a non-JS module → white screen (same symptom as the
registry-MIME bug, different cause).
"""
from netlivecowork.api import spa as _run
import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><div id=root></div>", encoding="utf-8"
    )
    (dist / "assets" / "app.js").write_text("export default 1\n", encoding="utf-8")
    monkeypatch.setattr(_run, "_frontend_dist", lambda: str(dist))
    app = Starlette()
    _run.mount_spa(app)
    return TestClient(app)


def test_client_route_falls_back_to_index(client):
    r = client.get("/sessions/abc")
    assert r.status_code == 200
    assert "id=root" in r.text
    assert r.headers["cache-control"] == "no-store"


def test_missing_js_chunk_returns_404_not_index(client):
    r = client.get("/assets/index-OLDHASH.js")
    assert r.status_code == 404
    assert "id=root" not in r.text


def test_missing_css_returns_404_not_index(client):
    r = client.get("/assets/gone.css")
    assert r.status_code == 404
    assert "id=root" not in r.text


def test_existing_js_served_as_javascript(client):
    r = client.get("/assets/app.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
