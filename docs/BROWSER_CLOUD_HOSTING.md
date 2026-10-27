# VISCERA browser hosting

Activated on 27 October 2026 after explicit authorization to transfer the
existing username and password hash to Fly's encrypted secrets. The cloud login
and protected assets are verified. The public gateway uses the fixed cloud
origin; the temporary Mac tunnel is retired after gateway rollout.

The cloud target is `viscera-studio-daniil`, in Frankfurt (`fra`). Its fixed origin
is `https://viscera-studio-daniil.fly.dev`. The GitHub Pages address remains a
small sign-in gateway. The generation portal can keep linking to that gateway.

## Release and authentication

`scripts/stage_browser_cloud.py` packages the installed `app-recorder-2026-10-26`
browser release, including its current scenes, labs and recorder. It copies only
the browser assets and Python web service and writes a SHA-256 file manifest.
It rejects credential files, session databases and symlinks. This is the existing
browser app; it does not add the heavyweight generation API or GPU inference.

The image never contains login credentials. The existing login configuration
must be authorized for transfer and stored as Fly secret
`VISCERA_ACCESS_CONFIG_B64`. The entrypoint decodes it into a private mode-0600
runtime file and removes it from the child process environment. It hands the
session volume to uid 1000, drops root, validates the login configuration, and
only then starts the server. Missing or invalid configuration prevents startup.
Do not log the secret, put it on a command line, commit it, or put it in the
build context. Do not configure Fly `[[statics]]`: it bypasses web middleware.

## Recovery

- One shared CPU / 512 MB machine stays running; auto-stop is disabled.
- Fly restarts the machine when the main process exits (`always`).
- The supervisor checks the actual login form and unauthenticated session
  rejection every 20 seconds after a 30-second startup grace period. Three
  consecutive failures terminate the server and request a platform restart.
- The Fly HTTP check requests `/auth/login` with the expected Host every
  30 seconds. Unhealthy instances are removed from routing.
- A 1 GB encrypted volume holds SQLite sessions and login rate limits. Daily
  snapshots retain five days. Browser work continues to use its existing
  browser/local export storage behavior.
- GitHub Actions schedules an external HTTPS/login/authentication-boundary
  check every five minutes. GitHub may delay schedules or disable them after
  prolonged repository inactivity; the on-server supervisor remains active.
  Check failures are visible under the `VISCERA availability` workflow.
- The Pages gateway probes the public login artwork before redirecting. During
  an outage it shows a retry message, retries after 30 seconds, and keeps a
  link to the generation portal. A failed probe times out after eight seconds.
  The script URL changes with its content so a new destination does not reuse
  an old cached redirect script.

One machine and one regional volume cannot provide zero downtime during a host
or regional outage. Deployments/restarts may briefly interrupt service. The
permanent URL and cloud runtime remove the Mac, Wi-Fi, sleep state, and expiring
Quick Tunnel hostname from normal availability.

## Cost envelope

The Fly calculator on 27 October 2026 estimated $4.26/month for one shared CPU
with 512 MB in Frankfurt, plus $0.15 for 1 GB storage: about $4.41/month before
traffic and tax. At 100 GB outbound traffic, the estimate is $6.41 before tax.
European outbound traffic is $0.02/GB. This is an estimate within the requested
$10/month budget, not a hard billing cap. Fly does not provide billing alerts
or a spending ceiling; unusually high traffic can exceed the budget. Review
current-month usage in the Fly dashboard. No autoscaler, paid dedicated IPv4,
managed database, GPU, or second application instance is provisioned.

References: <https://fly.io/calculator/>,
<https://docs.fly.io/about/pricing/>,
<https://docs.fly.io/about/cost-management/>.

## Deploy and verify

```sh
python3 scripts/stage_browser_cloud.py \
  --release '/path/to/installed/browser/release' \
  --out /private/tmp/viscera-cloud-release \
  --app viscera-studio-daniil --region fra
fly config validate --config /private/tmp/viscera-cloud-release/fly.toml
fly deploy /private/tmp/viscera-cloud-release \
  --config /private/tmp/viscera-cloud-release/fly.toml \
  --remote-only --depot=false --ha=false
python3 scripts/check_browser_uptime.py \
  --origin https://viscera-studio-daniil.fly.dev
fly checks list --app viscera-studio-daniil
fly machine list --app viscera-studio-daniil
```

Always retain `--ha=false`: the budget covers one machine. Keep the existing
volume and secret when deploying updates. Record the successful image reference
before updating. Roll back by deploying that image with the same configuration
and `--ha=false`; never publish `public-copy` to GitHub Pages as a fallback.

Only after the protected endpoint is verified, set repository variable
`VISCERA_STUDIO_ORIGIN` to its origin and run `pages`. Check the deployed
`gateway.js`, login response and protected model responses after the workflow.
The old Mac tunnel can then be stopped; the local private app remains separate.

Before release, run the authentication/recorder/cloud Python tests and
`node --test tests/browser-cloud-gateway.test.mjs`. Validate a machine restart
before switching the public gateway, including volume persistence and recovery.

## Initial release verification

Image: `registry.fly.io/viscera-studio-daniil:deployment-01M5YVQBS15GDPTCZQS9JKB2BJ`

Digest: `sha256:9537d3ea17ccb25dad94deb4ec0514662732a3ee09d9c43730c46e87443eea35`

Machine: `48edd237c45648`; volume: `vol_r1j7w383o07oxqpr`.

The 45 authentication, recorder and recovery tests and four gateway behavior
tests passed. Live checks verified invalid-login rejection, an authenticated
five-minute QA session, byte-identical app/scene/model/recorder assets, and logout
revocation. The QA session was revoked. The HTTP worker runs as uid 1000 without
the raw Fly secret in its environment; the private runtime configuration is 0600.

A controlled HTTP-worker crash triggered the supervisor and Fly restart policy.
Fly recorded exit, automatic restart and a started machine 1.67 seconds later;
the HTTP health check passed afterward. The session database and a temporary
volume marker survived. The marker was removed. Normal-DNS public HTTPS checks
passed after the initial DNS propagation period. The temporary build server was
removed; exactly one 512 MB app machine remains provisioned.
