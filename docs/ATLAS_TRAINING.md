# Atlas-preserving control training

The current atlas model predicts seven bounded deformation controls for one fixed template. It preserves the template's original high-resolution anatomy. It does not generate novel topology, combine organ identities, learn material textures, establish tissue mechanics, or estimate a population distribution.

This independent workflow leaves `pipelines/train/viscera_train/shape.py` and all frozen legacy checkpoints unchanged. It follows the data-contract, baseline-comparison and reproducibility checks in the `ecc:mle-workflow` skill.

## Decision and evidence contract

- Goal: generate distinct variations of licensed reference organs while preserving detailed source geometry and respecting requested measurable dimensions.
- Labels: measurements computed from each actual decoded atlas recipe; no pseudo-volume is assigned to open display assemblies. Missing measurements are masked, never zero-filled targets.
- Baselines: mean template controls, nearest training recipe within the same template, and per-template ridge inverse regression.
- Candidate: a compact MLP with template embedding, masked conditions, bounded mean and diagonal proposal variance. Organs are sampled uniformly, then templates uniformly within each organ.
- Selection: macro-template validation control RMSE divided by the control range of two. The MLP must improve the best baseline by at least 2%, with no organ RMSE increasing over 10%. The neural proposals must also retain at least 0.02 mean standard deviation in the secondary controls for each supported validation template. Otherwise the simpler baseline remains selected.
- Sampling: unconditional bootstrap from the exact template's training recipes; conditional ridge proposals use vector leave-one-out residuals and bound rejection. Neural conditional proposals use learned variance and bound rejection. These are uncalibrated design-space distributions.
- Geometry verification: real atlas decoding and per-condition measured errors are separate from inverse-control reconstruction. Training never uses a learned measurement proxy.
- Audit: `train` reads only `train.npz` and `val.npz`. Audit is an explicit action after the chosen model is frozen. Never tune against a consumed audit split.
- Scope: all splits share a few atlas source lineages. Group IDs isolate recipe derivatives, but this is **within-generator validation**, not patient-independent anatomical evidence.

## Dataset contract

Every split is a non-pickle NPZ with:

| Array | Shape / meaning |
|---|---|
| `controls` | N×7 finite normalized values in [-1,1] |
| `control_names` | `scale_x, scale_y, scale_z, bend, twist, taper, asymmetry` |
| `conditions` | N×D measured numeric conditions in declared units |
| `condition_mask` | N×D boolean; only masked values may be NaN |
| `condition_names` | unique feature names; normal release uses X/Y/Z extent in mm, area in mm², volume in ml, compactness |
| `template_ids` | N immutable source-template identities |
| `organ_ids` / `organ_names` | N integer labels indexing a global organ vocabulary |
| `sample_ids` / `group_ids` | N unique sample IDs and parent recipe group IDs |

`release.json` contains SHA-256 hashes for split files. Surface points, normals and render metadata may also be in the release; the compact control checkpoint stores only necessary training controls and features. Preprocessing statistics use observed training values per template. Unsupported templates, unavailable requested measurements, and conditional sampling outside observed training support fail explicitly. Missing rows cannot silently remove a requested constraint.

## Run locally

Run from `viscera/` with the project's Python environment and `PYTHONPATH=py`:

```sh
python -m pipelines.train.viscera_train.atlas_shape train \
  --dataset datasets/atlas/cohort-v2 --out artifacts/atlas/run-v1 --steps 2000
python -m pipelines.train.viscera_train.atlas_shape evaluate \
  --dataset datasets/atlas/cohort-v2 --model artifacts/atlas/run-v1/model.pt \
  --split val --templates datasets/atlas/cohort-v2/templates \
  --out artifacts/atlas/run-v1/validation_geometry.json
```

Freeze the selected `model.pt` checksum, then evaluate `--split audit` once. Use a new output directory for changed configuration. `--resume` requires identical source code, complete release hash, train/validation bytes, configuration, Python/PyTorch/NumPy versions and runtime device identity. CPU deterministic continuation is tested exactly. Cross-device bitwise parity is not promised, consistent with [PyTorch's reproducibility documentation](https://docs.pytorch.org/docs/2.14/notes/randomness.html).

Checkpoint loading uses `weights_only=True`, integrity sidecars and schema validation. This avoids unrestricted pickle loading as documented by [PyTorch](https://docs.pytorch.org/docs/2.14/generated/torch.load.html). Hashes detect accidental corruption; they do not authenticate an untrusted source.

```sh
python -m pipelines.train.viscera_train.atlas_shape sample \
  --model artifacts/atlas/run-v1/model.pt --template hra-liver-male \
  --count 12 --seed 914 --out artifacts/atlas/run-v1/samples.json
```

Use `atlas_shape.make_geometry_decoder(dataset / "templates")` for cached high-resolution measurement evaluation. `sample_controls` returns an N×7 array, and `viscera_core.atlas.generate(template, controls, seed=...)` realizes a full-resolution sample. Review its QA before export.

## Colab

`notebooks/VISCERA_atlas_dataset_and_training.ipynb` is generated by `scripts/build_atlas_notebook.py`. `scripts/package_atlas_colab.py` packages the separate atlas source, hashed dependency lock, immutable dataset and attribution files into `artifacts/colab/viscera-atlas-colab.zip`. It validates every ZIP member against its source hash and leaves existing legacy Colab bundles unchanged.

The notebook executes integrity/coverage checks, baseline comparison, training, actual-geometry validation, model freeze, one-time audit, sampling and output download. Source-only bundles can build a release from included `templates-v2`. Local smoke tests and model metrics must be recorded separately from unexecuted Colab GPU claims.

## Remaining evidence

More iterations cannot turn the limited source lineages into measured population coverage. Expert anatomy review, independent licensed references, consistent multi-view material photographs, material calibration, and independently held-out real anatomies are still required before claiming clinical realism or medically plausible variation frequencies. Detailed retained source surfaces improve geometric starting quality; synthetic perturbations remain hypotheses requiring review.

`refine_controls(model, template_id, initial_controls, conditions, decoder)` optionally solves bounded numeric constraints against actual decoded geometry. It returns `matched` or `unmet_constraints`, measured residuals in original units, numerical convergence and decoder-call count. No neural surrogate is used. An infeasible constraint is reported without changing the organ identity or exceeding control bounds. This numerical success is not anatomical validation.
