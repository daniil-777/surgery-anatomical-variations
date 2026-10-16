# Restoring VISCERA Studio on another device

This repository carries everything the studio, its API, its tests and its deployment package need to run: the code,
the lockfiles, the anatomy references, the released datasets the learned samplers verify, the trained weights the API
loads, and the active model bundles. It does not carry training outputs, deliveries, benchmark evidence or caches
(see *Not in the repository*).

## Prerequisites

- Python 3.11 and [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- Node 24 (`.nvmrc`); pnpm comes through corepack or `npx pnpm@10.17.1`
- About 2 GB of disk for the environments, 300 MB for the checkout
- No account, key or network service: everything runs locally

## Set up

```sh
git clone https://github.com/daniil-777/surgery-anatomical-variations.git viscera
cd viscera
uv sync --extra train --extra disease-data --extra language   # the Python environment (.venv), CPU torch included
npx --yes pnpm@10.17.1 install --frozen-lockfile              # the studio's dependencies
```

## Run

```sh
npx pnpm@10.17.1 dev        # API on :8000 (uvicorn services.api.app:app) + studio on http://127.0.0.1:5174
```

Or separately: `npx pnpm@10.17.1 api` and `npx pnpm@10.17.1 studio`. The text adapter (Qwen2.5-0.5B-Instruct LoRA) is
enabled from *Trained models* in the studio; the first enable downloads the pinned base model (~1 GB) into the Hugging
Face cache.

## Check

```sh
npx pnpm@10.17.1 typecheck && npx pnpm@10.17.1 test           # 30 files, ~270 unit tests (joint flow, realizer, physics…)
uv run --extra train --extra disease-data --extra language pytest tests/python   # ~960 tests; a few skip without the Mac-only evidence
```

`apps/studio/src/atlasLocal.test.ts` and `atlasJointLocal.test.ts` compare the browser realizer and the browser joint
flow with the running API when it answers on :8000, and run their offline parts otherwise.

The generation-2 joint bundle binds two references (male heart, male bladder) to the precision-repaired
`datasets/anatomy-templates/templates-v3`; the API uses that folder automatically when it is present
(`VISCERA_ATLAS_TEMPLATES_V2` overrides it).

## Publish

- The browser-only public copy: `node scripts/build_public_copy.mjs --out public-copy` (the API must run for the
  catalogue, specimen and physics snapshots, or pass `--keep-specimens`), checked by `node scripts/smoke_public_copy.mjs
  public-copy`. GitHub Pages builds and deploys it on every push to main (`.github/workflows/pages.yml`):
  https://daniil-777.github.io/surgery-anatomical-variations/ . The portfolio site builds the same copy from outside
  this repository (`tools/build-anatomy.mjs` there).
- The whole studio with its API as one web app: `docs/HOSTING.md` (Docker image in `deploy/`, Hugging Face Spaces,
  Fly.io, Oracle Cloud in `deploy/oracle/`). `scripts/stage_deploy.py` assembles exactly what the server reads.
- The joint flow for the browser: `scripts/export_joint_web.py` re-exports `apps/studio/public/models/joint-v2` after a
  new bundle is activated.

## Not in the repository

Kept on the development Mac (and its backup), never needed to run the studio, the API, the deploy package or the
unit tests:

| what | size | why it stays out |
| --- | --- | --- |
| `artifacts/joint-v2/` deliveries, `artifacts/colab/`, `artifacts/final-colab/`, `artifacts/joint-vae/upload` | 3.3 GB | training deliveries and Colab bundles; the active weights live in `data/imported-models` |
| `artifacts/ground-truth/` (except one DRENDS frame an e2e test uploads), `artifacts/reference-material/models/sam2.1-hiera-tiny/model.safetensors` | 630 MB | video frames and the optional SAM 2 weights (`scripts/install_reference_sam2.py` restores them from the pinned revision; the config files are committed) |
| `artifacts/models/shape-pilot-v1/scenes/` | 56 MB | sampled scene dumps, unreferenced |
| `benchmarks/` (except `record-editor.mjs` and the whole-scene quality baseline an e2e test reads), `physics-releases/`, `references/`, `disease-qa/`, `physics-review/`, `research-report/` | 2.4 GB | Playwright traces, screenshots, source pilots, review material |
| `datasets/atlas/wording-*`, `datasets/original/`, `datasets/atlas/templates-v1`, `templates-v2`, `debug-v1` | 570 MB | earlier dataset generations; `cohort-v2`, `material-v1`, `language-v1` and `anatomy-templates/templates-v3` are the ones the API and the active bundles verify |
| `disease-releases/clinical-nc-v3`, `artifacts/disease/clinical-nc-run-v1` | 24 MB | non-commercial licence (KiTS19 CC BY-NC-SA): never redistributed |
| `data/*.sqlite` | 15 MB | the local studio's own projects; recreated empty on first start |
| `docs/FINAL_DELIVERY_LINKS.md`, `artifacts/disease/root-verification.json` | 8 KB | private Google Drive links and an absolute path of the development Mac |

Two tests read files that are **in** the repository and would fail without them, so they are kept deliberately:
`tests/python/test_joint_material_compatibility.py` (the frozen decoder in `disease-releases/geometry-v1`) and
`tests/python/test_wording_batched_evaluation.py` (the held-out wording audit under `artifacts/wording-integration-…`).
The second also needs the Qwen tokenizer in the Hugging Face cache:

```sh
uv run hf download Qwen/Qwen2.5-0.5B-Instruct --revision c89bee90d9f811437d9735454613c35b4a3c4dc8 --include 'tokenizer*' vocab.json merges.txt config.json
```

Everything else that reads an excluded path skips (`pytest.skip`) or is an opt-in (`VISCERA_TEST_WEIGHTS`).

Runtime state the API rewrites inside the checkout: the pointer files `data/imported-models/{active,active-joint,
active-joint-v2,joint-selection}.json` change when a model is activated, defaults restored or the text adapter
enabled, so the working tree can show them modified after use; commit them only when a model change is meant.

The whole workspace (~9 GB) lives at `~/Documents/…/portfolio/real-time-web-2D3D-generation/viscera` on the
development Mac.
