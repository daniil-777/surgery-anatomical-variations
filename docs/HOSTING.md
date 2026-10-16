# Hosting the whole studio as one public web app

The static copy on GitHub Pages (`anatomy/` in the portfolio site) runs the shape, appearance and surface work in the
browser and refuses what needs the Python API. This page is the other option: the complete studio, API included, on a
container host. Everything the local studio does works except two things the web entry disables on purpose
(`services/web/app.py`): replacing or activating weights, and listing saved projects.

## What gets published

`scripts/stage_deploy.py` assembles a tree with only what the server reads (about 330 MB):

| part | why |
| --- | --- |
| `py/`, `services/`, `pipelines/train/viscera_train` | the API, the web entry, and the training package the learned samplers import |
| `apps/studio` sources + lockfiles + `packages/` + `tsconfig.base.json` | the image builds the studio itself (no source maps, base `/`), including `textures.html`, the texture lab page |
| `datasets/atlas/cohort-v2`, `material-v1`, `language-v1` | the learned samplers verify these release digests before answering |
| `disease-releases/recipes-v2`, `clinical-ccby-v3` | disease recipes and the CC BY clinical retrieval lane |
| `artifacts/physics`, `joint-vae/default`, `models/shape-pilot-v1`, `atlas/run-v2`, `disease`, `language` | the weights the API loads |
| `data/imported-models` | the active bundles (joint VAE generation 2, the ridge lanes, the text adapter) |

Never staged: `disease-releases/clinical-nc-v3` (non-commercial), `disease-releases/geometry-v1` (only the weight
importer verifies it, and importing is refused on the public server), benchmarks, notebooks, reviews, the 3 GB joint
delivery. The TypeScript and Python sources do travel with the Space repository; a private Space keeps them private.

## Which host (and why not Oracle's free tier)

`docs/HOSTING_OPTIONS.md`: the app's time is single-threaded NumPy, so single-core speed decides; Hetzner AX42, Oracle
E6.Flex (x86, paid) and Netcup RS 2000 rank first; Oracle Always Free's ARM core is 2–3× slower per request. The
provider-neutral server package for any Ubuntu 24.04 x86 box is `deploy/server/` (Docker, Caddy with automatic HTTPS).

## Hugging Face Space (Docker)

1. Once: `hf auth login` with a write token (https://huggingface.co/settings/tokens).
2. `scripts/publish_space.sh <user>/<space> [--private]` stages, creates the Space and uploads. Hugging Face builds
   `deploy/Dockerfile` (10–20 minutes the first time: torch CPU wheels, the pinned Qwen base for the text adapter,
   the Vite build) and serves on port 7860 at `https://<user>-<space>.hf.space`.
3. `python scripts/probe_web_app.py https://<user>-<space>.hf.space` exercises every feature the public app promises.

The free CPU tier (2 vCPU, 16 GB) runs the whole thing; a physics experiment takes about 5 s there, a joint sample
under a second, a trained text command a few seconds. The demo database (`VISCERA_WEB_DB`) is ephemeral: snapshots and
projects vanish on restart. A Space sleeps after 48 h without visitors and wakes on the next request (about a minute).

## Fly.io

From the staged tree: `fly auth login`, `fly launch --copy-config --no-deploy` (uses `fly.toml`: 4 GB machine, stops
when idle), `fly deploy`. Same image, same environment variables.

## Rehearsing without Docker

`scripts/verify_stage.sh` runs the staged tree with this workspace's Python environment, the container's entry point,
environment and port, then runs the probe. It needs the text adapter's base model in the local Hugging Face cache
(`Qwen/Qwen2.5-0.5B-Instruct`, pinned revision in `pipelines/train/viscera_train/atlas_language.py`).

## Environment the container sets

`VISCERA_WEB_PRELOAD_LANGUAGE=1` loads the imported text adapter before the port opens (visitors cannot trigger model
downloads: that route answers 403). `HF_HUB_OFFLINE=1` keeps the server from ever contacting the Hub. `OMP_NUM_THREADS=2`
matches the free tier. `--limit-concurrency 64` (open connections, not requests: a reverse proxy's pool and a page load's asset burst must fit under it) makes the server answer 503 instead of queueing without bound; behind Caddy, `max_conns_per_host 24` queues at the proxy first.

## Making the public copy use the host

The static copy on GitHub Pages reads `anatomy/api.json` before its first render. With `{"api": null}` it stays the
browser-only copy; with `{"api": "https://<host>"}` every request goes to that host and all features work there, with
the same pages, links and layout. Two conditions: the host must serve HTTPS (a page on https cannot call http), and the
API must allow the Pages origin: start the container with `VISCERA_CORS_ORIGINS=https://daniil-777.github.io`
(`services/api/app.py` adds it to the CORS allow-list; GET and POST with JSON, no credentials). `tools/build-anatomy.mjs`
carries the file across rebuilds, so it is edited once and committed. Rehearsed on 2026-10-16 with the copy on one local
origin and the web app on another: catalogue, generation and a disease joint variation all crossed origins cleanly.

## Known limits of the published studio

* The ridge material sampler (`/api/atlas/sample-material`) answers "Material model/decoder source drift" here and
  locally: `py/viscera_core/atlas_materials.py` changed after the material-v1 release froze its generator hash. The
  joint shape + colour VAE is the current model and is unaffected.
* SAM 2 segmentation for photograph analysis is not installed (the local random-walker segmentation is).
* Nothing is clinically validated; the Space README says so.
