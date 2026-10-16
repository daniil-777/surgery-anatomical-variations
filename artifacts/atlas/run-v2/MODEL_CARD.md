# VISCERA atlas control model · release v2

Frozen model: `0464b98318df4461128e2d18b1ce1168f853214f519a3a53b051bae98118a090`  
Dataset release: `f1142554e6c82e9a4f80` (1,536 accepted synthetic recipes; 24 source templates; 12 organ categories).

The selected method is **per-template ridge inverse regression with bounded residual bootstrap proposals**. A template mean, nearest recipe and a 2,000-step conditional neural model were compared. Ridge best recovered held-out controls and measured dimensions; the neural candidate was not promoted. The detailed source geometry remains an immutable high-resolution decoder. This is a statistical atlas control model, not a free-form text-to-mesh foundation model.

## Measured results

All evaluation uses held-out synthetic recipes from the same limited source lineages. These errors measure recovery of this generator's numeric geometry labels. They are **not distances from independently scanned human organs**.

| Candidate | Validation control RMSE / full control range |
|---|---:|
| Template mean | 0.29592 |
| Nearest recipe | 0.32485 |
| Ridge | 0.20948 |
| Conditional neural candidate | 0.22611 |

The model was frozen before accessing the final 240-recipe audit. Audit control RMSE / full range: **0.20529**. Actual decoded X/Y/Z extent mean absolute errors: **0.13548 / 0.14345 / 0.14283 mm**; triangle surface area MAE: **147.70 mm²**. Volume and compactness are unavailable and remain masked because source display assemblies are not validated closed tissue volumes.

A separate generated-sample check realized **576 variations**: 12 unconditional and 12 conditional recipes per template. All 576 passed the scoped numerical surface-deformation checks. All 24 optional real-decoder numeric refinements matched their requested extent tolerance. No organ identities or templates were interpolated. `generated_sample_qa.json` preserves every control vector, seed, measurement and geometry QA result, allowing high-resolution reconstruction without duplicating meshes.

## Support and limitations

- Controls: normalized X/Y/Z scale, bend, twist, taper and asymmetry, each bounded in [-1,1]. The template determines organ identity, source ancestry and deformation limits.
- Unconditional generation bootstraps actual training recipes. Conditional generation uses available measured constraints and bounded residual proposals. Frequencies are synthetic design choices, not measured population priors.
- Requested conditions outside observed training support are rejected by the sampler. Optional `refine_controls` uses the real decoder and reports infeasible constraints explicitly.
- Shared reference lineages across all splits preclude patient-independent generalization claims. Multiple sex/laterality template labels do not necessarily represent independent donors.
- Source topology, real anatomy, pathology coverage, real tissue appearance, volumetric mechanics and clinical utility require separate evidence. Numerical QA does not supply this evidence.
- The text interface is a separate constrained compiler. This checkpoint does not learn language or pixel textures.

## Reproducibility

The final configuration, optimizer and random states, source hash, exact release hashes and hardware/runtime are recorded in `checkpoint.pt` and `training_report.json`. The training source SHA-256 is `863e34f6974da1e1a7abc1bb8f51d3730b8efec6724c79bbb18c0a1b2cd7bc59`. Training never opened audit labels. The final source and configuration were not changed in response to the audit. CPU continuation was tested bit-exact; cross-device bitwise equivalence is not promised. Colab notebook logic was executed locally end-to-end on a small real atlas development release; Colab GPU execution was not performed here.

Development iterations: the original synthetic phantom workflow was retained separately; atlas training first used the v1 release for baseline comparison; the final v2 release added recursive license/provenance hashing, then retrained the fixed configuration before the final audit. The v1 audit was never used for selection.

## Attribution

Derived from the [Human Reference Atlas](https://humanatlas.io/3d-reference-library) (CC BY 4.0) and the official [BodyParts3D archive](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html) (CC BY 4.0).

**BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International.**

`ATTRIBUTIONS.md` and the `attribution/` files preserve exact source records and creator credits. Retain attribution with redistributed models and derived geometry. The dataset release and each source/template hash accompany this run.
