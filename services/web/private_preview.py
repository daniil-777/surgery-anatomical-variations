"""Private, browser-only build preview. No generation server is needed.

For the complete generation API use services.web.app with the same access config.
"""
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from .studio_access import AccessConfig, StudioAccess, ROOT

config = AccessConfig.from_env()  # Fail at startup, never serve unprotected on misconfiguration.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(StudioAccess, config=config)
app.mount("/", StaticFiles(directory=Path(os.environ.get("VISCERA_WEB_DIST", ROOT / "public-copy")), html=True))
