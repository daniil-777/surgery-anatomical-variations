# VISCERA atlas release — 6 October 2026

The atlas editor now uses detailed licensed organ references in place of the original two-organ procedural pilot. The original pilot remains available at `?mode=legacy`. The new release is a reproducible **atlas-derived design dataset**, not a patient cohort or a clinically validated anatomical generator.

## Delivered artifacts

| Artifact | Location | Contents |
|---|---|---|
| Immutable shape cohort | `datasets/atlas/cohort-v2/` | 1,536 explicit recipes, 24 full-resolution templates, 12 organ groups, point samples, measurements, splits and attribution |
| Frozen source templates | `datasets/atlas/templates-v2/` | Source-preserving geometry, cleaning maps, source citations and license snapshots |
| Trained shape model | `artifacts/atlas/run-v2/model.pt` | Selected per-template ridge inverse; neural candidate retained in the comparison evidence |
| Shape training notebook | `notebooks/VISCERA_atlas_dataset_and_training.ipynb` | Dataset verification, baselines, training, true-geometry evaluation, model freeze and audit |
| Paired language corpus | `datasets/atlas/language-v1/` | Contextual edit requests, exact target specs and explicit unsupported labels, grouped with shape parents |
| All-object visual evidence | `benchmarks/results/atlas-cohort-visual-v2/` | 3-view captures, contact sheets, geometry/normal/image hashes and searchable `index.html` |
| Model evidence | `artifacts/atlas/run-v2/` | Freeze record, validation/audit measurements, model card and generated-sample QA |

The separate atlas language trainer and notebook, where included, train a proposal model against the new atlas contract. The old two-organ language adapter is incompatible with this schema. The shipped studio uses a tested bounded compiler; an unvalidated language-model proposal is never silently treated as anatomy truth.

## What changed through iteration

1. Selected actual external display components, avoiding overlapping annotation overlays. Preserved source vertex positions and detailed connectivity rather than fitting ellipsoids to the silhouettes.
2. Removed 820 degenerate triangles from the male heart and eight from the female pancreas; repaired one heart face orientation. Bidirectional face maps preserve the relationship to the source. No source smoothing or decimation was performed.
3. Added seven explicit, bounded controls: width, height, depth, bend, twist, taper and asymmetry. Zero is exact identity. The deformation is analytically invertible and has a positive continuous Jacobian. Seeds affect appearance and sampling; explicit geometry is determined by the controls.
4. Added per-organ authored tissue colors and material settings. Rest-coordinate pigment avoids texture swimming during edits. Noise is sampled at source vertices, so coarse meshes do not gain genuine sub-millimetre detail.
5. Corrected over-bright inspection lighting and artificial lung segment shading seams. Lung normals are calculated on a welded inspection copy and mapped back; organ geometry is unchanged.
6. Bound previews and exports to template and realized identities. GLB exports use metres, linear vertex colors and a clearcoat extension. Unsaved UI edits cannot silently replace the displayed export.
7. Strengthened release verification to cover nested attribution and license files. The final shape cohort is `cohort-v2`; earlier cohorts are development runs and must not be substituted.
8. Added atomic text edits with actual-mesh dimension solving and explicit refusal of unsupported or conflicting instructions. Added learned variation proposals, with optional real-geometry refinement to preserve current dimensions.

## Measured results

- Shape cohort: **1,536 / 1,536** accepted by the scoped numerical surface checks; 1,056 training, 240 validation and 240 audit objects.
- Geometry stress: **3,840 / 3,840** actual high-resolution meshes passed identity, control-corner and random tests. Minimum design Jacobian **0.65988995**; maximum inverse-coordinate error **8.53e-14 mm** in the recorded environment.
- Final shape checkpoint: `0464b98318df4461128e2d18b1ce1168f853214f519a3a53b051bae98118a090`.
- Validation selected ridge regression: normalized control RMSE **0.20948**, compared with **0.22611** for the neural candidate, **0.29592** for template mean and **0.32485** for nearest recipe. The neural promotion guard correctly failed.
- Frozen-model audit: normalized control RMSE **0.20529**. Actual decoded width / height / depth mean absolute errors **0.13548 / 0.14345 / 0.14283 mm**; selected-surface area error **147.70 mm²**.
- Generated model draws: **576 / 576** passed surface QA; **24 / 24** constrained refinements matched. Unconditional draws bootstrap the template's training controls; this count does not mean 576 new independent anatomies.
- Colab shape notebook: all eight code cells ran locally on the 192-object development fixture, including real training and actual-geometry evaluation. Full Colab GPU execution is not claimed.

The model learns a compact control inverse for the existing templates. Four observed measurements do not uniquely determine seven controls. Low dimension error is not evidence of exact shape reconstruction, novel topology or real-patient generalization. Audit metrics were not used for further shape-model tuning.

## Run and verify

From `viscera/`, after installing the project and training extra:

```sh
python -m viscera_core.atlas_dataset verify --data datasets/atlas/cohort-v2
python -m pipelines.train.viscera_train.atlas_shape train \
  --dataset datasets/atlas/cohort-v2 --out artifacts/atlas/my-run --steps 2000
python -m pipelines.train.viscera_train.atlas_shape evaluate \
  --dataset datasets/atlas/cohort-v2 --model artifacts/atlas/my-run/model.pt \
  --split val --templates datasets/atlas/cohort-v2/templates \
  --out artifacts/atlas/my-run/validation_geometry.json
python -m uvicorn services.api.app:app --host 127.0.0.1 --port 8000
```

Use the normal studio development command on port 5174. The atlas editor is the default route. `VISCERA_ATLAS_TEMPLATES`, `VISCERA_ATLAS_DATASET` and `VISCERA_ATLAS_MODEL` can explicitly select a compatible frozen release. For an out-of-tree runtime, `VISCERA_PROJECT_ROOT` keeps the legacy database and artifact paths tied to the original project. Freeze a chosen model before opening its audit split.

Example text requests include `liver 3% wider`, `width 200 mm`, `more twisted` and `twist 0.2`. Whether a numeric size is feasible depends on the chosen reference. Unsupported disease, removal, negation, multi-organ and conflicting requests are rejected without changing the last accepted specimen. The learned-variation button uses the trained model; the regular seed sampler uses the declared authored control distribution.

## Evidence boundaries that remain

**Appearance:** recognizable atlas geometry with authored surface materials, not calibrated photorealism. No independent normal-organ photographic set supports a realism score. More screenshots cannot create that missing evidence.

**Physical behavior:** display surface assemblies are not volumetric tissue domains. Global self-intersection checks, measured tissue constitutive laws, contact and deformation validation remain unperformed. Positive Jacobians and preserved normals do not establish physical tissue mechanics. Volume and compactness are deliberately unavailable rather than fabricated.

**Variation:** control ranges are design heuristics, not distributions measured from many humans. Twenty-four templates do not mean 24 donors. The two brain assets reuse one Allen reference, while colon sources include artist-constructed and colonoscopy-derived geometry.

**Resolution:** detailed source geometry is retained, but source quality varies. Current stomach/gallbladder references contain 1,810/2,396 triangles. Historical five-times-denser BodyParts3D candidates were identified and quarantined because their version-specific ShareAlike terms conflict with the commercial-track policy pending review. Anatomical detail cannot be honestly recovered by subdivision alone.

**Needed to advance:** independent specialist review, multiple licensed anatomies with consistent landmarks, calibrated multi-view tissue photographs, verified units for heuristic sources, and mechanical experiments tied to the intended simulation use. See the source review and per-organ PDF review notes for concrete gaps.

## Final verification and review artifacts

The combined atlas Python suite passed **45 tests**, with no skips. Strict Python type checks passed for the 11 changed core/API/training modules. Frontend verification passed 34 unit tests, 10 Atlas interaction tests, three witness-integrity tests, and the production build/type check. The legacy browser sweep passed eight checks, with one optional checkpoint test skipped.

All **1,536 specimens / 4,608 views** passed raster coverage and exact server-geometry / GPU-normal identity checks. The review set also contains 24 contact sheets and 24 real cohort specimen renders at 1600×1200. The desktop/mobile gallery supports organ filtering, specimen search and full recipe inspection. A live trained-model studio request preserved all three dimensions to within 2.55e-7 mm in the inspected liver example; this is one numerical example, not a general anatomical-accuracy claim.

The paired language release contains **9,216 examples**: 7,680 accepted edits and 1,536 atomic refusals. Every pair was replayed, every accepted mesh passed its scoped checks, and no identical accepted target geometry crossed the declared splits. The new LoRA path ran a tiny-Qwen CPU optimization/resume smoke against the real corpus; the production Qwen tokenizer verified every train/validation example without truncation. Full pretrained Qwen training remains unperformed. See `ATLAS_LANGUAGE_TRAINING.md` for the optional Google Colab workflow.

- Visual PDF: `../reports/VISCERA Atlas Dataset Review 2026-10-06.pdf` relative to the project root `viscera/`.
- Local searchable gallery: `benchmarks/results/atlas-cohort-visual-v2/index.html`.
- Training download: `artifacts/colab/viscera-atlas-colab.zip` (64,844,277 bytes; SHA-256 `a1948465024572281e0c6fe16e669484ca5437c56bada3c614b0bc28d9d84f82`).
- Trained model download: `artifacts/colab/viscera-atlas-model-v2.zip`.

During implementation, macOS evicted some cloud-managed project files and blocked reads. Active verification and the current live preview therefore use the verified frozen copies in `/tmp/viscera-atlas-runtime` and `/tmp/viscera-atlas-ui-check`; final sources, datasets and artifacts are also published to the original workspace. The running preview is a frozen working copy: restart the normal workspace development commands when resuming edits. The temporary runtime is not the only copy of the release.
