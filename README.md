# VISCERA Studio

**Temporary web app (8 October 2026):** [Open the whole anatomy scene](https://constant-period-variable-strike.trycloudflare.com/?mode=scene). The link needs the host Mac and server processes to remain running. [Hosting details](docs/WEB_DEPLOYMENT.md).

**Whole-body colour (8 October 2026):** Whole scene → Whole-body colour combines several reviewed tissue regions into one reversible body palette. Six licensed surgical photographs and seven reviewed masks are included, with multi-image upload, per-organ provenance, and optional bounded colour inference for unseen soft structures. [Usage, research and verification](docs/WHOLE_BODY_COLOUR.md).

**Surgical reference colours (8 October 2026):** Organ studio → Surface and Whole scene → selected organ now support reviewed image-to-material colour transfer, optional local SAM2.1 segmentation, strength/brightness controls and colour-preserving Atlas exports. [Usage, current research, tests and visual assessment](docs/REFERENCE_MATERIAL_TRANSFER.md). Organ identity is confirmed by the user; observed colours are not calibrated tissue optics.

**Atlas wording update (7 October 2026):** Context-aware instructions such as “make the liver healthier” now edit supported visual disease controls. A 240,000-example wording dataset, resumable Qwen LoRA Colab notebook, evaluation gates and automatic Downloads import are prepared. [Training and use](docs/WORDING_TRAINING_V2.md), [research](docs/research/ANATOMY_WORDING_2026-10-07.md), and [verification](benchmarks/results/wording-v2-2026-10-07/README.md). Full GPU training and final model accuracy are established by running the notebook.

**Atlas surface authoring update (7 October 2026):** Surface vessels, direct point-drag sculpture with undo/redo, and Unity 4K materials are now available in the main Atlas workspace. [Usage, research and verified export packages](docs/SURFACE_AUTHORING.md). The legacy procedural workflow below remains available separately.

An executable local anatomy workspace, original procedural dataset factory, and reproducible shape and language training workflows. The current implemented organ families are **liver and gallbladder**. This is an engineering development release; independent anatomical and measured-tissue validation remain pending.

## Open the studio

Use Node 24 and Python 3.11. Run from this directory:

```sh
uv sync --extra train
npx --yes pnpm@10.17.1 install --frozen-lockfile
npx --yes pnpm@10.17.1 dev
```

Open **http://127.0.0.1:5174**. The local API runs on port 8000. No external account or API key is required. The bundled high-resolution specimen can be viewed and edited without the API; new specimen generation and text compilation require it.

The initial liver contains 36,480 triangles. Shape construction supports three resolutions; the simulation uses a separate 528-tetrahedron proxy with a verified reference mapping to the detailed surface. More triangles improve surface sampling, not anatomical evidence.

## Author an anatomy

- Select organs in the scene panel; hide or lock them independently.
- Use dimensions, curvature, volume controls and local grab/inflate/twist/smooth brushes. Undo and redo restore actual geometry.
- Change left-lobe proportion, inferior concavity, fissure depth or gallbladder dimensions using the anatomy recipe. Rebuilding an edited organ is explicit; unchanged surfaces are preserved by immutable snapshots.
- Type **“increase liver width by 10%”**, **“liver width 245 mm”**, or **“elongated gallbladder”**. Review the interpreted change before applying. Unsupported, ambiguous or contradictory requests do not partially execute.
- New variation samples correlated construction controls. A seed identifies the sample; changing only a seed under fixed explicit controls principally changes appearance.
- Run the liver probe and recovery preview. It reports actual simulation time, minimum Jacobian, volume drift, peak displacement and remaining displacement. The terminal state stays visible until Reset. Save its JSON report.
- Export editable project JSON, visible-object GLB in metres, or a viewport image. The API also exports OBJ in millimetres and `.viscera` bundles with fresh surface QA. Project imports undergo structural validation.

The browser deformation model is a CPU tetrahedral XPBD spring/volume approximation with declared supports and heuristic material parameters. The separate offline mechanics module implements and verifies the polynomial rest-stable Neo-Hookean variant and block fixtures (see [exact formulation](docs/MECHANICS.md)). Neither establishes human tissue behavior; browser and offline solvers are intentionally identified separately.

## Original dataset and training

The frozen `datasets/original/pilot-v0` release contains 128 broad-control assemblies (89/19/20 train/validation/test). Its large-size tail makes it a **stress-test release**, not a normal adult distribution. `pilot-v1` uses the narrower, correlated `adult_design_v1` sampling profile and a declared authoring volume band. Both remain one procedural lineage with unreviewed synthetic anatomy; synthetic siblings do not establish independent biological generalization.

Dataset assets include realized geometry, construction parameters, measured labels, seed/lineage identifiers, provenance, split membership, paired descriptions, rejection records and SHA-256 hashes. See [dataset instructions](pipelines/data/README.md) and [template instructions](pipelines/templates/README.md).

The shape model is a real compact conditional rectified flow over procedural-control latents. Its explicit bounded-logit transform keeps construction controls inside their declared intervals without clipping; the procedural decoder turns them into meshes, which must still pass geometry gates. It is compared with conditional PCA and nearest-design baselines. On 32 fresh procedural samples evaluated after model selection was frozen, all three methods passed 32/32 geometry gates. Flow achieved mean absolute liver-volume error of 93.69 mL and width error of 4.87 mm; PCA was more accurate at 75.42 mL and 3.55 mm. All five tested flow conditioning directions were correct. See the [model card](artifacts/models/shape-pilot-v1/MODEL_CARD.md) for scope and tradeoffs; this compact synthetic parameter model is not a general 3D foundation model.

```sh
uv run --extra train python -m pipelines.train.viscera_train.shape train \
  --data datasets/original/pilot-v1 --out artifacts/models/shape-pilot-v1 \
  --steps 600 --device cpu
uv run --extra train python -m pipelines.train.viscera_train.shape evaluate \
  --data datasets/original/pilot-v1 --model artifacts/models/shape-pilot-v1/model.pt \
  --split test --out artifacts/models/shape-pilot-v1/test_evaluation.json
```

Training preprocessing uses the training split only. Checkpoints include optimizer, RNG and data-order state; interrupted CPU training is tested for exact replay. The original 20 test rows were observed during development and now form a fixed development benchmark. The separate 32-sample post-freeze audit was reserved exclusively for final evaluation, with no fitting or model selection on those rows. All samples still share one authored procedural lineage.

The studio's text compiler is deterministic and local. The optional language experiment trains a separate text-to-typed-patch adapter; it does not replace the shape model or deterministic validator. Its synthetic wording benchmark and unrun pretrained/LoRA stages are recorded separately.

## Google Colab

1. Use the prepared [source ZIP](artifacts/colab/viscera-colab-source.zip), or run `uv run python scripts/package_colab.py` to rebuild it. A [source + 128-sample dataset ZIP](artifacts/colab/viscera-colab-with-dataset.zip) is also provided.
2. Open `notebooks/VISCERA_original_dataset_and_shape_training.ipynb` in Colab, select a GPU if available, and upload the ZIP when requested.
3. Run the cells to generate original samples, train and compare models, evaluate, run numerical mechanics checks, preview variations and download the results.
4. For the separate optional language model, open `notebooks/VISCERA_optional_language_LoRA.ipynb`.

The shape notebook's code cells have been executed locally end to end on CPU. Colab GPU, Drive mounting and cloud downloads require a real Colab session and are not claimed as tested. The optional language notebook contains an actual LoRA workflow with pinned model revision and dependency hashes; pretrained weights and the adapter have not been trained locally.

## Local checks and evidence

```sh
uv run --extra train --extra language pytest
npx --yes pnpm@10.17.1 typecheck
npx --yes pnpm@10.17.1 test
npx --yes pnpm@10.17.1 build
npx --yes pnpm@10.17.1 exec playwright install chromium
npx --yes pnpm@10.17.1 test:e2e
```

Playwright records real editor videos, exported artifacts and probe metrics. On macOS it uses the Metal renderer to avoid measuring a software rasterizer as device performance. See the [editor recording](benchmarks/results/local/editor-probe.webm), [verification report](benchmarks/results/local/verification.json), [acceptance and remaining work](docs/ACCEPTANCE.md), `artifacts/review/`, and the model cards beside each checkpoint. The optional language integration test uses a tiny randomly initialized model to verify real LoRA training/save/reload; it does not measure pretrained language understanding.

Public dataset downloads, external generative APIs and expert sign-offs are not fabricated. Current limits include one authored topology family per organ, simplified visceral detail and wall construction, display-only vascular scaffolds, heuristic appearance, no general self-contact solver, no clinical validation, and no hosted product deployment. [The implementation ADR](docs/adr/0001-local-pilot.md) records the deliberate local architecture choices.
