> 2026-10-25: the default browser appearance now uses fitted, histogram-preserving exemplars (Generative Model 13). Early neural fixtures remain explicit experimental imports. See [the repair and validation notes](tissue-material-repair-2026-10-25.md). Historical model evaluations below are retained.

# Layered tissue lab

The [21 October variation and pretrained PBR update](tissue-generative-implementation-2026-10-21.md) documents the new authored colour/roughness controls, optional StableMaterials pilot and local material-bundle import. Its final integration evidence is tracked separately from earlier revisions.

Open Studio with `?mode=tissues`, or use the **Tissue lab** navigation in the organ/texture studio. The Vite production build also emits `tissues.html`.

This is an isolated material research extension. It delivers executable material generation, a camera/light test environment and an experimental observed-RGB training/import path. It does **not** deliver a qualified surgical simulator, a patient-specific digital twin or measured optical parameters. See the [revision 3 assessment](tissue-v3-assessment-2026-10-19.md) for the new architecture, Colab workflow, evidence and unfinished acceptance checks. Revision 2 visual evidence does not validate revision 3 rendering.

## Delivered material library

Nineteen authored tissue families cover liver, kidney, heart, lung, spleen, stomach serosa, small and large bowel serosa, pancreas, gallbladder, bladder, uterus, muscle, fascia, peritoneum, mesentery, gastric mucosa, intestinal mucosa and colonic mucosa. Two additional transition studies blend liver/peritoneum and pancreas/mesentery. These are appearance studies rather than exhaustive organ coverage or anatomical attachment reconstructions.

The current exporter writes 4096×4096 substrate and composite color, composite and substrate OpenGL tangent normals, composite and dry-substrate roughness, packed independent layer relief, 16-bit height and 16-bit thickness-proxy maps, plus a transition mask and four separate RGBA layers. Consult each manifest for the channels actually present; older manifests remain readable. The normal green convention is tested against a physical height ramp. PNG color maps use sRGB; scalar maps and coverage are linear. Height, packed relief and the thickness proxy have explicit millimetre decoding. Thickness is not measured wall thickness and is not evidence of subsurface scattering.

The library composites substrate → vessels → adipose coverage → fascia in linear light. When `substrate_normal` and `layer_relief` are present, browser coverage controls also reconstruct the corresponding normal slopes from separate physical layer heights. When `substrate_roughness` is present, fascia and wet-film controls recompute roughness from the dry substrate; wetness is applied once. Legacy manifests retain baked relief or roughness for the missing editable channels. Regeneration remains necessary to export a new standalone material recipe.

The wet-film layer represents coat coverage; highlights are produced by lighting rather than painted into base color. Its normal response is smoother than the substrate response. These are authored rendering parameters, not fitted optical measurements. Opacity describes area coverage, not radiative transmission through tissue. The browser uses a dielectric wet coat; it does not implement a calibrated BSSRDF, volumetric vessel walls, or transparent anatomical layers.

The 80 mm periodic tile has a 19.53 µm output sampling interval at 4096². This is not measured resolution: the vascular raster is bounded at 2048² and other structures are procedural fields. Repeating texture seeds and finite profile sets do not establish a representative human population.

## Generate or use from Python

From `viscera/`, with the existing environment installed:

```sh
./.venv/bin/python scripts/build_tissue_library.py --jobs 2
./.venv/bin/python scripts/generate_tissue_materials.py --output /path/to/new-assets --organs liver gastric_mucosa --resolution 4096 --seed 18446744073709551615
```

```python
from viscera_core.tissue_materials import TissueRecipe, export_material

recipe = TissueRecipe(
    organ="small_bowel", transition_organ="mesentery", seed=42,
    vessel_opacity=0.7, fascia_opacity=0.12, adipose_opacity=0.25,
)
manifest = export_material(recipe, "output/bowel_mesentery", resolution=4096)
```

The core supports full unsigned 64-bit integer seeds without silently truncating them. Browser recipe downloads retain the original manifest text so JavaScript number parsing cannot round those seed tokens. Browser lumen geometry uses a separately labeled uint32 seed with avalanche mixing. Exports stage PNGs, hash every file, and publish the manifest last under an exclusive writer lock. They record source and numerical-library versions. Imports do not download anything, initialize a neural model or touch fat-generation code.

`build_tissue_library.py` generates 512² previews and native 4096² assets under `apps/studio/public/tissue-materials/`. Reuse requires matching recipe, revision, dimensions and content hashes. `--preview-only` generates an interactive preview catalog; native downloads require the full build.

Before packaging a full library, create a fresh verified snapshot:

```sh
./.venv/bin/python scripts/stage_tissue_library.py apps/studio/public/tissue-materials /private/tmp/viscera-material-release > artifacts/tissue-release-snapshot.json
```

The target must not already exist. The snapshot includes only the catalog, referenced manifests and their declared PNGs. Missing files, checksum/size mismatches, unsafe paths or symlinks fail publication. Duplicate names and abandoned staging files are inventoried and excluded without modifying the source. Atomic no-replace publication currently requires macOS or Linux with `renameat2`. Use the resulting snapshot for the production asset folder and external archive; an entire mutable public directory may contain unrelated or incomplete files.

## Camera, light and video

Choose a **mucosa** profile, then **Endoscope · lumen phantom**. Serosal/exterior materials are deliberately unavailable as internal luminal surfaces. The camera follows a curved, closed path at an authored 18 mm/s. An 80 mm material tile produces a 1600 mm loop, repeating after about 88.89 seconds. Other supported tile sizes select a nearby loop length that preserves an integral axial texture repeat. This closed loop is an intentional navigation phantom, not the anatomical topology of a colon, bowel or stomach.

Colonic studies use uneven partial semilunar folds in three staggered rows. Intestinal studies use finer folds, and gastric studies use a separate longitudinal-rugae profile on the same navigation-phantom topology. A transported frame keeps orientation continuous through bends and around the loop. The camera moves slightly away from the centerline and surveys adjacent wall surfaces. Geometry and UVs remain fixed in rest coordinates; there is no moving-tissue deformation demonstration. Axial texture scale is in millimetres, while the circumferential chart uses a nominal circumference and stretches over variable-radius folds.

The camera carries a shadow-casting spotlight and two finite rectangular emitters. Their positions and directions follow the camera frame. Three's WebGL rectangular emitters do not cast shadows, so their contribution has approximate visibility through occluding folds. Ambient fill, authored roughness/IOR values and screen-space appearance remain approximations rather than measured endoscope optics. There is no contact, collision-response, cutting, bleeding or tissue-mechanics solver.

**Record 4K · 5s** records an actual 3840×2160 canvas stream to H.264 MP4 when supported, with VP9 WebM as fallback, and downloads a separate timing record. This preference follows a measured local codec comparison. The requested capture cadence is 30 fps; hardware/browser encoding can deliver less. **Save 4K frame** renders a native 3840×2160 PNG. The controls are disabled during recording so the material cannot be replaced midway. Offline fixed-time frame capture is separately available to the test harness and is not reported as real-time performance.

For a complete anatomical walkthrough, the next stage is a semantic graph of connected cavities and surgical access spaces, region/transition masks attached to real organ meshes, collision-aware camera navigation, deformation-preserving surface bindings and validated optics. A single tube or a collection of exterior organ meshes does not supply those relationships. See the [research and training plan](tissue-material-research-2026-10-19.md).

The [renderer architecture](tissue-rendering-architecture.md) documents module ownership, the normal/roughness contracts, resource lifetimes and validation boundaries.

## Datasets and model training

The [source catalog](../research/tissue-materials/datasets.json) and [dataset report](../research/tissue-materials/dataset-research.md) separate visual observations, geometry, hyperspectral measurements and access/usage restrictions. Original archives are stored externally, not embedded as untracked training data in the generator. Their receipt JSON records the exact source, byte count, checksums, retrieval time and license evidence. A local checksum establishes local integrity; it is not a publisher signature.

Revision 3 adds a [masked conditional RGB VAE](../py/viscera_core/tissue_learning/README.md), a [Colab notebook](../notebooks/VISCERA_tissue_appearance_A100.ipynb), and a local browser importer. The [dataset preparation](../research/tissue-v3/README.md) retains source masks, explicit species/region mappings and source-group splits. The small real-image pilot has no valid held-out cohort and cannot establish generalization. The reviewed datasets do not provide matched 4K intrinsic albedo/normal/roughness/SSS targets across all organs. RGB contains source lighting even after glare exclusion; learned RGB is not calibrated albedo and can be incorrectly relit. Larger data and lower training loss alone do not resolve this ambiguity.

The completed 2,000-update A100 baseline and 3,000-update [native-crop detail candidate](tissue-detail-training-2026-10-19.md) passed export and Studio integration checks but failed visual review. A third [spatial convolutional candidate](tissue-conv-training-2026-10-19.md) completed 6,000 updates with a conditional variational model and masked adversarial training. It removes the previous coordinate/Fourier lattice, but actual generated samples remain blurred and unqualified. Its [A100 notebook](../notebooks/VISCERA_tissue_conv_A100.ipynb), checkpoints, source identity and v3 decoder are separate. A subsequent [300-update objective refinement](tissue-refine-training-2026-10-19.md) was trained, downloaded and verified, then stopped after failed detail and visual gates: new crosshatching appears despite better colour/frequency statistics. All three schemas remain supported; successful training and numerical parity do not establish realism.

Import a `.tissue-model.json` under **Learned appearance**. Its data-only tensor inventory, checksum, seed convention and reference inference are verified before a worker bakes RGB in fixed surface coordinates. The model stays in local browser storage and can be removed. The UI enables only explicitly declared region mappings. Imported models remain experimental; the bundled fixture is clearly marked as a software test. Browser bakes are bounded at 128–512 square pixels, separate from the authored 4096² maps and native 3840×2160 capture. Colab can sample the decoder into an actual 4096² PNG; that does not imply native 4K learned detail. The display recipe exports the exact model digest, condition, uint64 seed and bake resolution.

The decoder also enforces a model-dependent operation budget: the larger v2 candidate supports 256² browser bakes, while 512² exceeds that budget and is rejected. The 4096² Colab bake uses bounded GPU chunks and is a separate output-sampling operation.

The v3 spatial decoder caches a native 128² tile per seed and condition, then periodically bilinear-samples it at larger resolutions. Both Studio and its Colab export label this interpolation explicitly. Changing output resolution does not change the learned native tile or add detail.

The **Atlas organ · exterior** view projects maps in object millimetres onto supported existing source meshes. It supports 12 exterior families, a bounded external orbit and deterministic orbit recording. The three lumen profiles offer independent full yaw and pitch inspection on their existing safe path. Neither view creates connected anatomy, arbitrary collision-aware camera translation, tissue deformation or patient-specific interiors.

### Learned tiles (21 October 2026)

A fourth path trains a LoRA on pinned Stable Diffusion 1.5 over native-scale, illumination-flattened surgical crops
and samples seamless tiles with circular padding; see [the learned-tiles report](tissue-lora-training-2026-10-21.md)
for the data policy, the rights gate (DSAD-derived studies stay research-only), run commands, the executed pilot and
its held-out statistics. Learned studies enter the catalog as preview-only entries (`learned-<run>-<family>-s<seed>`)
through `scripts/tissue_lora.py library`; `scripts/tissue_learned_review.mjs` captures stills and native 4K frames for
them in the real lab. They are learned appearance, not measured albedo or clinical validation.

## Required acceptance after changes

```sh
./.venv/bin/python -m pytest tests/python/test_tissue_materials.py tests/python/test_acquire_tissue_datasets.py -q
./.venv/bin/python -m pytest tests/python/test_acquire_tissue_parallel.py tests/python/test_tissue_library_audit.py tests/python/test_stage_tissue_library.py -q
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
node node_modules/vitest/vitest.mjs run apps/studio/src/tissues
node node_modules/@playwright/test/cli.js test --config playwright.tissues.config.ts
node scripts/tissue_visual_review.mjs
```

For production acceptance, serve the completed build and set `TISSUE_PRODUCTION_URL=http://127.0.0.1:8822/tissues.html` on the Playwright invocation. This selects the production origin for the entire suite and disables its development server; it also enables the standalone-entry check. Capture a new visual-review directory with `TISSUE_REVIEW_OUTPUT=artifacts/tissue-quality-<revision>` so failed and accepted iterations remain distinct.

The final video must be inspected after the final code change. Keep evidence of failed iterations. Review temporal stability, highlights, seams, folds and real-reference differences; measure actual live UHD rendering and encoded cadence independently of offline capture. The harness records source hashes, native map resolution, frame hashes, video dimensions/frame counts, full-loop replay, boundary continuity, exposure diagnostics and browser errors. Raw neighboring-frame differences include intended camera motion and are not a validated flicker metric. Successful software checks do not constitute a realism pass or clinical validation.

The new module is independent of `apps/studio/src/fat/`. Regression checks exercise both modules; before/after hashes document concurrent changes without attributing them to this task. Navigation and build integration are additive. Large native maps can be regenerated and should be distributed as versioned artifacts rather than placed indiscriminately into every static deployment.
