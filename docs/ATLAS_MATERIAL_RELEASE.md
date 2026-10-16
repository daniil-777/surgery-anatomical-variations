# Material generation release

The Studio now has independent **Shape** and **Surface** editors. Surface presets, six bounded material controls and a separate seed change pigmentation, sheen, mottling and fine shading detail while preserving the selected mesh. Text edits can combine both, for example `Make the liver slightly wider and wetter`.

- [Nine-page visual review with 56 actual renders](../../reports/VISCERA%20Material%20Variety%20Review%202026-10-07.pdf)
- [All 12 organs and four presets](../../reports/material-review-2026-10-07/all-12-organs-4-presets.png)
- [Architecture and evidence limits](ATLAS_MATERIAL_ARCHITECTURE.md)
- [Continuous field contract and GPU agreement](ATLAS_MATERIAL_FIELDS.md)
- [PBR export and source-frame fallbacks](ATLAS_MATERIAL_EXPORT.md)
- [Dataset and training instructions](ATLAS_MATERIAL_TRAINING.md)
- [Material training notebook](../notebooks/VISCERA_material_dataset_and_training.ipynb)
- [New material Colab bundle](../artifacts/colab/viscera-material-colab.zip)
- [Trained model card](../artifacts/atlas/material-run-v1/MODEL_CARD.md)

## What changed

The previous vertex-color appearance remains available through recipes without a v2 material. New authored surfaces use a continuous rest-space field evaluated per fragment, so fine appearance no longer depends on mesh vertex density. Export bakes that field into embedded base-color, roughness and tangent-normal maps, including the wet clearcoat normal. Controls do not displace the source surface.

The geometry decoder and the material model are separate. `Sample surface` uses the checked material prior for the chosen organ and preset, with an independent spatial seed. The [editor variation fix](ATLAS_EDITOR_VARIATIONS.md) makes shape and surface edits preview automatically, composing the latest controls in one recipe. `Apply surface` can flush a pending edit immediately. Surface-only edits preserve geometry, and export always uses the last successfully displayed recipe. Source/clay rendering and the frozen shape/language releases remain unchanged.

## Material learning results

| Item | Result |
|---|---|
| Authored recipes | 768 across 12 organs and 4 presets |
| Train / validation / audit | 480 / 144 / 144 whole recipes |
| Surface field samples | 1,024 per recipe, 8 values per sample |
| Pilot comparison | 2,000 neural training steps plus mean, nearest and ridge baselines |
| Selected model | Ridge inverse regression with organ/preset conditioning |
| Validation field-summary NRMSE | 0.091106; mean 0.512819; nearest 0.280263 |
| Sealed audit field-summary NRMSE | 0.083401 |
| Audit linear RGB / roughness MAE | 0.006656 / 0.005728 |
| Generated proposal checks | 768 passed field bounds and unchanged-coordinate checks |

The neural candidate reached 0.066983 average validation error but regressed beyond the allowed per-organ limit on gallbladder, kidney and urinary bladder, so it was not selected. Audit scores compare generated fields with the procedural teacher. They do not measure similarity to real tissue photographs.

## Verification

The CPU fields and actual WebGL2 shader agree within 1.4e-6 for linear color/roughness and 5.6e-6 for height/gradient on the parity fixture. A 3,072-case control-corner stress test stayed finite and within declared field bounds. The visual review contains 48 preset views and eight detail/seed comparisons, with exact recipes, geometry hashes and image hashes in its manifest.

Actual exported GLB and procedural views of a deformed gallbladder were compared in three matching cameras: interior RGB MAE was 0.43–0.48 on a 0–255 scale, with no visible inverted micro-normal or chart seam in those views. This is a scoped export consistency test, not a universal renderer or anatomical realism score. Final regression logs, normal-source audits and export coverage are under `benchmarks/results/material-v2/`; frontend evidence is under `benchmarks/results/atlas-material-ui-2026-10-07/`.

All 24 source templates passed actual 512² PBR export. The male heart, female pancreas and male bladder also passed 2048² exports with explicit UV handling where needed. At 2048², the male heart reserved 1.17% of atlas width for 683 tiny source faces whose automatic UVs had collapsed; 20 singular-frame texel evaluations retained the source normal without undefined micro-detail. The export guide records these policies rather than treating them as recovered anatomy.

The seven material notebook code cells ran locally on CPU against the completed frozen run, without changing the model checksum or reopening sealed audit labels. A Google-hosted Colab GPU execution has not been run.

## Run locally

From the `viscera` directory, install with `uv sync --extra train`. Start the backend with the pinned atlas templates:

```sh
VISCERA_ATLAS_TEMPLATES=datasets/atlas/cohort-v2/templates uv run --extra train uvicorn services.api.app:app --host 127.0.0.1 --port 8000
```

In another terminal, run `pnpm install --frozen-lockfile` and `pnpm studio`. For training, open the new material notebook or follow the material training guide. The earlier shape/text Colab archive is preserved separately.

## Remaining realism work

The material fields and training distribution are authored design heuristics. The source meshes retain their detail limitations, and several require explicit shading-normal or UV-frame fallbacks recorded in their export provenance. Nothing here establishes calibrated tissue optics, anatomical microstructure, human variation frequencies, pathology, or mechanical properties. The next appearance-learning stage needs licensed calibrated tissue imagery and specimen-level validation, as described in the architecture document.
