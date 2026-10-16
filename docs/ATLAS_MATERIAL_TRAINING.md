# Independent material prior

The material model predicts six bounded appearance controls for one organ and authored preset. A continuous CPU/WebGL field resolves those controls at template-rest coordinates. Its outputs are linear and sRGB color, spatial roughness, shading height and analytic height gradients. Appearance never changes vertex positions, face connectivity, geometry controls, anatomical measurements or mechanical properties.

## Data contract

`datasets/atlas/material-v1` contains 768 complete appearance recipes: 12 organs × four organ-aware presets × 16 samples. The split is 480 train / 144 validation / 144 audit. Every sampled surface point, map patch and render derivative inherits its entire appearance recipe's group and split. Geometry source lineages are shared; these are within-generator recipe holdouts, not independent patients or tissue photographs.

Each recipe includes six normalized controls, an independent uint32 field seed, exact organ/preset/template identities, source geometry hash, eight measured field conditions and 1,024 complete field samples at fixed surface coordinates. Material scale uses logarithmic normalization over 2–40 mm. Other control ranges come directly from the strict material recipe schema. Dataset hashes bind the parent atlas release, frozen geometry generators, material source, templates through parent provenance, and all stored artifacts. The source geometry licensing and attribution are retained.

The six controls are tint, pigment contrast, mottle scale, wetness, fine detail and structure strength. The eight measured conditions are three mean linear-color channels, linear luminance standard deviation, roughness mean and standard deviation, centered height RMS in mm and spatial-gradient RMS. The dataset is a bounded Gaussian design around each authored style, truncated by rejection at control bounds. This sampling policy does not estimate real tissue variation or prevalence.

## Learning and selection

The baseline comparison includes organ/style mean controls, nearest measured-condition training recipe, and pooled ridge inverse regression with group intercepts. Ridge/nearest/mean residuals use leave-one-out training predictions. A compact conditional network predicts bounded control means and proposal variances; balanced organ/style batches avoid domination by frequent classes. All standardization uses training rows only.

Validation decodes every candidate's predicted controls through the real CPU material field at the original surface coordinates and seed. Reports contain macro organ/style and per-organ errors, native-unit measured-condition errors, linear RGB MAE, roughness MAE, height RMSE and gradient RMSE. Neural selection requires at least 2% improvement in macro measured-field summary error and no organ error increase over 10% relative to the strongest baseline. These scores measure procedural teacher reconstruction, not medical or photographic realism.

Unconditional sampling is an empirical organ/style bootstrap with a fresh spatial field seed. Conditional sampling uses the selected mean predictor and bounded residual/variance proposals. Requested measured conditions are approximate proposals and require actual decoding, measurement and residual reporting. Targets outside observed per-group training support fail explicitly. A successful parameter or field bound is not proof of calibrated optics or biological plausibility.

## Reproducibility and use

The standalone notebook is `notebooks/VISCERA_material_dataset_and_training.ipynb`. The CPU pilot needs no large pretrained network. Run from `viscera/` with `PYTHONPATH=py:.`:

```sh
python -m viscera_core.atlas_material_dataset \
  --parent datasets/atlas/cohort-v2 --out datasets/atlas/material-v1
python -m pipelines.train.viscera_train.atlas_material train \
  --data datasets/atlas/material-v1 --out artifacts/atlas/material-run-v1 --steps 2000
```

Use a fresh output directory for a new experiment, or `--resume` for identical source, data, configuration and runtime. CPU optimizer/RNG continuation is tested exactly. Inference uses a non-pickle NPZ and JSON manifest with checksums, strict array shapes, finite/bounded values and source/schema binding. Training checkpoints use restricted `weights_only=True` loading and checksum sidecars.

The selected model is frozen before the separate audit command. The training path never reads audit labels. Generated-sample QA measures actual surface fields and control diversity, preserves every sampled recipe, and asserts unchanged geometry coordinates.

Python API:

```python
model = atlas_material.load_model(Path("artifacts/atlas/material-run-v1/model.npz"))
proposal = atlas_material.sample_recipe(model, "liver", "rich", seed=1234)
# Optional conditions={"roughness_mean": target_in_observed_training_support}
summary, fields = atlas_material_dataset.evaluate_controls(
    "liver", "rich", 1234, proposal["normalized_controls"], fixed_rest_points_mm
)
```

The model does not synthesize new anatomical topology, learn image-to-material recovery, estimate tissue optics, or infer clinical state. A future learned spatial texture/reflectance representation requires licensed, calibrated multi-view image and material data with lighting separated from appearance. Increasing synthetic recipe count alone cannot replace that evidence. Frozen geometry and language datasets/trainers remain independent.
