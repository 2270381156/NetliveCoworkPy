"""Regression test for the Windows white-screen bug (0.4.x).

Some Windows machines have a registry mapping HKCR\\.js -> text/plain. Starlette
StaticFiles infers Content-Type via Python ``mimetypes.guess_type``, which reads
that registry on Windows, so the Vite-built ``<script type="module">`` was served
as text/plain and Chromium refused to load it (modules require a JS MIME type) ->
white screen. ``api.spa`` overrides the mapping at import time; this guards that.
"""
import importlib
import mimetypes


def test_run_import_forces_js_mime_over_bad_registry():
    # Simulate a machine whose registry maps .js / .mjs to text/plain.
    mimetypes.add_type("text/plain", ".js")
    mimetypes.add_type("text/plain", ".mjs")
    assert mimetypes.guess_type("app.js")[0] == "text/plain"  # pre-condition

    # Importing the desktop entrypoint must override the (simulated) registry.
    from netlivecowork.api import spa as _run

    importlib.reload(_run)

    assert mimetypes.guess_type("app.js")[0] == "text/javascript"
    assert mimetypes.guess_type("app.mjs")[0] == "text/javascript"
    assert mimetypes.guess_type("styles.css")[0] == "text/css"
