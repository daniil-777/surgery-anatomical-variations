# VISCERA browser hosting

Status: image and configuration prepared on 27 October 2026; activation is
pending explicit authorization to transfer the existing login configuration.
The public gateway still uses the working Mac-hosted studio until cloud
verification is complete. The configuration below describes the cloud target.

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
