# VISCERA synthetic material prior — pilot v1

The selected inference model is **ridge inverse regression with organ/style conditioning**. A 2,000-step conditional neural candidate improved the global validation score but exceeded the allowed per-organ regression for gallbladder, kidney and urinary bladder, so it was not promoted.

The appearance path is factorized from frozen atlas geometry. Its six controls resolve into continuous color, roughness and shading-height/gradient fields at template-rest coordinates. It never changes anatomical geometry.

## Data and validation

768 authored recipes; 480 train / 144 validation / 144 sealed audit; 12 organs × 4 presets; 1,024 fixed source-surface points per recipe. Every derivative retains the complete recipe group. Sources share atlas lineages.

| Candidate | Validation field-summary NRMSE | Control NRMSE |
|---|---:|---:|
| mean | 0.512819 | 0.147073 |
| mlp | 0.066983 | 0.086630 |
| nearest | 0.280263 | 0.159671 |
| ridge | 0.091106 | 0.088437 |

## Sealed synthetic audit

Macro organ/style field-summary NRMSE: **0.083401**. Linear RGB MAE: **0.006656**. Roughness MAE: **0.005728**. Height-field RMSE: **0.00010740 mm**. These compare with procedural teacher fields, not real organ photographs.

768 generated proposals passed actual field bounds/finiteness and unchanged-coordinate checks. Every organ/style/mode retained at least 4 distinct control vectors among eight proposals. Requested conditional statistics remain approximate and must be measured after decoding.

## Limitations

No tissue-photograph supervision, calibrated optical measurements, biological texture frequencies, pathology labels, population validation or clinical realism validation. Pattern scales/palettes are explicit authored heuristics. Material height is shading detail, not surface displacement. The model is an appearance design-space prior, not a texture foundation model.

Unconditional generation bootstraps observed training controls with a fresh spatial seed. Conditional generation samples bounded inverse-model residuals. A model output must retain exact organ/style compatibility and pass the strict recipe validator; numeric requested conditions require independent field measurement and residual reporting.

## Reproducibility

Model SHA256: `b10d7d207d304c51c5d0cdafcb2e40f421f7e4437db194221c85d7995409759e`
Dataset release SHA256: `f4b532c0af4f6f366fd0d26fa4bfe04cc6d54df8c19714285bd77e321188ed7d`
Trainer SHA256: `ff8ec950b4318dcc27cd5288ee077a4230cd4b1faa7aa6c9ff248d00abf76356`

The model uses non-pickle NPZ inference arrays and a checked manifest. The checkpoint retains safe optimizer/RNG state for exact CPU resume. GPU Colab execution is NOT_RUN. Frozen geometry and text trainers/releases are unchanged.
