# Executed operative appearance statistics pilot

The Python script fits six multiscale bands and a257-quantile marginal distribution of local log-red chromaticity from separately reviewed DSAD regions. The resulting periodic data texture contains a fresh random layout: R is statistically fitted red residual; G and B are independently authored smooth/fine auxiliary fields; A is255. It is **not a copied surgical photograph, learned albedo, semantic blood segmentation, neural retraining, or a fluid simulator**.

Input: `/tmp/viscera-operative-data-research/roi-manifest.json`. Source downloaded frame metadata and hashes: `download-manifest-rows.json` in that directory. All10source hashes verified before use; region surgery assignments checked. The source publisher viewer supplied compressed1280×1024JPEG renditions under filenames ending`.png`. We do not use the JPEG masks as exact binary ground truth.

- Fit:6ROIs from surgeries04,22,28,29.
- Holdout:4ROIs from surgeries10,23,31, excluded from parameter fitting. Three classes have train/heldout pairs; clean-serosa holdout has no matching training class. A given class has only one fitting ROI, so this is a tiny observational pilot, not broad generalization evidence.
- Red-film model: one105×111pixel ROI from surgery04; heldout165×130pixel ROI from surgery31. Assistant visually reviewed labels, no surgeon pixel annotation or temporal blood/coagulation confirmation.
- Hyperparameters fixed before metrics: sRGB-offset4log red chromaticity; subtractσ32Gaussian;σ1,2,4,8,16,32bands;257marginal quantiles;80th-percentile residual threshold; randomseed42. Heldout results were not used to adjust fitting hyperparameters.

Equivalent invocation with Python 3.11, NumPy, SciPy and Pillow installed:

```sh
python3.11 scripts/fit_operative_statistics.py \
 --roi-manifest /tmp/viscera-operative-data-research/roi-manifest.json \
 --output /tmp/viscera-operative-fit-v2/final-fit --seed 42 --side 512
```

The executed ROI manifest and its original hash are retained as
`roi-manifest.executed.json`. `roi-manifest.json` is a portable copy with relative
source paths; run from the downloaded dataset directory or adjust these paths.
Changing paths changes the manifest hash but not the fitted image statistics.


Execution:1.535s CPU, Python3.11.16/NumPy2.4.6. Files:

- `final-fit/model.json`: frozen fitting parameters and provenance; SHA256`c77d5dca2233d1dc91a0cef1b9eb7be2882bbcbad4cd58a89057390de24d45a3`.
- `final-fit/report.json`: all10region descriptors, three class-matched holdout comparisons, generated-field metrics, runtime.
- `final-fit/operative-statistical-descriptor-seed42.png`:512×512RGBA data texture; SHA256`c60ac504eff34eb25aaee6e0f7c8b20aea65e0520adf9911ac61ea8a090304fa`.
- `verification.json`:7passing deterministic/finite/split/seed/alpha checks plus spectrum ablation.
- `replay-fit/`: exact output replay; `adjacent-seed/`: same model, changedseed43layout.
- `fit/` and `frozen-fit/`: preserved earlier iterations. Final script corrected the processing order so model serialization precedes any heldout image loading; fitted results and texture are unchanged.

GPU upload: use linear/data color space, RepeatWrapping, mipmaps. R decodes as `residual = -.3520836691 + R * 1.4924233595`. The fitted80th-percentile is R`.33056334755`, so a hard threshold would select about20%of fit field. This percentage is **a chosen statistical quantile**, not measured blood-area prevalence. The heldout field at that frozen threshold selects16.48%; it does not mean16.48%blood in the surgery. Edge softness, placement, film-thickness scale, physical mapping and directional stretching remain authored rendering parameters.

Fit band fractions from fine→coarse: `[.02470364,.03624629,.11431519,.24887515,.36928495,.20657479]`. Sampling uses independent wrapped Gaussian-band fields with NNLS-fitted nonnegative variance weights, then empirical marginal transport; it retains aggregate spectrum/distribution without source layout. Pixel sigma is uncalibrated: map to millimetres only as an explicitly authored visual scale.

Generated-vs-fit: quantile W1`.00137`in log-chroma, band-fraction L1`.0999`, seam/interior neighbor difference ratio`1.024`. The independent heldout film has band L1`.360`against fitted target and a different standard deviation/directionality. Generated-field-vs-heldout band L1`.397`; an equal-band ablation with the same learned marginal scores`.813`. That narrower spectrum comparison supports data fitting over equal octave weights; it does not compare to the current renderer or certify visual realism. The generated field's anisotropy error is`.382`, exposing a remaining missing directional structure.

Rights: publisher card and Figshare record say CC BY4.0; article prose also says non-commercial. Existing project tissue-learning docs conservatively treat DSAD-trained weights as research-only. This pilot retains that discrepancy and does not purport to resolve it. There is no separate applicable AGENTS restriction forbidding numeric aggregate deployment. Parent should preserve CC BY attribution and the discrepancy in provenance, and not claim unrestricted commercial clearance. No GynSurg data, raw source crop, or original pixel layout is contained in the model/descriptor. Attribution: Carstens etal., *The Dresden Surgical Anatomy Dataset for abdominal organ segmentation in surgical data science*, Scientific Data10,3(2023), https://doi.org/10.1038/s41597-022-01719-2 ; https://huggingface.co/datasets/nct-tso/dsad .
