"""Public recorder assets for the private login page; no studio/auth data is exposed."""
from pathlib import Path
from starlette.responses import FileResponse, Response

RECORDER = Path(__file__).resolve().parents[2] / "apps/studio/public/recorder"
ASSETS = frozenset({"index.html", "recorder.js", "recorder.css", "launcher.js", "launcher.css", "manifest.json"})


def recording_asset(name: str) -> Response:
    if name not in ASSETS or not (RECORDER / name).is_file():
        return Response(status_code=404)
    return FileResponse(RECORDER / name, headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"})
