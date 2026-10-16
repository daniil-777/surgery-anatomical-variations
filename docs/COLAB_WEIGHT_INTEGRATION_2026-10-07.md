# Actual Colab weight integration — 7 October 2026

The downloaded `viscera-final-weights.zip` is validated, installed in the persistent model store, and active in the local API and Atlas Studio. The actual trained Qwen adapter was also loaded and tested. No retraining is required for these integration fixes.

- Studio: <http://localhost:5174>
- API model status: <http://localhost:8000/api/atlas/models>
- Source ZIP SHA-256: `46b14640625e293b637fdd113de28e820c741d6d4829ec11b7f62f3cd912378a`
- Archive: 6,740,713 bytes; 99 members; full training profile.
- Persistent store: `viscera/data/imported-models/`. The active pointer survives an API restart; the previous bundle is retained.
- Evidence: [integration artifacts](../artifacts/colab-integration-2026-10-07/verification.json).

## What is active

| Component | Selected model in the downloaded artifact | Editor behavior |
|---|---|---|
| Shape | Ridge; trained candidate ran 1,200 steps | Learned bounded geometry-control sampling across 24 templates |
| Material | Ridge; trained candidate ran 2,000 steps | Learned procedural surface-control sampling across 12 organ priors |
| Disease | Conditional VAE; 1,600 steps | Learned synthetic disease recipes across 25 supported profiles |
| Language | Qwen2.5-0.5B-Instruct LoRA; 200 steps on Colab T4 | Optional shape-edit proposals, requiring exact compiler agreement |
| Clinical | Empirical observed-case retrieval; one training patient | Read-only pancreas case measurements; does not generate an editor mesh |
| Physics | No trained model in this artifact | No learned constitutive or surgical-contact mechanics |

The importer verified all six dataset dependencies and model checksums. The downloaded ZIP, frozen datasets, training source releases and existing Drive release were not changed.

## Integration fixes

1. Rendered meshes carry derived template and realization identifiers. The trained text model saw these identifiers as null during training but copied stale values from editor input. Inference now clears only those two derived fields before proposing an edit. It preserves shape controls, template, seed and appearance; the exact semantic compiler guard remains in place. The resulting mesh recomputes its identifiers normally.
2. Same-reference shape edits preserve existing material and disease recipes. Appearance requests unsupported by this shape adapter are rejected before inference, leaving the displayed mesh unchanged.
3. Studio discovers an already-loaded adapter in a fresh browser through a read-only status request. Refreshing or reopening the model panel preserves the user's checkbox choice. Page reload starts with the standard compiler selected. Only explicitly enabling the adapter selects it for that session. Status checks do not trigger model downloads.

The UI also distinguishes importing weights, restoring defaults, retrieving observed cases and loading the text adapter while each operation is pending.

## Validation performed

| Check | Result |
|---|---|
| Actual ZIP import | Passed manifest, source, vocabulary, template, dataset and weight verification; atomic activation |
| Shape, material and disease API sweep | 61/61 groups, 244 real inference requests; all 24 templates, 12 material priors and 25 disease profiles |
| Keep-overall-dimensions sweep | 24/24 templates, 48 real inference requests; maximum relative extent error approximately 5.34e-8 |
| Reproducibility and variation | Same-seed replay, different-seed variation, finite geometry, valid triangle indices, bounded controls and preserved recipes passed |
| Actual-weight browser editing/export | Passed learned shape/surface/disease sampling, subsequent slider and standard text edits, and model provenance checks |
| Actual Qwen browser inference | Passed `taper 0.3` on a rendered liver with material and HCC recipe; material and disease preserved; unsupported request left geometry unchanged |
| GLB export | Exact displayed recipe and geometry retained; one mesh, one PBR material and three embedded 512×512 textures; 1,635,260 bytes |
| Clinical route | Actual imported source-model hash matched; observed case retrieved without generating a mesh |
| Language regression tests | 13 passed; Ruff passed |
| Model-panel browser regressions | 8 passed; TypeScript typecheck passed |
| Persistence | Actual imported bundle remained active after API restart; cached language model re-enabled successfully |

The two final real-browser scenarios produced no browser errors. Screenshots were inspected. The 292 API requests above count the final two canonical sweeps, excluding exploratory repeats and browser traffic.

Evidence is stored in `artifacts/colab-integration-2026-10-07/`: API JSON receipts, language evaluation, browser screenshots, an exported GLB, final service status and published-source hashes. `browser-core/` and `browser-text/` contain the final successful runs. Earlier exploratory failures remain in the temporary working directory and are not the acceptance evidence.

## Use the integrated weights

Refresh Studio. In **Trained models**, the active bundle checksum should begin `46b14640`. Use **Learned variation** in Shape, the learned sampler in Surface, and **Learned disease variation** in Disease. Ordinary sliders still edit the explicit recipe. Importing weights does not automatically replace the currently displayed organ.

The text adapter is loaded in the current API session. Select **Use trained text adapter** to try it; `taper 0.3` was verified with the real weights. After an API restart, open **Trained models** and choose **Enable text adapter** again. The pinned public base model is cached locally. Uncheck the adapter to use the standard compiler.

See [the full Studio weight guide](COLAB_WEIGHTS_IN_STUDIO.md) for import, restore, API routes and dependency installation.

## Quality limits observed

The archive's sampled language audit covered 24 rows: JSON/schema validity and status accuracy were 24/24, while exact semantic agreement was 20/24. This is a small audit, not an evaluation of every held-out row. Actual CPU tests still found rejected ordinary prompts such as `twist 0.2`, relative-width changes and reset requests. Rejected proposals are not applied, and there is no silent fallback. The adapter remains optional; this integration does not establish unrestricted text-to-3D generation.

Shape, surface and disease models generate bounded synthetic recipes. These tests establish correct integration, reproducibility and numerical consistency. They do not establish clinical anatomical realism, population coverage or calibrated tissue physics. The clinical lane contains one observed training patient, not a population model.

## Repeat the actual-weight checks

Run from `viscera/` with the API on port 8000, Studio on port 5174 and Python training dependencies installed:

```sh
PYTHONPATH=py python scripts/qa_colab_inference.py --url http://127.0.0.1:8000 --weights ../viscera-final-weights.zip --out /tmp/viscera-all-organs.json
PYTHONPATH=py python scripts/qa_colab_inference.py --url http://127.0.0.1:8000 --weights ../viscera-final-weights.zip --conditioned-only --out /tmp/viscera-conditioned.json
VISCERA_COLAB_EXPECTED_RECEIPT=/tmp/viscera-all-organs.json VISCERA_TEST_LANGUAGE_ENABLED=1 pnpm exec playwright test --config playwright.colab-live.config.ts
```

Enable the actual text adapter in Studio before the last command. Omit `VISCERA_TEST_LANGUAGE_ENABLED=1` to skip that optional real-language scenario. Tests compare served model hashes with the independently inspected downloaded ZIP.
