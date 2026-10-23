# Masked RGB tissue appearance research

This is an executable new conditional VAE, not an adaptation of TRELLIS or a
pretrained physical-material model. The existing atlas material trainer learns
authored recipe codes; this module instead learns masked observed RGB. There is
no installed parent `viscera.training` dispatcher to extend: those lifecycle
documents are proposals. The implementation provides explicit `TissueDataset`,
`ExperimentConfig`, `TissueAppearanceVAE` and `Trainer` boundaries here.

The four convolution/SiLU encoder blocks receive neutral-filled masked RGB plus
the mask. An actual learned posterior predicts mean and log variance. The decoder
receives latent, explicit condition one-hot and periodic Fourier coordinates,
then three dense SiLU layers and sigmoid RGB. Default latent32/width96 at128² is
a small research pilot. A masked reconstruction mean-squared loss, valid-neighbor
gradient loss and beta-weighted KL objective train all parameters. There is no
normal, roughness, height or subsurface target. RGB still contains illumination,
exposure, white balance, optics and biological variation. It is not albedo.

The method follows the reparameterized VAE objective described by
[Kingma and Welling](https://arxiv.org/abs/1312.6114). The architecture is newly
authored and receives its own source/config identity; it does not claim their
paper validates surgical textures. The portable decoder uses data-only float32
weights and has an independent NumPy implementation and known vectors. Browser
code bakes once into rest UVs; no neural inference is required each video frame.
Sampling this decoder at4096² does not create measured4K training detail.

The actual 66-image CPU experiments failed visual realism: the first generated
nearly uniform fields; condition balancing and 2000 updates improved masked
training reconstruction but produced axis-aligned bands. The global32 latent,
small axis-periodic coordinate MLP and RGB MSE objective are too constrained for
the intended anatomical detail and encourage averaging. This baseline must not
be promoted as a photoreal model or used to justify a huge A100 run expecting
that result. A higher-capacity spatial representation with separately evaluated
perceptual objectives, or calibrated inverse-rendering supervision for physical
materials, is a new research branch with its own held-out validation needs.

## Data and isolation

JSONL rows declare sample/image/mask hashes, eligibility, condition, explicit
region/species mapping, source, split and group provenance. Images may be local
files or exact offset/length slices of uncompressed TAR shards. Payloads stream
on demand; metadata is held in memory. Mask values255 mean valid tissue. Masks
exclude tools, annotations, non-organ pixels or glare only to the extent their
source annotations/policy support that claim. A documented conservative extra
glare/black filter is applied. Missing tool masks are not invented.

Groups, identical image hashes and declared ancestors cannot cross splits. All
crops inherit source grouping. Patient IDs that are absent remain absent. A
sequence/surgery/source-collection split is not described as patient-disjoint.
Train and validation groups are required by default. Explicit `training_only`
mode exercises actual gradients on sources without a valid holdout; its output
has no generalization metric. The fixture is an original synthetic software
test, never a patient cohort. DSAD's conflicting licence statements require the
explicit noncommercial research profile, not unrestricted model promotion.

Validation reports masked posterior reconstruction against a per-condition RGB
mean fitted only on a deterministically capped training sample, per-condition
errors, KL, posterior-mean variance and prior RGB diversity. A lower posterior
error does not establish realism of samples drawn from the prior. Test bytes
are unopened during training; the separate evaluate-test command requires a
frozen checkpoint. Final qualification remains `engineering_unqualified` even
when loss or baseline comparisons improve.

## Recovery and portability

Checkpoints contain model and AdamW tensors, optimizer counters, Torch RNGs,
NumPy sampler RNG, shuffled order/cursor/epoch, baseline and validation state.
They use safetensors and structured JSON, without pickle or serialized code.
Constant learning rate has no scheduler state. bfloat16 AMP has no loss scaler;
CPU float32 is the tested exact-resume profile. Resume rejects changed data,
config, source or runtime identity. Stop limits count absolute committed updates.

The encoder's parameter-free4×4 pooling uses nonoverlapping block means for
encoded grids4/8/16/32 and cell repetition for grids1/2. On these power-of-two
grids this has the same forward and backward mathematics as adaptive average
pooling. It avoids the CUDA backward operation that strict deterministic mode
rejects in [PyTorch2.8](https://docs.pytorch.org/docs/2.8/generated/torch.use_deterministic_algorithms.html).
CPU forward/gradient equivalence is tested for native patch sizes16 through512.
The Colab preflight enables strict deterministic algorithms and executes the
actual model, mask and loss forward/backward at64² and128² under bfloat16 AMP.
Those GPU checks execute on Colab; they have not been performed on this Mac.
Earlier CPU pilots retain their original source identity and are not described
as reruns of the corrected implementation.

Drive is checkpoint transport, not a minibatch filesystem. Local snapshots are
copied and read-back verified before the restart pointer is published. At least
the previous immutable checkpoint remains; partial transfer directories are
ignored. Mounted-Drive readback is not a guarantee against VM loss: the fresh
kernel verifies hashes again. [Google documents variable GPU availability,
runtime limits and Drive I/O limits](https://research.google.com/colaboratory/faq.html).
An A100 request does not guarantee an A100. The notebook checks actual hardware
and records measured peak allocated/reserved memory and wall throughput. It
does not silently change batch size after OOM.

[PyTorch documents platform/version reproducibility limits](https://docs.pytorch.org/docs/2.14/notes/randomness.html)
and [bfloat16 autocast behavior](https://docs.pytorch.org/docs/2.14/amp.html).
Exact CPU resume tests do not prove cross-device or cross-version equivalence.
The Colab profile explicitly selects the official PyTorch 2.8.0 CUDA12.6 wheel
for Python3.11/3.12 and fixed application dependencies. First use resolves its
transitive wheels, validates publisher hosts and SHA256 metadata, and persists an
immutable URL/hash lock on Drive; installs and reconnects use that exact lock.
This is a runtime-resolved environment, not a preverified downloaded archive.
The driver and actual A100 are checked, with no silent version/device fallback.
The older project CUDA13 lock is retained only as historical project metadata;
the notebook does not install it. Official supported wheel variants are listed
by [PyTorch](https://pytorch.org/get-started/previous-versions/); available Colab
runtime versions are documented by [Google](https://research.google.com/colaboratory/runtime-version-faq.html).
GPU execution has not been claimed by local CPU tests.

## Commands

From the project root with `PYTHONPATH=py`:

```sh
python scripts/train_tissue_appearance.py fixture /tmp/tissue-fixture
python scripts/train_tissue_appearance.py train --manifest DATA/records.jsonl --data-root DATA --config CONFIG.json --output RUN --mirror DRIVE_RUN
python scripts/train_tissue_appearance.py train --manifest DATA/records.jsonl --data-root DATA --config CONFIG.json --output NEW_ATTEMPT --resume DRIVE_RUN/checkpoints/step-000000100
python scripts/train_tissue_appearance.py export RUN/checkpoints/step-000002000 learned.tissue-model.json
python scripts/train_tissue_appearance.py bake learned.tissue-model.json appearance-4096.png --condition-index 0 --seed 42 --resolution 4096 --device cuda
python scripts/train_tissue_appearance.py diagnose --checkpoint CHECKPOINT --manifest DATA/records.jsonl --data-root DATA --model learned.tissue-model.json --output DIAGNOSTICS
python scripts/train_tissue_appearance.py evaluate-test --manifest DATA/records.jsonl --data-root DATA --config CONFIG.json --run RUN --freeze
python scripts/package_tissue_learning_colab.py
```

The package command emits an allowlisted, hashed source ZIP and a notebook pinned
to its exact SHA256. No Git checkout, credentials, private source path or giant
dataset is embedded. The notebook mounts Drive and reads the pinned ZIP from
`MyDrive/VISCERA Tissue Training 2026-10-19`. Its default bounded 2000-update
DSAD research mode acquires and prepares source data using the
bundled audited adapters. Automatic diagnostics show real patches, masks,
posterior reconstructions, prior samples and training-mean baselines, plus loss
and diversity measurements. The optional 66-image training-only smoke cannot
establish photorealism, all-organ coverage or held-out generalization. Export and
preview paths bind the checkpoint/model identity to prevent stale artifact reuse.
The deterministic readiness scan verifies train/validation image integrity and
actual crop coverage before training. Only insufficient-coverage rows can be
excluded, with explicit original row IDs and hashes in the saved report. Retained
rows and all test metadata remain byte-identical; test payloads stay unopened.
The derived manifest hash is part of the run identity and that same manifest is
used for training, diagnostics and later frozen test evaluation. Partial outputs
are preserved separately; completed outputs must pass their hash receipts.
Select A100 and Colab runtime version 2026.07 (Python 3.12) for this explicit
CUDA 12.6 profile. Notebook subprocesses drain both output pipes and forward text
through the kernel; inherited OS stderr was invisible in the actual Colab launch.
Per-command output tails and exit receipts are bounded and saved on Drive. JSON
stdout stays separate from progress/error output, and an interrupted cell stops
its child process group.
The final single-file `.tissue-model.json` contains only data, exact architecture,
tensor inventory, hash, seed/reference vectors and honest training provenance.
Importing it cannot install packages or execute supplied code.
