# Public Welcome entrance — 2 November 2026

The existing public studio uses a Welcome button in place of username and
password fields. The original login HTML, JavaScript, password verifier and
credential secret are retained. Local private installations keep their current
behaviour; only the cloud release sets `VISCERA_PUBLIC_WELCOME=1`.

The button creates a temporary visitor session without credentials and retains
the requested workspace. The installed studio bundles, scenes, models and
recorder stay byte-identical. Leaving the studio returns to Welcome. The
session service returns `Visitor`, never the owner's username. Public visitor
sessions use a separate version so they cannot unlock a restored private site.

Build the release from the installed browser assets and this entrance source:

```sh
python3 scripts/stage_browser_cloud.py --release '/path/to/installed/release' \
  --out /private/tmp/viscera-welcome-release --app viscera-studio-daniil \
  --region fra --public-welcome
fly config validate --config /private/tmp/viscera-welcome-release/fly.toml
fly deploy /private/tmp/viscera-welcome-release \
  --config /private/tmp/viscera-welcome-release/fly.toml \
  --remote-only --depot=false --ha=false
```

Keep the existing volume, secret, app name and one-machine capacity. The
supervisor checks the expected entrance for the configured mode. The external
monitor accepts either entrance and still checks that assets require an entry
session. The Pages gateway keeps the same URL and workspace forwarding, with
Welcome wording.

Verification: run `tests/python/test_studio_welcome.py`, the existing private
access and cloud recovery tests against the staged service, the gateway tests,
and `node scripts/check_studio_welcome.mjs --url <origin> --out <evidence-dir>`.
The browser check covers responsive layouts, reduced motion, keyboard focus,
retry, direct scene entry, refresh and leaving the studio.

To restore credentials, remove `VISCERA_PUBLIC_WELCOME` from the cloud config
and redeploy the same image/configuration, keeping the existing secret and
volume. The default is private access. Alternatively deploy the prior image
`registry.fly.io/viscera-studio-daniil:deployment-01M5YVQBS15GDPTCZQS9JKB2BJ`
with the previous private configuration. Update the gateway copy if restoring
the private entrance. No password reset is required.
