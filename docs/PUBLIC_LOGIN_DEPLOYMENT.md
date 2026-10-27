# Public login deployment — 27 October 2026

Permanent login: <https://viscera-studio-daniil.fly.dev/auth/login>

Existing entry link: <https://daniil-777.github.io/surgery-anatomical-variations/>

2D / 3D Generation Lab: <https://daniil-777.github.io/generation-lab/>

VISCERA now runs on Fly.io in Frankfurt independently of the Mac, Wi-Fi, and
temporary Cloudflare tunnels. Sign in with the existing username and password.
The owner explicitly authorized transferring the username and password hash to
Fly's encrypted secrets. The plaintext password was not transferred, and the
credential configuration is excluded from the image, frontend, repository and
deployment receipt.

The served release is the installed `app-recorder-2026-10-26` browser studio,
including its current scenes, labs, models and recorder. This deployment keeps
the existing browser features; it does not add GPU inference or the heavyweight
generation API. The local private studio on port 5180 remains separate.

## Hosting and recovery

One always-on shared CPU / 512 MB machine serves the protected app. SQLite
sessions and login rate limits use a 1 GB encrypted volume with daily snapshots
retained for five days. The app validates its fixed HTTPS origin, rejects
unconfigured access, and protects studio HTML, JavaScript, models and API paths.
Sessions retain Secure, HttpOnly and SameSite=Strict cookies and server-side
revocation.

The platform checks the login page every 30 seconds. A supervisor checks both
the login form and authentication boundary and requests a restart after three
consecutive failures. Fly automatically restarts an exited process. GitHub
Actions schedules additional public checks every five minutes, subject to
GitHub's scheduling delays and repository-inactivity rules.

The Pages gateway checks availability before redirecting and preserves the
chosen workspace query. During an outage it offers retry and the Generation
Lab link. It contains only four gateway files; never publish `public-copy` to
Pages, because that would expose an unauthenticated app copy.

The estimated VISCERA cost is about $4.41/month before traffic and tax, or
$6.41 with 100 GB European outbound traffic. This is within the requested
$10/month budget at that usage level, not a hard billing cap. Fly bills extra
traffic. One regional machine and volume cannot guarantee zero downtime during
provider outages or deployments.

See [BROWSER_CLOUD_HOSTING.md](BROWSER_CLOUD_HOSTING.md) for configuration,
deployment commands, the initial image reference, recovery and cost details.

## Verification

The 45 authentication/recorder/cloud tests and three gateway behavior tests
passed. Live cloud checks confirmed the login is public, invalid credentials
are rejected, and unauthenticated model/catalog/session requests return 401.
A short-lived server-issued QA session retrieved byte-identical application,
scene, model and recorder assets. Logout revoked it and blocked assets again.
The QA session was removed after verification.

A deliberate HTTP-worker crash triggered automatic recovery. Fly recorded a
started machine 1.67 seconds after exit, and the health check passed afterward.
The persistent session database survived the restart. Normal-DNS HTTPS login
and authentication checks passed from the Mac. The gateway's online redirect,
preserved scene query, offline retry message, timeout and recovery were checked
with unit tests and a browser preview.

Secret-free deployment evidence is retained locally under
`artifacts/browser-cloud-hosting-2026-10-27/`.

## Retired temporary hosting

The previous `shuttle-sample-peripheral-ace.trycloudflare.com` hostname expired
when its server and tunnel stopped. The replacement
`exclusive-haven-significance-playstation.trycloudflare.com` was only an interim
recovery endpoint. The Fly origin replaces both; do not distribute old tunnel
links. The old public runtime directory is retained locally for historical
logs, independently of the private local app.

Repository variable `VISCERA_STUDIO_ORIGIN` now points to the fixed Fly origin.
Rollback uses a known-good protected cloud image with the same secret and
volume; it must never restore the public Pages app assets. The portfolio
repository's Pages settings remain unchanged. The VISCERA source repository
is public; web authentication does not restrict material already in Git history.
