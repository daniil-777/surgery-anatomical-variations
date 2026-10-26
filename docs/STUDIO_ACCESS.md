# Private studio access

The studio now requires one configured username and password. All workspaces share the session, including direct links to the VirtaMed scene, imports, organ studio, textures, tissue, fat, blood and the original procedural studio. Login does not create or alter saved-study accounts.

**Public HTTPS deployment live since 26 October 2026.** The installed browser studio is served behind this same authentication boundary through a temporary Cloudflare tunnel. GitHub Pages now builds only a sign-in redirect, never the application or model files. See [public deployment operations](PUBLIC_LOGIN_DEPLOYMENT.md) for the active addresses, verification, and hosting limits.

## Configure

From the Viscera repository, run:

```sh
.venv/bin/python scripts/configure_studio_access.py
```

The command asks for the username and password without echoing the password. It stores only a salted PBKDF2-SHA256 hash (600,000 rounds) in `data/studio-access.json`, with owner-only permissions. That file and session databases are ignored by Git. No account registration or password recovery endpoint is exposed by studio access. Reconfigure locally and restart to change credentials; old sessions then become invalid.

## Preview the complete browser build

Build with the existing `node scripts/build_public_copy.mjs --keep-specimens` workflow (or use an already built copy). Then:

```sh
VISCERA_AUTH_ORIGIN=http://127.0.0.1:5180 \
VISCERA_WEB_DIST=public-copy \
.venv/bin/python -m uvicorn services.web.private_preview:app \
  --host 127.0.0.1 --port 5180 --no-access-log --no-proxy-headers
```

Open `http://127.0.0.1:5180/`. A direct scene link retains its mode after sign-in. The preview serves the existing browser-only simulation features. Features requiring the generation API have the same limitation as the current browser build.

The full API + studio entry point, `services.web.app:app`, uses the same mandatory access boundary. Set `VISCERA_WEB_DIST`, `VISCERA_AUTH_ORIGIN`, and optionally `VISCERA_AUTH_CONFIG` and `VISCERA_AUTH_DB`. A non-loopback origin must use HTTPS; secure sessions use `__Host-` cookies. Preserve the configured Host and Origin through a trusted reverse proxy. Bind the Python service to loopback behind that proxy. Do not expose `services.api.app`, Vite, or a raw static file server as an alternate public route.

## Development

`pnpm dev` starts the existing API, Vite, and a loopback session service on port 5181. Open exactly `http://127.0.0.1:5174/`; Vite proxies `/auth/` to that service without changing Host or Origin. Configure credentials before starting. The development server serves source files and is not the private deployment boundary. A built app hosted without the session service refuses to mount its workspaces.

## Session behavior

Sessions expire after eight hours, survive refresh, and are stored as hashed random tokens in SQLite. Cookies are HttpOnly and SameSite=Strict. Sign-out revokes the token on the server, returns open tabs to login, and keeps saved studies intact. Requests changing state must carry the configured Origin. Login is limited to five attempts per client per minute with an additional global bound. Authenticated responses use `Cache-Control: no-store`.

The login page, four reduced-size studio renders, fonts and credits are intentionally public. Model files, application bundles and API responses require a session. A user who has already signed in can still save delivered content; access control is not DRM.

## Verification

```sh
.venv/bin/python -m pytest tests/python/test_studio_access.py -q
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
node scripts/check_studio_access.mjs --credentials /private/temporary-credentials.json --out artifacts/studio-access
```

The temporary browser-test input contains `username` and `password`; keep it outside source control with mode 600 and remove it after testing. The test does not save traces, storage-state files, passwords, or session cookies. Screenshots of the password field remain masked. HTTP tests use independent test credentials and a temporary database. Browser tests cover login states, mobile and desktop layouts, all workspace entry points, session persistence, multi-tab sign-out, and direct asset protection.
