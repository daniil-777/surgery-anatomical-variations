# Disease training and inference

The disease extension has two separate learning lanes. Neither overwrites the
frozen healthy atlas geometry, language or material models.

## All-organ visual recipes

`atlas_disease_recipe_dataset.py` samples the actual editor's supported disease
profiles. The current catalog has 25 supported outer-surface design profiles
across all 12 organ families. Eleven additional reference profiles are disabled
because they require missing anatomy or topology. They have no generated recipe
labels and the trained model refuses them.

The default release contains 96 training, 24 validation and 24 audit recipes per
supported profile: 2,400 / 600 / 600 recipes. Whole recipe groups—including any
future derivative mesh, render or augmentation—stay in one split. The atlas and
reference-image lineages remain shared. There are **zero patient observations in
this recipe dataset**. The photos motivate authored profile rules; they do not
become paired volumetric labels.

The separate `geometry-v1` cohort materializes 200 recipes into actual surfaces:
six training, one validation and one audit sample for each of the 25 profiles.
Every geometry record retains its parent recipe group and split, paired controls,
surface points/normals/colors, measured dimensions, area and displacement, and
the exact bound editor recipe for full-resolution replay. It includes the
licensed template library once. Packaging rejects a geometry cohort whose parent
recipe hash differs from the model's recipe release. This is a generated shape
dataset; it adds no independent patient observations. The current VAE learns
recipe controls, while this geometry cohort supplies actual decoder outputs and
measurement targets for inspection and future geometry-conditioned models.

Nine normalized features encode morphology strength, region size, spread,
irregularity, contrast, site count and three location coordinates. Site count is
rounded back to an integer from 1 to 8; locations return to [-1,1]. These ranges
are engineering controls, not clinical severity grades or validated disease
frequency distributions.

The candidate model is a conditional VAE with a profile embedding, two 96-wide
SiLU layers, eight latent dimensions, and a sigmoid decoder. A balanced sampler
gives each supported profile equal training probability. The source prior is
authored by the sampler; the VAE learns this controllable design distribution,
not disease anatomy from photographs. A deterministic geometry renderer applies
the generated recipe to a licensed organ template.

Validation compares reconstructed recipe controls with a profile-mean baseline
and compares generated distribution means, standard deviations and unique
control vectors with empirical training-recipe bootstrap. The VAE is selected
only if all recorded gates pass; otherwise empirical bootstrap remains selected.
Reconstruction is not a realism score. Geometry validity, site placement and
rendered visibility must be checked on the actual meshes separately.

Inference uses a compact non-pickle NPZ and checked JSON manifest. Its NumPy
decoder must agree with the training PyTorch decoder within 2e-6 maximum absolute
error. A fresh seed changes both recipe draw and spatial realization. Unsupported
profiles, malformed controls, corrupted artifacts and decoder/catalog release
drift are rejected. Requested proposals are clipped to observed recipe support;
no clinical extrapolation is implied.

The frozen `recipes-run-v2` pilot selected the VAE. Validation recipe-control MAE
was 0.1034 versus 0.2144 for the profile mean. Distribution-mean MAE was 0.0484
versus 0.0495 for bootstrap. Relative standard-deviation error was worse than
bootstrap (0.2433 versus 0.1022), although below the predefined 0.60 gate; the
model is not uniformly superior to the baseline. Its training/deployment decoder
maximum difference was 1.19e-7. The separate frozen audit reports 0.0466
distribution-mean MAE and 0.2460 relative standard-deviation error. Fifty actual
editor meshes, covering two learned seeds per supported profile, passed the
finite/same-topology checks and changed geometry with the seed. These are design
distribution and geometry measurements, not clinical realism scores.

## Measured clinical source prior

`atlas_disease_dataset.py` retains exact licensed organ/lesion segmentations,
aligned meshes, common-coordinate point samples, measured geometry features and
patient groups. The CC BY release contains three pancreatic adenocarcinoma
patients, split 1 / 1 / 1. An explicit noncommercial release additionally contains
four kidney tumor cases; see `DISEASE_SOURCE_DATASET.md` for licensing and anatomy
limitations, including bilateral kidneys.

The clinical trainer learns an empirical conditional prior over measured cases,
conditioned on organ and disease code. One training patient cannot identify a
population covariance: the model records zero learned covariance and retrieves
that exact case. It never adds random variability and calls it learned clinical
variation. Measured feature conditions are supported only inside the observed
training range. Selection reports the achieved case measurements rather than
pretending an approximate retrieval exactly matches every request.

Patient-held-out validation reports per-feature absolute error and explicitly
lists disease classes with no training support. No healthy/diseased patient
correspondence is invented. Only licensed clinical segmentation cases enter this
lane; reference photographs and online-only model viewers do not.

## Reproduction

From the VISCERA project root, with `PYTHONPATH=py:.`:

```sh
python -m pipelines.train.viscera_train.atlas_disease build-recipes --out disease-releases/recipes-v2
python -m pipelines.train.viscera_train.atlas_disease train-recipes --dataset disease-releases/recipes-v2 --out artifacts/disease/recipes-run-v2 --steps 1200
python -m pipelines.train.viscera_train.atlas_disease train-source --dataset disease-releases/clinical-ccby-v3 --out artifacts/disease/clinical-ccby-run-v1
python scripts/build_disease_notebook.py
python scripts/package_disease_colab.py
```

Existing releases and model run directories are not overwritten. Use new names
for changed generator code, sampling settings or training runs. Training freezes
the selected model hash before audit. Audit evaluation requires this freeze
record; do not tune the same model against the audit afterward.

The Colab notebook uses the same trainer and serving helper. The portable bundle
contains source, tested primary dependency pins, templates and their licenses,
recipe release, CC BY source release, model artifacts and checksums. KiTS19 is
excluded from the default ZIP. A separate NC bundle requires an explicit
packaging flag and still requires an explicit training/inference opt-in.

The standalone ZIP includes the focused recipe-training and dataset integrity
tests. Install `notebooks/requirements-disease-test.txt`, then run
`PYTHONPATH=py:. python -m pytest tests/python -q` inside the extracted directory.
The full Studio route, browser and legacy integration suite runs in the original
project; those fixtures are deliberately not included in the minimal training
bundle. `scripts/qa_disease_model.py` can check every supported learned profile on
the actual editor mesh path using the geometry release's template library.

No model in this release estimates measured tissue stiffness, contact response,
cutting, bleeding, invasiveness, histology, prevalence or calibrated appearance.
These remain separate evidence and validation requirements.
