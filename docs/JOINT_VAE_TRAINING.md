# Joint VAE training release — 7 October 2026

This release adds an actual shared-latent conditional VAE that varies organ shape, authored tissue colour/material and disease features together. It exports one `viscera-joint-weights.zip` compatible with the updated Studio. Existing Colab weights remain installed independently.

## Run the notebook

**[Open the released notebook in Google Colab](https://colab.research.google.com/drive/1qKAkgKJ_ahpmxJWhTKXfFVicVYSayYmi)** · **[Open the complete Drive release](https://drive.google.com/drive/folders/120uOSQzAPySMm2qAwlRB6ywoc6f8bVTe)**. All eight delivery files were uploaded, and the notebook was opened successfully in Colab. Access remains restricted to the user's existing Drive permissions.

Open `VISCERA_joint_VAE_run_all.ipynb` in Colab and choose **Runtime → Run all**. Approve Google's Drive mount prompt. Keep the three matching baseline, disease and runtime ZIPs in **VISCERA Joint VAE Training 2026-10-07**, beside the notebook. No notebook edits or API keys are needed. GPU metadata requests an accelerator; CPU fallback works. Google's runtime availability remains outside this release's control.

The notebook verifies each archive, creates an isolated Python environment, trains, selects a validation checkpoint, evaluates it, renders every condition with three seeds, checks the export and downloads one weight ZIP. Outputs and logs also remain in the Drive folder's `runs/` directory. A verified completed model is reused on rerun; an interrupted training stage restarts. The kernel does not need a package-install restart.

## Separate training datasets

| Archive | Examples | Conditions | Split counts (train / validation / audit) |
| --- | ---: | ---: | --- |
| Baseline joint geometry/colour | 2,304 | 24 reference templates | 1,632 / 336 / 336 |
| Disease joint geometry/colour | 4,800 | 50 template/profile pairs; 25 disease profiles | 3,400 / 700 / 700 |
| Shared runtime/reference library | 24 complete source templates, renderer and training code | 12 organ groups | Not additional training observations |

There are 74 modeled conditions and 7,104 rendered examples, with 128 corresponding surface anchors per example. Each row records positions, linear RGB, roughness, full replay recipe, template identity, field phase, sample identity and split family. Derivatives of one synthetic parent remain in the same split across both datasets. Templates are shared between splits; this measures within-generator generalization, not unseen-patient accuracy.

The anatomy renderer retains the complete source mesh; 128 anchors are the supervision budget, not export resolution. Sparse anchors can miss local detail. Small lesions and detailed textures remain constrained by the existing procedural renderer. The default material/disease field phase is fixed per condition so identical controls have identical observation targets. Baseline and disease records are not controlled clinical counterfactual pairs.

Per-template licenses and attributions are retained. The exact dataset-builder source used for these frozen releases is included in each dataset ZIP, under `provenance/`. Later builder validation fixes do not alter these frozen targets.

## What changed in the model

The old release selected independent ridge models for shape and material. This release always exports the jointly trained VAE, with organ/template/disease conditioning, a learned conditional Gaussian prior and separate output heads sharing the latent representation. Training adds paired observation reconstruction, a frozen differentiable renderer surrogate, KL warmup/free bits, condition-balanced sampling, and prior distribution losses. The actual full renderer provides a separate post-training integration check.

See [the complete model architecture](JOINT_MODEL_ARCHITECTURE.md) and [Studio usage](JOINT_VAE_IN_STUDIO.md). Related research demonstrates joint shape/texture learning for registered meshes, but does not validate our medical model: [joint texture and shape mesh decoders](https://arxiv.org/abs/1904.03525), [CoMA](https://arxiv.org/abs/1807.10267).

## Local full-run evidence

All four code cells of the final packaged notebook passed in a separate local Python environment, including fresh training, 222 full-renderer checks and weight export. Those freshly produced weights were then imported into an isolated Studio API and generated a valid complete liver HCC scene with the exact exported model checksum. This verifies the packaged workflow locally; a Google-hosted GPU execution was not performed. Receipts are in `artifacts/joint-vae/notebook-run-all-verification.json` and `artifacts/joint-vae/integration/notebook-import.json`.

The exact notebook defaults were exercised locally: 1,400 surrogate steps and 4,000 VAE steps, with all 74 conditions and 5,032 training examples. A validation-guided prior-loss adjustment from 0.6 to 3.0 improved validation control MAE from 0.1020 to 0.0955 for shape, 0.0981 to 0.0918 for material, and 0.1461 to 0.1357 for disease, in normalized control units. All 24 latent dimensions remained active. The final checkpoint was step 3,750.

The final model passed **222 full-mesh renderer cases**. Source connectivity, finite geometry, bounded colours, reproducible recipes, and measurable shape/colour differences between seeds passed across all conditions. Minimum inter-seed normalized mesh RMS was 0.002900 and minimum sRGB RMS was 0.015411. These are engineering variation checks, not perceptual or clinical realism scores.

The simple factorized Gaussian remains approximately tied or slightly better on held-out marginal-spread/covariance statistics: relative standard-deviation error 12.705% versus 12.736% for the VAE. The report keeps this comparison visible. The release demonstrates a functioning joint VAE and better validation reconstruction within its design space; it does not prove superiority on every metric. Validation and audit figures are development evidence from this dataset, not an independent clinical validation study.

CPU reference model SHA-256: `bf021ff58be437947c2532b212e13231051b0832662d63a22e08818f3219ebb2`.

Verified CPU weight ZIP SHA-256: `495de8eb7be169ca67981a28304c9b4fab50908a17a9b37d5a5dfca4fb959aa9`.

A Colab GPU run can produce different floating-point weights. Its own manifests, metrics and renderer checks travel with its export; the importer validates that specific artifact.

## Open ground-truth supplement

The separate DRENDS supplement contains original synchronized porcine colon RGB/depth observations, calibration, source attribution and a six-frame review set. It is not fed into the human disease VAE: species, labels, visibility and registration do not justify that substitution. Photographic RGB includes illumination, tools and background and is not calibrated tissue albedo. Read [the source research and ingestion findings](JOINT_VAE_GROUND_TRUTH.md).

The training datasets contain **zero independent patient colour observations**, **zero measured albedo/roughness targets**, and **zero learned physics labels**. Geometry and colour targets are authored paired renderer observations, with their provenance retained. More independent, aligned, disease-labelled specimens are needed to establish realistic human disease distributions.

## Use downloaded weights

Open Studio → **Trained models** → select `viscera-joint-weights.zip` → **Validate & activate**. Select an organ and optional supported disease. Use **Joint VAE variation** to vary shape, material and disease together; change the seed or choose a new joint variation. Temperature adjusts sampling spread. Ordinary sliders and textured GLB export continue to work.

The joint model has its own activation pointer. It does not replace the existing shape, material, disease, clinical or optional language models. Exact dataset, renderer, decoder and template identities are checked before joint activation. Full-training provenance and a passing exact renderer audit are required; smoke artifacts are rejected.
