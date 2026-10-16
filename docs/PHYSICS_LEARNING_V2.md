# Physics parameter learning v2

The separate liver material estimator now accepts calibrated uniaxial ramp/hold/release, triangular and smooth cyclic histories at different rates. A three-member neural ensemble proposes instantaneous Young modulus **E**, relaxation fraction **g** and relaxation time **τ**. A bounded robust SLS fit refines all three parameters. Separate synthetic calibration produces nominal 90% marginal parameter intervals. This is a substantial expansion of the inverse-estimation pipeline, not evidence that the rendered organ is a validated human liver.

## What changed and why

V1 consumed 81 force-derived stress samples on exactly one six-second, 2.5% strain schedule. Its synthetic training used 0.3% peak Gaussian stress noise with exact strain and reference geometry. Only E received an analytic physical correction; g and τ were neural predictions. Its reported ensemble spread was explicitly uncalibrated.

V2 supplies the network with measured strain, measured stress and physical duration. Both channels use the same `observation_features` implementation in training and serving, resampled to 81 normalized-time positions. Three additional values retain absolute strain amplitude, absolute stress/strain scale and duration; there are 165 features. Discarding these scales would destroy E and τ identifiability. Three MLPs use 160 and 96 hidden units and bounded normalized outputs.

The physical model remains a passive, one-relaxation-time standard linear solid: instantaneous modulus E, equilibrium modulus E(1−g), and Maxwell time τ. The response is the exact convolution for piecewise-linear strain. Bounded robust least squares refines the neural proposal. A recurrence implementation from v1 independently checks the convolution to floating-point precision. V2 does not add capsule mechanics, anisotropy, poroelastic flow or a second relaxation branch to the simulation.

## Research basis and method selection

[DiffTactile](https://arxiv.org/html/2403.08716v1) fits material and contact parameters using synchronized measured forces and tactile deformation, with distinct manipulation sequences for validation. The useful principle here is to retain calibrated observations and test the physical response after identification. Our implementation does not use its tactile sensor, FEM/MPM engine or real-data evidence.

[DiffTaichi](https://arxiv.org/abs/1910.00935) establishes differentiable simulation as a practical tool for learning and optimization. For this three-parameter constitutive subproblem, bounded differentiation of a compact exact response is sufficient; adopting a full simulation language would add infrastructure without supplying missing liver measurements. SciPy computes finite-difference residual sensitivities here; this is not end-to-end differentiable surgical FEM.

[SoftGym](https://arxiv.org/abs/2011.07215) supplies repeatable deformable-manipulation tasks and emphasizes partially observed state. It is useful as an evaluation design reference, not a source of measured liver parameters or a justification for inference from unscaled video.

[Capilnasiu et al., nonlinear viscoelastic bovine liver model](https://kclpure.kcl.ac.uk/ws/files/123934652/Nonlinear_viscoelastic_constitutive_model_CAPILNASIU_Accepted21January2020_Published2February2020_GOLD_VoR_CC_BY_.pdf) studies nonlinear and rate-dependent liver response. Consequently, the current small-strain one-term SLS is explicitly limited; a good residual cannot establish the correct biological constitutive law. Two-branch and nonlinear alternative generators are tested as model-mismatch cases rather than silently used as equivalent training truth.

[Angelopoulos and Bates](https://arxiv.org/abs/2107.07511) describe split-conformal uncertainty calibration. V2 applies independent calibration scores to sensitivity-scaled errors in encoded parameter space. The reported coverage is marginal, with exchangeability limited to the documented synthetic generator. It is neither simultaneous three-parameter coverage nor a guarantee for human observations.

## Training and separation

The frozen artifact is `artifacts/physics/liver-network-v2`, version `liver-inverse-sls-2.0.0`, SHA256 `949e8725e5839eaaa73d6e33e9cbe179ad75614231cd9fb92e2e290f6b48476e`.

| Split | Independent synthetic specimens | Seed |
|---|---:|---:|
| Training | 12,000 | 27103 |
| Weight selection | 1,200 | 28103 |
| Uncertainty calibration | 900 | 29103 |
| Final IID test | 640 | 139103 |
| Held-out parameter region | 320 | 149103 |

Each specimen contributes one entire history. There is no frame-level split. E and τ are sampled logarithmically, g linearly, within the existing material bounds. An encoded E/g/τ box `[.68,.86] × [.58,.90] × [.25,.60]` is excluded from training, selection, calibration and IID testing, and evaluated separately. Specimen IDs, deterministic seeds, generator source and split fingerprints make the separation reproducible.

Training randomizes ramp/hold/release, triangular and cyclic histories; durations from 1 to 12 seconds; peak strain .0053–.0485; 33/65/81/129/193 samples with timing jitter; Gaussian force noise from 0.1% to 3% of peak; strain noise of 0.1% of amplitude; stress-scale log SD .008 and strain-scale log SD .006; and a small force drift. The wider accepted amplitude margin .005–.05 allows the randomized measurement noise. These are engineering synthetic priors, not empirically fitted clinical sensor specifications.

The initial development run used test seeds 39103/49103/59103. Those were not reused for the final audit. We froze the evaluation gates before the final run and did not tune weights or intervals on the final tests. Independent selection chooses each member's weights; the 900 calibration specimens determine interval quantiles only.

## Frozen results

| Metric | E | g | τ |
|---|---:|---:|---:|
| IID median absolute relative error | 1.43% | 2.17% | 5.30% |
| IID p95 absolute relative error | 17.72% | 44.79% | 79.61% |
| Nominal 90% interval coverage | 91.09% | 92.34% | 91.72% |
| Median interval width / true value | 7.42% | 12.39% | 29.27% |
| Held-out parameter-box median error | 1.67% | 0.90% | 2.79% |

Observed-stress NRMSE p95 is **2.805%**, with 0.05 as the maximum fit gate. Median clean-response NRMSE, evaluated against noise-free synthetic truth, is **0.497%**. On 320 fixed-v1-schedule observations, p95 observed-stress NRMSE is **0.345%**. The application acceptance rate on all IID specimens is **92.34%**. All nine predeclared synthetic gates pass; the raw report retains every gate and threshold.

Tails remain important. Unconditional p95 interval widths relative to true E/g/τ are 100.7%/187.5%/1165.4%. Even the accepted subset has p95 parameter errors 15.2%/33.2%/65.5%, and p95 interval widths 40.3%/106.6%/383.9%. These large intervals are useful warnings about weak experiments; the median result must not be presented as accuracy for every specimen. Per-specimen data preserve both accepted and rejected cases.

The neural-only proposal has median E/g/τ errors **5.99%/5.09%/11.87%**. A non-neural bounded fit starting from the center of the prior reaches essentially the same accuracy as neural plus physical refinement. Neural warm starts reduce median physical evaluations from **16 to 9**, but the measured warm pipeline takes **8.89 ms median / 19.63 ms p95**, versus **8.72 / 22.79 ms** for non-neural fitting. There is **no demonstrated median runtime advantage**. Artifact loading/checksum verification separately takes 35.6 ms median on the audit machine. These are CPU measurements, not browser frame rates or guaranteed serving latency.

## Uncertainty and out-of-distribution behavior

The fit returns `within_synthetic_fit_gate` solely for residual ≤5%. `accepted_for_application` additionally checks loading/unloading excitation, strain-rate support, fitted bounds, local sensitivity/condition and optimizer convergence. A good residual alone does not authorize material application. `rejection_reasons` states which checks failed.

Across 240 specimens per mismatch type, rejection is **100% for a strong incompatible oscillatory component**, **23.3% for two relaxation branches**, and **34.6% for nonlinear strain stiffening**. Many alternative material laws are indistinguishable from an effective SLS over a single experiment. The model does not detect every mismatch. Its intervals do not include that biological model uncertainty or unknown calibration bias beyond the randomized priors.

ν, density, contact stiffness, fracture energy, capsule properties and heterogeneity remain prescribed or unidentified. Neither liver shape/color nor arbitrary surgical video is a calibrated force/strain experiment. Additional nonlinear, multiaxial and measured liver data are needed before expanding the constitutive claims.

## Serving and rollback

`physics_learning_v2.infer_observation` retains v1's keyword arguments: `times_s`, `force_n`, `displacement_mm`, `reference_length_mm`, `reference_area_mm2`, and `provenance`. It accepts 16–257 finite, strictly increasing observations beginning at zero, duration 1–12 seconds, and positive uniaxial strain convention with .5–5% peak. Input acceptance is broader than the discrete training sample counts; uncertainty coverage is established for the documented generator, not every possible sampling pattern.

`parameter_intervals_90` maps each learned parameter to `{lower, upper}` in physical units. `neural_parameters` records the unrefined proposal. `ensemble_std` remains ensemble disagreement, distinct from calibrated intervals. Parameters and interval bounds are clipped within strict physical bounds to avoid `exp(log(bound))` roundoff violations.

The API selects the estimator by the model manifest version. V1 code and artifacts remain unchanged. Rollback sets `VISCERA_PHYSICS_MODEL` to `artifacts/physics/liver-network-v1` (or its identical local copy). V2 should be activated only with its matching successful evaluation report. The Python API owns enforcement of `accepted_for_application`; clients must not bypass it based on appearance or fit alone.

## Reproduction

```sh
PYTHONPATH=py OPENBLAS_NUM_THREADS=1 python scripts/train_liver_physics_v2.py --output artifacts/physics/liver-network-v2 --v1 artifacts/physics/liver-network-v1
PYTHONPATH=py OPENBLAS_NUM_THREADS=1 python scripts/evaluate_liver_physics_v2.py --model artifacts/physics/liver-network-v2 --output benchmarks/results/physics-ai-v2-2026-10-07
PYTHONPATH=py python -m pytest tests/python/test_physics_learning_v2.py
```

The training environment used PyTorch 2.14.1, NumPy 2.4.6 and SciPy 1.17.1. Inference needs NumPy and SciPy, not PyTorch. Local execution under `/tmp/viscera-physics-v2` avoided cloud-backed source/dependency stalls; final new files and artifacts were copied atomically into the workspace, leaving v1 intact. The model audit, logs, source hashes and 14 focused test results are stored in `benchmarks/results/physics-ai-v2-2026-10-07`.
