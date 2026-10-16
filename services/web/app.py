"""Serve the built anatomy app without exposing the development server."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from services.api.app import ROOT, create_app

app = create_app(database=Path(os.environ.get("VISCERA_WEB_DB", ROOT / "data/web-studio.sqlite")))
app.title = "VISCERA Anatomy Web App"

# Publishing the anatomy UI does not authorize visitors to replace the owner's
# learned weights, activate older models, or start model downloads on this Mac.
LOCAL_MODEL_OPERATIONS = frozenset({
    "/api/atlas/models/import", "/api/atlas/models/defaults",
    "/api/atlas/models/joint/activate", "/api/atlas/models/language/enable",
})


@app.middleware("http")
async def web_boundary(request: Request, call_next):
    if request.url.path.rstrip("/") in LOCAL_MODEL_OPERATIONS:
        return JSONResponse({"detail": "Model administration is available only in the local studio."}, status_code=403)
    # Local saved projects and snapshots use a different database. Public web
    # visitors may generate/export specimens, but cannot enumerate saved projects.
    if request.method == "GET" and request.url.path.rstrip("/") == "/api/projects":
        return JSONResponse({"detail": "Saved project listing is not public."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


def _preload_language() -> None:
    """A public server never downloads on a visitor's request (403 above). The operator opts in at start with
    VISCERA_WEB_PRELOAD_LANGUAGE=1: the imported text adapter and its pinned Qwen base load once, before the port
    opens, so the Text tab's trained adapter answers from the first request and no request waits on the adapter's
    lock mid-load. If loading fails the studio still serves; the adapter then answers 422 as in the local studio."""
    from services.api import atlas_model_registry as registry
    from services.api.atlas import template_root
    from services.api.atlas_language_model import enable_adapter

    log = logging.getLogger("viscera.web")
    try:
        identifier, directory = registry.resolve_imported_lane(ROOT, "language")
        data = registry.data_paths(ROOT)
        report = enable_adapter(
            template_root(), directory, data["language"], data["shape"], allow_model_download=True
        )
        registry.mark_language_enabled(ROOT, identifier)
        log.info("text adapter enabled: %s on %s", report["model_id"], report["device"])
    except Exception as error:  # noqa: BLE001 - the studio must serve without the adapter
        log.warning("text adapter not enabled: %s", error)


if os.environ.get("VISCERA_WEB_PRELOAD_LANGUAGE") == "1":
    _preload_language()

app.mount("/", StaticFiles(directory=os.environ.get("VISCERA_WEB_DIST", str(ROOT / "apps/studio/dist")), html=True), name="studio")
