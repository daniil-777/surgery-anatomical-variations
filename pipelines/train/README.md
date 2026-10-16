# Executable learning baselines

Run from the `viscera` directory after `uv sync --extra train`.

```bash
.venv/bin/python -m pipelines.train.viscera_train.shape train \
  --data datasets/original/pilot-v1 --out artifacts/models/shape-local-run \
  --steps 600 --device cpu
.venv/bin/python -m pipelines.train.viscera_train.shape evaluate \
  --data datasets/original/pilot-v1 --model artifacts/models/shape-local-run/model.pt \
  --split test --out artifacts/models/shape-local-run/test_evaluation.json
.venv/bin/python -m pipelines.train.viscera_train.shape sample \
  --model artifacts/models/shape-local-run/model.pt --conditions '{}' \
  --count 12 --out artifacts/models/shape-local-run/variants.json \
  --scene-dir artifacts/models/shape-local-run/scenes
```

The shape model is a small conditional rectified flow over eight construction
parameters, with a procedural mesh decoder. It does not learn unrestricted mesh
topology, tissue properties or appearance. Five optional measured conditions are
`liver_volume_ml`, `liver_width_mm`, `liver_height_mm`,
`gallbladder_enclosed_ml`, and `gallbladder_length_mm`. An omitted condition is
masked. Conditions are soft requests; evaluate realized measurements. Out-of-bounds
parameters and rejected meshes are recorded; they are never silently clipped.
The current model uses an invertible logit representation of the authoritative
parameter intervals and a sigmoid decoder. Exact boundary training values are
explicitly unsupported and cause an error; no hidden epsilon is used. Geometry
gates remain mandatory because bounded controls alone do not guarantee a valid
mesh. The former unbounded architecture is retained as a development baseline.

Train-only standardization/PCA and disjoint derivative groups prevent the obvious
split leaks. One authored generator still supports only a within-generator claim.
The train command never opens `test.npz`. Evaluation compares conditional flow,
conditional Gaussian/PCA and nearest-training-design retrieval with every decoded
failure counted. Parameter-space MMD and coverage are not anatomical surface
metrics. The PCA baseline may outperform the flow on exact dimensional control.

Use `--resume` with the original configuration, data, source and device. Atomic
checkpoints preserve model, optimizer, RNG and minibatch position; all loads use
`weights_only=True` plus checksum verification. Regression tests establish exact
CPU continuation for this setup; cross-device equivalence is not established.
Resolved device type and PyTorch/NumPy versions are now checkpoint identity fields,
so `device=auto` cannot silently resume a CPU run on CUDA. Evaluation rejects
reordered feature names and a different train/validation release. Split identifiers
must align with every row; infinite conditions are rejected instead of masked.

The October 2026 code review strengthened these checks without modifying any
published dataset or model weights. The existing `shape-pilot-v1` model records
the trainer source used originally; its source hash is intentionally historical.
Inference remains compatible with its unchanged geometry decoder. Its old
checkpoint cannot resume under the revised trainer source. Train in a new output
directory, or restore the exact original source and environment to continue an old
run. No revised-source model has replaced the published research candidate.

The exact historical trainer is preserved in
`artifacts/colab/viscera-colab-source-before-code-review.zip`; the matching source
and dataset bundle is
`artifacts/colab/viscera-colab-with-dataset-before-code-review.zip`. Each has a
`.sha256.json` sidecar naming the retained archive. Both contained `shape.py` files
were verified against `shape-pilot-v1/model.pt`'s recorded trainer SHA-256:
`57295739812183dcbc4a1dba10f16bfb2306d44afe3cedcd313362ae76abcdc0`.
These archives preserve provenance and are separate from the current source ZIPs.

`pilot-v0` is retained as a broad construction-control stress release. The initial
adult design release is `pilot-v1`; its volume limits are authored design bounds,
not estimated population statistics. Neither release has expert anatomy approval.

## Optional language experiment

`notebooks/VISCERA_optional_language_LoRA.ipynb` installs separately pinned optional
dependencies and downloads an immutable [Qwen 0.5B instruction model](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/tree/c89bee90d9f811437d9735454613c35b4a3c4dc8)
under Apache-2.0. Its [PEFT LoRA](https://huggingface.co/docs/peft/package_reference/lora)
trainer uses assistant-only loss and targets only bounded `{status, patches}` JSON.
Training data are original operation templates with disjoint states and wording
families. They cover dimensional edits and unsupported/ambiguous requests; they
are not a human-authored language benchmark. The current templates teach length
controls, so schema support does not imply training coverage of every control.

The notebook compares the deterministic compiler, frozen language model and adapter
on the same sealed split. Invalid JSON, wrong status, incorrect edits and false
ready responses remain failures. The bounded validator does not establish that
an otherwise valid edit matches an arbitrary user's intent. The language model is
not deployed by this code. No pretrained weights were downloaded or pretrained-model fine-tuning run locally. A tiny random Qwen2/LoRA integration test verifies the software path.

Language dataset creation verifies an existing release and refuses changed recipes
or corruption. A non-resume run cannot overwrite an existing experiment. Language
checkpoints preserve accumulated training time, optimizer, minibatch order and RNG;
the tiny local integration test verifies bitwise identical interrupted/resumed CPU
adapter weights. `--stop-after` creates an explicitly interrupted checkpoint for
recovery testing and does not publish an adapter. Completed adapters include hashes
for all adapter and tokenizer files. Evaluation verifies those hashes and the
original train/validation release before loading weights. JSON numbers such as
`240` and `240.0` count as the same validated edit.

Both Colab notebooks verify the uploaded source manifest before extracting into a
fresh directory and stop their child training process when a cell is interrupted.
Existing dataset releases are checked against the requested recipe on every run.
`notebooks/smoke_execute.py --run-id <new-name>` runs every shape-notebook code cell
locally without installing packages or authenticating to Colab. It preserves prior
smoke artifacts by using a fresh timestamped run directory by default.

```bash
.venv/bin/python -m pipelines.train.viscera_train.language prepare --data artifacts/language/pilot-v0
# The following two commands require the optional notebook dependencies/model download.
.venv/bin/python -m pipelines.train.viscera_train.language train \
  --data artifacts/language/pilot-v0 --out artifacts/models/language-pilot-v0 --steps 200
.venv/bin/python -m pipelines.train.viscera_train.language evaluate \
  --data artifacts/language/pilot-v0 --out artifacts/models/language-pilot-v0
```

The shape Colab notebook also executes numerical polynomial Neo-Hookean Eq.13 patch verification and
quasistatic block compression. These are software/constitutive checks, not organ
contact, measured tissue validation or physiological material calibration.

The mechanics energy is the rest-stable quadratic-J variant in Smith et al. (2018), Eq.13; it does not implement the final log(Ic+1)-regularized Eq.14 formulation or claim its collapse-handling behavior. See the project mechanics documentation for the coefficient mapping and limitations.
