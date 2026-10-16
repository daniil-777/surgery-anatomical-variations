# Selective application of liver physics parameters

**Decision: experimental candidate only; policy remains off by default.**
The final frozen IID test accepts 645/1000 observations (64.5%), missing the
predeclared 65% gate. No threshold or seed was changed after observing this
result. The unchanged v2 estimator remains the serving default. Per-observation
passes from the research library do not override the failed artifact-level
promotion gate.

The optional `liver-sls-application-policy-1.2.0` screens an experiment before
applying the frozen v2 network's parameters to the liver. It does not retrain
the network, change its fitted E/g/τ, widen the constitutive law, or establish
human tissue validity. Its purpose is to reduce application of poorly identified
or systematically mismatched small-strain SLS fits.

The model remains `liver-inverse-sls-2.0.0`, SHA256
`949e8725e5839eaaa73d6e33e9cbe179ad75614231cd9fb92e2e290f6b48476e`.
Historical v2 artifacts and test cohorts are preserved unchanged.

## What the policy checks

1. **Precision before prior truncation.** V2's nominal 90% marginal intervals
   are clipped to its physical parameter bounds. A broad, weakly identified
   interval can therefore look narrower than its underlying sensitivity.
   The policy reconstructs the same local sensitivity scale and conformal
   multiplier, then checks the untruncated full span relative to the estimate:
   E≤25%, relaxation fraction≤50%, relaxation time≤100%. These are explicit
   engineering application thresholds. The untruncated span is a diagnostic,
   not a posterior interval outside the prior and not human uncertainty.
2. **Structured residuals.** A low stress RMSE can conceal an extra relaxation
   timescale or nonlinear strain response. The policy forms directions for
   seven additional relaxation times and a quadratic strain response, removes
   components along the fitted SLS tangent and the declared linear sensor-drift
   nuisance, and measures coherent residual
   projection relative to successive-difference noise. A fresh 2400-specimen
   valid-SLS calibration set supplies a conformal rank p-value. Values ≤0.05
   trigger `structured_residual_not_explained`.
   Calibration is stratified by the observed successive-difference residual
   noise, with fixed boundaries at 0.5% and 1.5% of peak stress. Generator noise
   labels are never used for inference. Every stratum requires at least 100
   calibration scores; missing or invalid strata fail explicitly rather than
   falling back to a permissive pooled threshold.
   Removing the drift direction affects only this diagnostic: estimates,
   response curves and original RMSE checks remain unchanged. It deliberately
   cannot distinguish a slow material response collinear with sensor drift.
3. **All original checks remain.** Refinement convergence, excitation,
   strain-rate support, sensitivity, bounds and residual magnitude must still
   pass. `within_synthetic_fit_gate` remains a residual-only flag;
   `accepted_for_application` combines original and optional policy checks.

The small residual floor prevents floating-point roundoff in exact synthetic
responses from becoming a structural warning. Geometry/unit calibration is
still required. A stress scale error can be indistinguishable from a different
Young modulus, and cannot be recovered from force/displacement alone.

## Research basis and method choice

Identifiability work distinguishes matching a response from constraining its
parameters. Profile likelihood can reveal nonlinear or one-sided uncertainty;
the current lightweight policy uses local sensitivity with conservative
untruncated spans instead of claiming to implement profile likelihood.
This is a targeted application check, not a complete identifiability proof.
[Raue et al., 2009](https://pubmed.ncbi.nlm.nih.gov/19505944/).

Conformal rank p-values allow a fixed anomaly score to be calibrated on an
independent reference population. Here that population consists only of
synthetic, independently sampled, valid-SLS experiments. The false-rejection
interpretation is marginal within each predeclared noise stratum under
exchangeability, not conditional on every continuous noise level, specimen
class, or protocol, and does not transfer automatically
to real sensors. We do not claim multiple-testing/FDR control for repeated
user uploads. [Bates et al.](https://arxiv.org/abs/2104.08279).

Conformal risk control was also considered, but its expected-risk guarantees
should not be confused with a guarantee on the errors of a selected subset.
The interval-precision thresholds here are predeclared engineering gates;
accepted-case tail errors are measured independently, not promised by a
conformal theorem. [Angelopoulos et al.](https://arxiv.org/abs/2208.02814).

No additional adequacy classifier is trained. The diagnostic depends on
physical response directions and works with the non-neural bounded fit too.
This avoids presenting another neural model as independent physical evidence.

## Frozen evaluation design

`scripts/evaluate_liver_physics_robustness.py` records a plan, source hashes,
seeds and gates before calibration or test evaluation. Development seeds
771101–771303 and final seeds 1071101–1071303 are disjoint from each other and
all historical v2 training, calibration and test seeds. A row is one synthetic
parameter specimen and one full experiment; frames are never split across
cohorts. No new network weights are selected.

The final audit uses 2400 calibration specimens, 1000 IID test specimens,
320 per parameter-region/higher-excitation/model-mismatch cohort, and 160 per
noise stress cohort. Valid IID observations retain v2's force noise 0.1–3% of
peak, strain noise 0.1% of amplitude, randomized scale errors, drift, irregular
sampling, durations 1–12 s and peak strains 0.5–5%. The parameter-region test uses
the box previously excluded from v2 network training.

Higher-excitation tests add several loading rates, amplitudes, holds and
releases within the same calibrated small-strain limits. This is a validation
challenge for the unchanged model, not a claim that the neural network was
trained on these extra protocols. Mismatch cohorts use two relaxation branches
or quadratic strain stiffening, with force/strain noise retained. Near-equivalent
and materially mismatched traces are reported separately using the residual
of a clean-response best SLS fit, with a 1% NRMSE reporting boundary.

Frozen application gates are accepted IID p95 parameter errors ≤10%/20%/35%
for E/g/τ; IID acceptance ≥65% and ≥500 accepted specimens; structured-check
false rejection ≤7.5%; low-noise false rejection ≤10%; marginal interval
coverage ≥85%; and pooled mismatch rejection improvement ≥10 percentage
points over v2. These synthetic gates
do not authorize clinical use.

## Results

Final results and immutable policy identity are recorded in the accompanying
`benchmarks/results/physics-ai-robustness-2026-10-07/evaluation.json` and
`artifacts/physics/liver-application-policy-v1/policy-manifest.json`.
The report includes baseline acceptance, accepted-tail errors, interval
coverage and width, per-reason rejection counts, independent non-neural fit
comparison, model-mismatch strata, and added diagnostic latency.

The final comparison uses the same 1000 IID observations for both policies.
Every estimate is unchanged; lower accepted-case errors result from selecting
experiments with usable precision and residual structure.

| Final IID measure | Original v2 | Candidate 1.2 |
| --- | ---: | ---: |
| Valid-calibration application acceptance | 89.2% | **64.5%** |
| Accepted p95 E relative error | 14.29% | 5.85% |
| Accepted p95 g relative error | 33.84% | 10.75% |
| Accepted p95 τ relative error | 63.01% | 20.70% |

Six of seven frozen gates pass. The acceptance criterion misses its 65% minimum
by five observations. Structured false warnings are 5.4% in IID observations and
5.0% in the low-noise cohort. Marginal interval coverage across all IID specimens
is 91.2%/92.0%/92.2% for E/g/τ; empirical coverage among accepted specimens is
94.1%/93.5%/93.3%. The observed-noise calibration strata contain 353/855/1192
specimens. These coverage figures are synthetic, not human posterior confidence.

Across 1280 independent two-branch/nonlinear challenges, application rejection
increases from 32.81% to 82.27%, a 49.45 percentage-point improvement. For two-branch
curves with clean best-SLS mismatch above 1%, rejection is 92.3% with the original
protocol mixture and 100% with higher excitation. Near-equivalent two-branch
curves still pass frequently. Correlated sensor noise triggers warnings 64.4%
of the time; the score cannot declare whether correlation is instrumental or
material. Higher-excitation valid-SLS observations retain 85.0% acceptance.

The non-neural bounded-fit baseline agrees on every application decision in
the 1000-case comparison and has effectively identical accepted tail errors.
Among jointly accepted cases, the largest parameter difference between the two
initializations is 0.0136%; rejected poorly identified fits can differ much more.
The new check is non-neural and provides no demonstrated neural accuracy gain.
Diagnostic-only added latency is 1.93 ms median and 5.64 ms p95 on the recorded CPU
run. End-to-end artifact-reading costs are measured separately in
`serving-latency.json`: original v2 inference median 47.47 ms versus 85.31 ms
for the optional wrapper. The wrapper currently loads the model twice to retain
the unchanged v2 validation entry point. There is no speedup claim; the warm
diagnostic numbers do not include this artifact I/O.
The final calibration/audit took 123.2 s, excluding earlier rejected candidates.

The initial pooled-null candidate used seeds 871101–871303. Although it passed
aggregate gates, its low-noise subgroup false rejection was 22.5%. That concrete
problem motivated the noise-stratified policy and a stricter low-noise gate.
The resulting stratified 1.1 candidate used fresh 971xxx seeds and failed the
same low-noise gate at 11.875%. Investigation identified linear force drift,
already present in the declared valid-observation generator, as a nuisance
that the score was incorrectly treating as constitutive discrepancy. Policy 1.2
projects that direction out before scoring, while retaining the same noise
strata and all precision/mismatch/low-noise gates. Both earlier candidates,
their exact source and results are retained as selection history, never reused
as an independent test of the revised policy. The revised method was frozen
before the fresh 1071xxx audit. No gate was loosened.

Correlated sensor noise may still be flagged as structured residual. Passing
never establishes the true constitutive law, and near-equivalent multi-branch
responses may still pass. Interval coverage after selecting accepted cases is
reported empirically; original marginal coverage is not a theorem about that
selected subset.

## API-compatible optional integration

The existing v2 module is untouched. The separate wrapper accepts the same
observation fields plus an optional policy directory:

```python
from viscera_core.physics_learning_robust import infer_observation, load_policy

result = infer_observation(
    model_directory,
    policy_directory=policy_directory,
    times_s=times, force_n=forces, displacement_mm=displacements,
    reference_length_mm=length, reference_area_mm2=area,
    provenance="Description of calibration, acquisition and units",
)
```

`load_policy(policy_directory, model_sha256)` returns `(policy, policy_digest)`
and checks checksum, version, model identity, score population, precision
limits and significance level. Missing/stale/corrupt policies fail explicitly;
there is no silent permissive fallback. The frozen network's version/model ID
are retained separately from `application_policy_version` and
`application_policy_id`.

`application_diagnostics` exposes untruncated spans, prior-truncation flags,
the residual p-value, individual check outcomes, base-v2 acceptance, additional
reasons and recommended experimental improvements. Rejected calibrations retain
their fitted curve and values for inspection. Callers should apply parameters
only when `accepted_for_application` is true **and** the policy's frozen
artifact-level evaluation has passed. Serving startup/status should verify
`evaluation.json` has `stage="final"`, `all_gates_passed=true`, every named gate
true, and matching model/policy SHA256 values. This candidate does not meet
that deployment condition. Existing v1 and v2 entry points
remain available for explicit rollback.

## Reproduction

Use an installed local dependency mirror if cloud-backed dependencies are
unavailable. No paid compute or external dataset download is required.

```sh
PYTHONPATH=py OPENBLAS_NUM_THREADS=1 python scripts/evaluate_liver_physics_robustness.py \
  --model artifacts/physics/liver-network-v2 --stage final --output /tmp/new-physics-policy-audit

PYTHONPATH=py python -m pytest tests/python/test_physics_learning_v2.py \
  tests/python/test_physics_learning_robust.py
```

Write reproduction runs to a new output directory to preserve frozen evidence.
The focused tests verify unchanged estimates, prior-truncation handling,
structured mismatch below the old RMSE gate, ordinary sensor noise, preserved
weak-excitation rejection, policy immutability, units/provenance, and invalid,
stale or altered policy artifacts.
