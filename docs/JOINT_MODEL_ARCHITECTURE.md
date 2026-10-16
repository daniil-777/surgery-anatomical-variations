# Joint shape, appearance and disease VAE

The new joint conditional VAE learns one distribution over an organ's shape,
authored tissue appearance and disease design parameters. A single latent sample
updates all three together. It always exports a VAE decoder; validation never
replaces it with a ridge regressor, bootstrap sampler or condition mean.

This is a **bounded recipe VAE with paired rendered supervision**. Its decoder
proposes controls for the existing versioned high resolution anatomical surface
renderer. It does not synthesize unrestricted mesh topology, learn measured tissue
optics, estimate disease prevalence or predict tissue mechanics.

## Representation

| Modality | Latent decoder outputs | Rendered supervision |
| --- | --- | --- |
| Shape | 7 bounded invertible shape controls | Corresponding deformed surface coordinates |
| Appearance | 6 continuous tissue material controls | Linear RGB and roughness on the same surface anchors |
| Disease | 9 normalized morphology and colour controls | The resulting diseased surface positions and colours |

Each example has 128 fixed anchor vertices on its source template. The anchor
selection includes anatomical components and spreads coverage across the surface.
The dataset stores full editor recipes plus observations at these anchors; it
uses the original complete source mesh at inference and export. The anchor count
is a training supervision budget, **not** the output mesh resolution.

The condition is an exact `(template_id, disease_profile_id)` pair. Baseline is
an explicit condition; its disease outputs are masked and no disease object is
created. Unsupported organ/disease pairs are rejected rather than substituted.
The template's organ and material preset remain fixed by the condition.

Normalized output order is the seven shape controls, six material controls, and
nine disease controls. Material frequency uses the existing logarithmic scale.
Disease count is restored to an integer and every output remains within the
condition's observed training support. Requested temperature controls prior latent
spread in `[0.1, 1.5]`; it does not change diagnosis or clinical severity.

## Architecture and training

The encoder reads controls, paired rendered observations and a condition
embedding. It produces a diagonal Gaussian posterior. A learned conditional
Gaussian prior and a shared latent decoder feed separate shape, material and
disease heads. A fourth training-only head reconstructs surface observations.

Before VAE training, a differentiable surrogate learns the mapping from controls
and condition to surface observations. It is selected on validation data and then
frozen. The VAE's decoded controls are passed through this frozen surrogate, so
rendered geometry and colour reconstruction errors provide gradients to the
actual editor-control heads. Surrogate errors are reported separately; they are
not represented as independent exact-renderer errors.

The objective combines balanced modality reconstruction, shared observation
reconstruction, surrogate consistency, KL divergence with warmup and free bits,
and condition-local prior mean, standard deviation and covariance matching.
Condition-balanced batches prevent common templates from dominating learning.
Validation checkpoint selection considers reconstruction and prior diversity.
Audit examples are evaluated after selection, not used to choose checkpoints.

Spatial material and disease field phases are deterministic per condition.
The dataset records `renderer_seed`; the same controls therefore map to the same
corresponding target observations. A user sampling seed changes the latent vector
and hence the learned shape, material and disease parameters. The editor can
still change individual material or disease spatial seeds afterward; those manual
edits are outside the fixed-phase training distribution.

## Evidence and safeguards

Baseline and disease releases have separate checksums and share synthetic parent
family assignments across train, validation and audit. All variations of a parent
stay in the same split. These are synthetic family splits, not independent patient
cohorts. Repeated use of an atlas template is not counted as new patient evidence.

Training reports include modality control error, surrogate geometry/linear-colour
error, active posterior latents, prior diversity and covariance error. Prior
statistics are compared with a condition mean and a factorized control Gaussian
on the same held-out examples. A VAE that is worse than these baselines remains
reported as worse; it is never silently replaced.

A separate post-training audit invokes the exact Studio renderer for three seeds
of every supported condition. It checks complete-mesh finite coordinates, source
connectivity, current renderer numerical QA, bounded colours, deterministic
recipe replay and mesh/colour variation. This is independent of the neural
surrogate. Its anti-collapse thresholds are engineering checks, not human realism
scores or evidence of medical validity.

The exported NumPy decoder is tested against the PyTorch decoder. The Studio
importer binds weights to their metadata, both dataset releases, the exact model
decoder, all required renderer sources and each source template's geometry and
metadata files. Smoke-training artifacts cannot be installed as final weights.

## Improving beyond authored supervision

The present colour and disease fields are authored examples. More synthetic
examples improve coverage of this design space but cannot turn it into measured
clinical ground truth. Real improvement in anatomical or optical accuracy needs
licensed, aligned evidence: independent disease-labelled 3D cases; calibrated
surface photographs or multi-view reconstructions; and patient/source-disjoint
evaluation. Monochrome CT segmentation masks provide geometry evidence but do not
provide living-tissue RGB or roughness labels. Unpaired surgical photographs
should not be presented as aligned 3D texture supervision.

A future unconstrained mesh or implicit-surface decoder requires a separate,
registered geometry representation and stricter topology/physical evaluation.
This release deliberately uses the existing source topology and editable recipe
contract so the new weights work in the current Studio and textured GLB export.

## Local full-training verification, 2026-10-07

The full CPU rehearsal used the same 4000 VAE and 1400 surrogate steps as the
Colab defaults. It trained on 5032 examples, with 1036 validation and 1036 audit
examples across 74 template/profile conditions. Checkpoint 3750 was selected.
A controlled validation comparison changed the prior moment loss weight from
0.6 to 3.0; 3.0 is now the default. All 24 latent dimensions remain active.

| Validation metric | Initial weight 0.6 | Final weight 3.0 |
| --- | ---: | ---: |
| Shape control MAE | 0.1020 | 0.0955 |
| Appearance control MAE | 0.0981 | 0.0918 |
| Disease control MAE | 0.1461 | 0.1357 |
| Relative prior standard deviation error | 13.88% | 12.67% |
| Checkpoint selection score | 0.4491 | 0.4388 |

The control errors use the normalized `[-1,1]` design coordinates; they are not
millimetre errors or clinical disease-stage errors. The final audit prior's
standard deviation error is 12.74%, versus 12.71% for the factorized Gaussian.
Its covariance error is 0.06144, versus 0.06119 for that Gaussian. These are
broadly comparable marginal-distribution results, not evidence that the VAE is
superior on every metric. The improvement is a jointly trained, editable model
with coupled modalities, rendered supervision and measured reconstruction.
The development comparison selected its configuration on validation scores;
each training run also reports its own audit. There is no independent external
clinical test cohort in this experiment.

The final exported model passed 222 exact full-mesh renderer checks: three
seeds for each of 74 conditions. Every condition preserved source connectivity,
produced finite valid colours and geometry, passed the current renderer's
numerical QA, replayed its recipe and changed both geometry and colours across
seeds. The smallest observed normalized mesh RMS difference was 0.00290; the
smallest sRGB RMS difference was 0.01541. These are quantitative differences,
not human realism scores. Six model regression tests cover training/export,
decoder parity, dataset leakage, unsupported conditions, integrity and replay.

Detailed receipts are in `artifacts/joint-vae/training-comparison.json` and
`artifacts/joint-vae/full-cpu-run/exact-renderer-audit.json`.
