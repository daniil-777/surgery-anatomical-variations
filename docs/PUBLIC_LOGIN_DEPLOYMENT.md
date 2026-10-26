# Public login deployment — 26 October 2026

Public login: https://shuttle-sample-peripheral-ace.trycloudflare.com/auth/login

The existing address, https://daniil-777.github.io/surgery-anatomical-variations/,
is being changed to a redirect to the protected studio. GitHub Pages must contain
only the files from `scripts/build_login_gateway.py`; publishing `public-copy`
there would expose an unauthenticated copy of the app.

Everyone can reach the login page. Entering the studio requires the existing
configured username and password. This deployment does not create visitor
accounts, change the password, or publish credentials. The server protects all
studio entry points, JavaScript bundles, model files, and API paths. HTTPS
sessions use Secure, HttpOnly, SameSite=Strict cookies and server-side revocation.

The served build is the installed `app-recorder-2026-10-26` browser studio, with
1,204 files (342 MB), including its existing scene, labs and recorder. This is
the browser build; API-dependent generation features are not added by this
deployment. The authenticated local studio remains on port 5180. The separate
public process listens on loopback port 5182 and checks the public Host and
Origin before handling requests. Its session database is separate.

## Hosting lifetime

This is a temporary Cloudflare Quick Tunnel, not permanent cloud hosting. The
Mac must remain awake and connected, and both the tunnel and server processes
must keep running. Restarting the tunnel creates a different hostname. There
is no uptime guarantee. For a permanent address, configure a named Cloudflare
tunnel and domain or deploy the Python server to an authenticated server host.

The runtime and status are under `~/Library/Application Support/Viscera/public-studio/`:

- `deployment.json`: current origin and process IDs, no secrets.
- `sessions.sqlite`: private public-endpoint sessions; never upload this file.
- `runner.log`, `server.log`, `tunnel.log`: operational logs; access logging is disabled.
- `serve_public_studio.py`, `cloudflared`: the supervisor and verified official client.

`scripts/serve_public_studio.py` supervises the server and tunnel together and
stops both if either exits. To restart, stop the old runner using its recorded
PID, verify port 5182 is free, and run the script with `--cloudflared` and
`--state` pointing to that runtime directory. It reuses the installed login
configuration without printing or changing credentials.

After a hostname change, set the GitHub repository variable
`VISCERA_STUDIO_ORIGIN` to the new HTTPS origin and run the `pages` workflow.
The workflow publishes only a tiny redirect, preserving workspace query
parameters. Its build rejects an invalid origin or a nonempty output directory.
Do not restore the old Pages application workflow as a rollback: it bypasses
login. If the protected host is down, retain the gateway while restoring it.

The portfolio repository has GitHub Pages disabled; this deployment does not
enable it. The Viscera source repository remains public; web authentication
does not restrict material already published in Git history.

## Verification

The existing authentication and recorder HTTP tests passed (40 tests). Public
HTTPS checks confirmed login/UI assets return 200, studio navigation redirects
to login, and direct model/catalog/session requests return 401, with no-store
and HTTPS security headers. The login browser checks and authenticated session
smoke test are recorded under `artifacts/public-login-deployment-2026-10-26/`.

Official hosting reference: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
