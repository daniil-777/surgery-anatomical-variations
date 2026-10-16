# Web deployment — 8 October 2026

Status: **live temporary HTTPS app**, explicitly approved by the user on 8 October 2026.

**https://constant-period-variable-strike.trycloudflare.com/?mode=scene**

The production frontend and Python API share this origin. The app, API health and learned-material data returned HTTP 200 through the public URL; model administration returned 403. The local origin is http://127.0.0.1:8011/. Keep this Mac online and the server/tunnel processes running. This is a temporary deployment, not permanent cloud hosting.

The web entrypoint is `services.web.app:app`. It serves `apps/studio/dist` and the Python API on the same origin, without the Vite development server. The default database is `data/web-studio.sqlite`, separate from the local studio database; override with `VISCERA_WEB_DB`. The existing trained models, datasets and image-analysis dependencies remain available on this machine.

Public visitors cannot import/restore/activate model weights, enable model downloads or enumerate saved projects. Those routes return 403. This is a shared demonstration service, not a multi-user private project store or clinical-data service.

From `viscera`, build with Node 24 and start the server:

```sh
node node_modules/vite/bin/vite.js build --config apps/studio/vite.config.ts
PYTHONPATH=py:. .venv/bin/python -m uvicorn services.web.app:app \
  --host 127.0.0.1 --port 8011 --limit-concurrency 16 --timeout-keep-alive 5
```

Verified locally: frontend, `/api/health`, the complete torso GLB and reference-material status return 200; model administration and project listing return 403. The production build passes. Existing development servers are preserved.

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) provides a temporary public HTTPS URL while the Mac and server processes stay running. It is not permanent cloud hosting. Fly.io's CLI is installed but has no authenticated account; a permanent Python deployment needs an authenticated server host and the required model/data artifacts.

## Hosting the whole studio publicly

The tunnel above is temporary and runs on this Mac. `docs/HOSTING.md` describes the container package (`deploy/`,
`scripts/stage_deploy.py`, `scripts/publish_space.sh`, `scripts/probe_web_app.py`) that publishes this same web entry
with all its features on Hugging Face Spaces or Fly.io.
