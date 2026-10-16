# Surgical reference colour transfer

Implemented **8 October 2026** in Organ studio and Whole scene. Upload a surgical photograph, select visible tissue, review the proposed mask, assign its organ identity and transfer its observed colour to that organ's material. The image is processed in memory by the configured local API; this implementation does not send images to external inference services or save uploads.

For several organs or photographs at once, use the separate **Whole scene → Whole-body colour** workflow. It includes six human surgical photographs, reviewed semantic masks, pooled per-organ colour and reversible batch assignment. [Whole-body usage, sources and verification](WHOLE_BODY_COLOUR.md).

## Use it

In **Organ studio → Surface → Colour from a reference**, choose one of the three included reference thumbnails or upload a PNG, JPEG or WebP. In **Whole scene**, first select a supported organ; the same panel appears under the scene controls. Left/right kidneys and lungs remain separate targets, although they share the corresponding organ family.

The included photographs are three DRENDS views of **one porcine ex-vivo colon specimen**, with editable starter regions and tissue/background points. Selecting an example loads it locally; choose **Analyse reference region** to generate its mask. An example never automatically applies colour. Its review checkbox explicitly names colon as the source and the selected organ as the material target, so trying colon colour on another organ does not relabel the source anatomy. Changing images clears the previous analysis and review. Dataset attribution and image provenance ship with the [included assets](../apps/studio/public/reference-material/README.md).

1. Draw a box around visible tissue. Add **+ Tissue** and **− Background** points as needed. The numeric percentage fields provide a keyboard alternative. With the local segmenter, the box centre is the default tissue seed and the box border is background. An opaque binary PNG mask can replace segmentation; white selects tissue and black excludes it.
2. Choose **Analyse reference region**. When installed, SAM 2.1 is selected automatically; local edge/colour refinement remains available. Errors are reported without silently switching methods.
3. Inspect the overlay: **green contributes colour**, **amber is selected but excluded from the estimate**. Check especially instruments, adjacent fat, blood, glare and shadow. The system does not independently establish organ identity.
4. Choose strength and **Colour only** (preserves authored perceptual lightness) or **Colour and brightness** (also matches the photo's observed lightness). Confirm the named target organ and apply. **Clear reference colour** restores the current authored recipe. Presets/reset intentionally replace the surface recipe.

Atlas exports use the same resolved colour as the CPU sampler and browser shader, including textured GLB and the existing Unity material baker. Whole-scene overrides affect the selected structure and its authored undertone, and appear in viewport diagnostic metadata; they are session state, not a new whole-scene project import/export format. Changing a whole-scene reference does not restart physics or alter its deformed vertices.

## Practical method chosen

**SAM 2.1 spatial prompts + reviewed organ assignment + robust Oklab colour estimate** is the learned path tested here. SAM supplies a candidate mask, not an organ label. SAM 3/3.1 offers semantic prompts; the public Surgical SAM 3.1 checkpoint is available, but its reported anatomy mask performance varies sharply by organ. We keep explicit review and use expert-labelled source masks for the subsequent whole-body library. [Segmentation research, corrected checkpoint availability and primary sources](research/surgical-segmentation-2026-10-08.md).

The estimator excludes a two-pixel mask boundary, clipped/bright neutral pixels and deep shadows, trims extreme lightness, and rejects robust chroma outliers. A central Oklab estimate sets the material base colour; three observed swatches aid review. The default retains authored lightness, with hue-preserving gamut compression. Surface grain, fine relief, sheen, ligament appearance, vessel layout, disease controls and mechanics remain independently authored. A photographed pattern is not projected onto an unrelated organ mesh. [Colour/material research and primary sources](research/surgical-appearance-2026-10-08.md), [Oklab derivation](https://bottosson.github.io/posts/oklab/).

This combines established components with a conservative integration policy. It is not a claim of a new validated segmentation algorithm. Our local alternative adds connected appearance seeds before random-walker segmentation: without these seeds, a single positive click was overwhelmed by the background boundary in the first synthetic test. The failed result is preserved.

For future calibrated material reconstruction, **EndoPBR (WACV 2026)** is the most directly relevant researched approach. It uses scene geometry and camera poses to estimate surgical materials and camera-attached lighting. These inputs are not available from an arbitrary uploaded photo and an unrelated atlas. Generic inverse-material generators such as MaterialAnything/MatMart can invent unobserved appearance and do not establish tissue optics. [EndoPBR](https://openaccess.thecvf.com/content/WACV2026/html/Han_EndoPBR_Photorealistic_Synthetic_Data_for_Surgical_3D_Vision_via_Physically-based_WACV_2026_paper.html).

## Install and run

The deterministic path uses existing project dependencies. Optional learned segmentation uses an official locally installed `facebook/sam2.1-hiera-tiny` checkpoint. The installer fixes the upstream revision and checks each downloaded file's size and SHA256; request handling never downloads weights or executes repository code.

```sh
# From viscera/
uv venv --python 3.12 .venv-reference
uv pip install --python .venv-reference/bin/python \
  -e '.[reference-segmentation,disease-data,language]' \
  -c requirements-reference-segmentation.txt
.venv-reference/bin/python scripts/install_reference_sam2.py
.venv-reference/bin/python scripts/install_reference_sam2.py --check-only
OMP_NUM_THREADS=4 .venv-reference/bin/python -m uvicorn \
  services.api.app:app --host 127.0.0.1 --port 8000
```

Start the existing Studio in another terminal. The API discovers the installed model under `artifacts/reference-material/models/sam2.1-hiera-tiny`. `VISCERA_SAM2_MODEL` overrides the path; `VISCERA_SAM2_DEVICE` supports `cpu`, `mps` or `cuda`. CPU was exercised. MPS/CUDA inference was not tested in this delivery. See the [model and verification record](../artifacts/reference-material/sam2-verification/README.md) for the exact revision, checksums, licence and tested environment.

The instructions use an isolated environment constrained to the actually tested Torch 2.8.0 / Torchvision 0.23.0 / Transformers 4.57.1 combination. The ordinary project lock retains the previous training Torch **2.14.1**, with its matching optional Torchvision 0.29.1. SAM2 inference under that newer shared environment is **NOT_RUN**. The existing `.venv` and training weights were not replaced. This session's live verification used `/private/tmp/viscera-sam2-verify` because cloud-placeholder dependency reads in the original environment timed out.

`POST /api/atlas/reference-material/analyze` accepts raw base64 image data, a known `organ`, normalized box/points, optional binary PNG mask and `local`/`sam2` backend. It returns the mask and accepted-pixel overlay, colour/palette, exclusion diagnostics, warnings, a user-assigned semantic label and a serializable `reference-color-1` recipe. `GET /api/atlas/reference-material/status` reports local configuration. Image/mask byte limits are 12 MiB each; images are at most 24 megapixels and analysis is at most 1024 pixels on the longest side. The API's existing total request limit also applies. One analysis runs per process to bound memory. No source filename, EXIF or image bytes are stored in a material recipe; SHA256 links the recipe to the original bytes and analysis mask without claiming authenticated provenance.

## Verification and visual assessment

The [colour benchmark](../benchmarks/results/reference-material-2026-10-08/benchmark.json) freezes 48 synthetic cases over four colour families, four contamination levels and three seeds. On the 36 contaminated cases, mean Oklab chroma error against the clean **observed** colour is **0.000323** for the filtered estimate, **0.002072** for an unfiltered masked Oklab median, and **0.037598** for a masked sRGB mean. These compare estimators under the same synthetic illumination, not recovery of intrinsic tissue colour. Full Reinhard/OT and generative material models were researched, not run as benchmark competitors.

The local synthetic region test improved from IoU **0.01246** to **0.99832** after connected seed expansion, with the image, prompts and threshold unchanged. The independent SAM 2.1 ellipse test reached **0.9941**. These are development fixtures, not surgical accuracy estimates.

Actual SAM 2.1 inference on a licensed DRENDS photograph took **0.779 seconds** with the model already loaded, on CPU with four threads; first model load plus synthetic inference took 9.24 seconds. This is one measured run, not an end-to-end latency guarantee. The DRENDS source is **porcine ex-vivo colon**, not living human tissue. Its source authors, CC BY 4.0 attribution and modifications are preserved in the [appearance review](../benchmarks/results/reference-material-2026-10-08/appearance-review.md) and [original supplement](../artifacts/ground-truth/README.md).

Visual review checks mask leakage, glare/shadow contamination, colour cast, surface-detail retention and before/after organ shape. The real SAM proposal excludes the main instrument but includes fragmented marginal regions and holes. The local proposal selects a compact useful tissue patch, not the full visible colon. The frame has a strong acquisition colour cast and no white/reflectance calibration. Those defects are reasons to review/correct the mask and compare brightness modes; neither is a basis for reporting clinical organ-recognition accuracy. No surgeon reviewed this implementation. No specialized surgical-assessment skill was installed in the available skill locations, so this is an explicit engineering visual assessment.

Automated integration checks cover deterministic replay, image/EXIF/ICC/mask validation, rejected unreliable regions, source hashes, strict recipe validation, sRGB/linear/Oklab transforms, lightness and gamut behaviour, unchanged non-colour fields/ligaments, actual template geometry, a 512-pixel textured GLB, stale UI results, review gating and mobile controls. The browser material shader is unchanged; the same resolved base-colour uniform and CPU sampler feed rendering and export. [Python integration test record](../benchmarks/results/reference-material-2026-10-08/integration-tests.xml), [browser evidence](../artifacts/reference-material-browser-2026-10-08/).

Final checks: **90 Python tests, 173 frontend unit tests, nine browser scenarios, TypeScript checking, targeted Ruff and production build pass**. Python validation includes existing material/bake/v2 API regression tests. The real-image whole-scene browser check uses SAM2, preserves all other organ material signatures and every geometry signature, retains identical camera/paused-physics state, and clears back to the exact previous material. The source's retained-pixel fraction was **71.6%**, representative sRGB approximately **[0.610, 0.505, 0.433]**. See [before](../artifacts/reference-material-browser-2026-10-08/whole-scene-reference-mate-8a882-nd-preserves-paused-physics/colon-before.png), [after](../artifacts/reference-material-browser-2026-10-08/whole-scene-reference-mate-8a882-nd-preserves-paused-physics/colon-after.png) and [review record](../benchmarks/results/reference-material-2026-10-08/visual-assessment.md).

## Remaining limits

Automatic semantic organ identification, calibrated albedo/roughness/subsurface scattering, transfer of anatomical vessel patterns, reconstruction of hidden tissue, living-human generalization and surgical/clinical validation are **not established**. Blood or adjacent tissue with a similar colour may survive filtering. Very pale or dark tissue can be rejected as glare/shadow; a cleaner exposure or corrected mask may be necessary. One photo can be reused for several organs by selecting and confirming each separately; there is no autonomous multi-organ detection/batch assignment.
