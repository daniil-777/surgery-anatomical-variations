"""Single-owner studio access. Protects both API routes and built application assets.

No credentials or signing keys enter a browser bundle. Session tokens are random,
only their SHA-256 digests are stored, and password verification runs off the event loop.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from fastapi import Request
from .recording_assets import recording_asset
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response

ROOT = Path(__file__).resolve().parents[2]
UI = Path(__file__).with_name("login")
ITERATIONS = 600_000
SESSION_SECONDS = 8 * 60 * 60
PUBLIC_ASSETS = {
    "login.css", "login.js", "inter-400.woff2", "inter-500.woff2", "inter-600.woff2",
    "anatomy.png", "variation.png", "physics.png", "materials.png", "mark.svg", "credits.html", "INTER-LICENSE.txt",
    "shape.gif", "physics.gif", "grasp.gif", "materials.gif",
    "shape-preview.jpg", "physics-preview.jpg", "grasp-preview.jpg", "materials-preview.jpg",
    "welcome.js", "welcome.css",
}


def password_hash(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt}${digest.hex()}"


@dataclass(frozen=True)
class AccessConfig:
    username: str
    password_hash: str
    origin: str
    database: Path
    session_seconds: int = SESSION_SECONDS
    public_welcome: bool = False

    def __post_init__(self):
        url = urlsplit(self.origin)
        if url.scheme not in {"http", "https"} or not url.netloc or url.path or url.query or url.fragment or url.username:
            raise ValueError("VISCERA_AUTH_ORIGIN must be an origin without a path.")
        if url.scheme == "http" and url.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Non-local studio access requires an HTTPS origin.")
        if not self.username or len(self.username) > 128:
            raise ValueError("Configure one studio username.")
        try:
            algorithm, iterations, salt, digest = self.password_hash.split("$")
            if algorithm != "pbkdf2_sha256" or int(iterations) != ITERATIONS:
                raise ValueError("Unsupported password derivation")
            if len(bytes.fromhex(salt)) != 16 or len(bytes.fromhex(digest)) != 32:
                raise ValueError("Invalid hash dimensions")
        except ValueError as error:
            raise ValueError("Invalid studio password hash; run scripts/configure_studio_access.py.") from error
        if not 1 <= self.session_seconds <= SESSION_SECONDS:
            raise ValueError("Session lifetime must be between 1 second and 8 hours.")

    @property
    def secure(self) -> bool:
        return self.origin.startswith("https://")

    @property
    def cookie(self) -> str:
        return "__Host-viscera_studio" if self.secure else f"viscera_studio_{urlsplit(self.origin).port or 80}"

    @classmethod
    def from_env(cls):
        path = Path(os.environ.get("VISCERA_AUTH_CONFIG", ROOT / "data/studio-access.json"))
        if not path.is_file():
            raise RuntimeError("Studio access is unconfigured. Run scripts/configure_studio_access.py first.")
        if path.stat().st_mode & 0o077:
            raise RuntimeError("Studio access config must be private (chmod 600).")
        data = json.loads(path.read_text())
        origin = os.environ.get("VISCERA_AUTH_ORIGIN", "http://127.0.0.1:5180").rstrip("/")
        return cls(data["username"], data["password_hash"], origin,
                   Path(os.environ.get("VISCERA_AUTH_DB", ROOT / "data/studio-access.sqlite")),
                   public_welcome=os.environ.get("VISCERA_PUBLIC_WELCOME") == "1")


def safe_next(value: str | None) -> str:
    if not value or len(value) > 2048:
        return "/"
    decoded = value
    for _ in range(3):
        decoded = unquote(decoded)
    if (not decoded.startswith("/") or decoded.startswith("//") or "\\" in decoded
            or any(ord(c) < 32 or ord(c) == 127 for c in decoded)
            or decoded.split("?", 1)[0].startswith("/auth")):
        return "/"
    parsed = urlsplit(decoded)
    return value if not parsed.scheme and not parsed.netloc else "/"


class AccessStore:
    def __init__(self, config: AccessConfig):
        self.config = config
        self.version = hashlib.sha256(f"{config.username}\0{config.password_hash}".encode()).hexdigest()
        if config.public_welcome:
            # Visitor sessions can never unlock a restored private deployment.
            self.version = hashlib.sha256(f"public-welcome\0{self.version}".encode()).hexdigest()
        config.database.parent.mkdir(parents=True, exist_ok=True)
        # Create privately before SQLite opens it, not after a potentially readable creation.
        fd = os.open(config.database, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        config.database.chmod(0o600)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires REAL, version TEXT);
                CREATE TABLE IF NOT EXISTS attempts (peer TEXT, at REAL);
                CREATE INDEX IF NOT EXISTS attempts_time ON attempts(at);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.config.database, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def verify(self, username: str, password: str) -> bool:
        _, iterations, salt, expected = self.config.password_hash.split("$")
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        # Perform the same expensive hash for unknown usernames.
        user_ok = hmac.compare_digest(username.encode(), self.config.username.encode())
        return hmac.compare_digest(actual.hex(), expected) and user_ok

    def attempt(self, peer: str) -> int:
        now = time.time()
        peer_hash = hashlib.sha256(peer.encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM attempts WHERE at < ?", (now - 60,))
            total = db.execute("SELECT count(*) FROM attempts").fetchone()[0]
            count, first = db.execute("SELECT count(*), min(at) FROM attempts WHERE peer=?", (peer_hash,)).fetchone()
            if count >= 5 or total >= 60:
                return max(1, int((first or now) + 61 - now))
            db.execute("INSERT INTO attempts VALUES (?, ?)", (peer_hash, now))
        return 0

    def create_session(self) -> tuple[str, float]:
        token, expires = secrets.token_urlsafe(32), time.time() + self.config.session_seconds
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires <= ? OR version != ?", (time.time(), self.version))
            # Private access bounds the owner's devices. Public visitors must
            # not evict one another when more than twenty people enter.
            if not self.config.public_welcome:
                db.execute("DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 19)")
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (hashlib.sha256(token.encode()).hexdigest(), expires, self.version))
        return token, expires

    def session(self, token: str) -> float | None:
        if not token or len(token) > 128:
            return None
        with self.connect() as db:
            row = db.execute("SELECT expires FROM sessions WHERE digest=? AND expires>? AND version=?",
                             (hashlib.sha256(token.encode()).hexdigest(), time.time(), self.version)).fetchone()
        return row[0] if row else None

    def revoke(self, token: str):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE digest=?", (hashlib.sha256(token.encode()).hexdigest(),))


class StudioAccess(BaseHTTPMiddleware):
    def __init__(self, app, config: AccessConfig | None = None):
        super().__init__(app)
        self.config = config or AccessConfig.from_env()
        self.store = AccessStore(self.config)

    async def dispatch(self, request: Request, call_next):
        response = await self.handle(request, call_next)
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN",
            "X-Robots-Tag": "noindex, nofollow",
        })
        if request.url.path.startswith("/auth/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
                "font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
            )
        if request.url.path.startswith("/auth/recorder/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                "media-src blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
            )
        if self.config.secure:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    async def handle(self, request: Request, call_next):
        if request.headers.get("host", "") != urlsplit(self.config.origin).netloc:
            return JSONResponse({"detail": "Use the configured studio address."}, 403)
        path = request.url.path
        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("origin") != self.config.origin:
            return JSONResponse({"detail": "This request must come from the studio."}, 403)
        if path.startswith("/auth/recorder/") and request.method in {"GET", "HEAD"}:
            return recording_asset(path.removeprefix("/auth/recorder/"))
        if path.startswith("/auth/ui/") and request.method in {"GET", "HEAD"}:
            asset = path.removeprefix("/auth/ui/")
            if self.config.public_welcome and asset == "login.js":
                return Response(status_code=404)
            return FileResponse(UI / asset) if asset in PUBLIC_ASSETS else Response(status_code=404)
        token = request.cookies.get(self.config.cookie, "")
        expires = await run_in_threadpool(self.store.session, token)
        if path == "/auth/login" and request.method in {"GET", "HEAD"}:
            if expires:
                return RedirectResponse(safe_next(request.query_params.get("next")), status_code=303)
            return FileResponse(UI / ("welcome.html" if self.config.public_welcome else "index.html"), media_type="text/html")
        if path == "/auth/session" and request.method == "GET":
            return (JSONResponse({"user": "Visitor" if self.config.public_welcome else self.config.username,
                                  "expiresAt": expires * 1000}) if expires
                    else JSONResponse({"detail": "Sign in to enter the studio."}, 401))
        if path == "/auth/enter" and request.method == "POST" and self.config.public_welcome:
            await run_in_threadpool(self.store.revoke, token)
            token, expires = await run_in_threadpool(self.store.create_session)
            response = JSONResponse({"next": safe_next(request.query_params.get("next"))})
            response.set_cookie(self.config.cookie, token, max_age=self.config.session_seconds, httponly=True,
                                secure=self.config.secure, samesite="strict", path="/")
            return response
        if path == "/auth/login" and request.method == "POST":
            if self.config.public_welcome:
                return Response(status_code=404)
            retry = await run_in_threadpool(self.store.attempt, request.client.host if request.client else "unknown")
            if retry:
                return JSONResponse({"detail": "Too many attempts. Please try again shortly."}, 429, headers={"Retry-After": str(retry)})
            if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                return JSONResponse({"detail": "Use the sign-in form."}, 415)
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 4096:
                    return JSONResponse({"detail": "Sign-in request is too large."}, 413)
            try:
                data = json.loads(body)
                username, password = data.get("username"), data.get("password")
                if not isinstance(username, str) or not isinstance(password, str) or not 1 <= len(username) <= 128 or not 1 <= len(password) <= 512:
                    raise ValueError()
            except (ValueError, AttributeError, UnicodeDecodeError):
                return JSONResponse({"detail": "Enter your username and password."}, 400)
            if not await run_in_threadpool(self.store.verify, username, password):
                return JSONResponse({"detail": "Username or password is incorrect."}, 401)
            # Rotate any previous session on successful authentication.
            await run_in_threadpool(self.store.revoke, token)
            token, expires = await run_in_threadpool(self.store.create_session)
            response = JSONResponse({"next": safe_next(data.get("next") if isinstance(data.get("next"), str) else None)})
            response.set_cookie(self.config.cookie, token, max_age=self.config.session_seconds, httponly=True,
                                secure=self.config.secure, samesite="strict", path="/")
            return response
        if path == "/auth/logout" and request.method == "POST":
            await run_in_threadpool(self.store.revoke, token)
            response = JSONResponse({"ok": True})
            response.delete_cookie(self.config.cookie, path="/", secure=self.config.secure, httponly=True, samesite="strict")
            return response
        if path.startswith("/auth/"):
            return Response(status_code=404)
        if not expires:
            if request.method in {"GET", "HEAD"} and (path.endswith("/") or path.endswith(".html")):
                target = safe_next(path + ("?" + request.url.query if request.url.query else ""))
                return RedirectResponse("/auth/login?next=" + quote(target, safe=""), status_code=303)
            return JSONResponse({"detail": "Sign in to enter the studio."}, 401)
        return await call_next(request)
