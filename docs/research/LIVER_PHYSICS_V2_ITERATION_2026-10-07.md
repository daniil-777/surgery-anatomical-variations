# Liver physics AI v2: iteration contract

Date: 2026-10-07. Request: improve learned liver mechanics, research primary conference/journal evidence, and examine deformation videos diligently.

## Decision and observable behavior

The user should be able to apply an independently learned material and manually manipulate the exact displayed liver. The learned stiffness and relaxation must have a documented constitutive meaning in the interactive solver. Video review should expose visible defects and measurable motion, without converting uncalibrated pixels into fictitious force labels.

Baseline: v1 neural ensemble uses only a fixed 81-sample, 2.5% uniaxial ramp/hold/release; the interactive model uses mesh-dependent edge stiffness and tetrahedral volume constraints. The previous recordings preserve gross volume at default material but reveal flattening, guard activity and unsupported boundaries. The convex cage, free body floor scene and lack of measured human calibration remain explicit.

## Experiments declared before model training

1. Train a separate, protocol-conditioned v2 estimator on varied small-strain load/hold/release/cyclic histories with declared noise and calibrated time/force/geometry. Use disjoint material specimens across training, validation, uncertainty calibration and evaluation. Compare neural-only, physically refined, constant and non-neural fitting baselines. Report held-out parameter regions and misspecified material responses.
2. Replace the browser edge calibration with the same equilibrium stable neo-Hookean and objective deviatoric Green-strain Maxwell law used in the existing offline solver, if analytic, numerical and performance gates pass. Retain an explicit legacy baseline for comparison. No invented strain-hardening coefficient will be presented as learned.
3. Inventory and deduplicate available local deformation videos; inspect sampled frames and associated trajectories, then inspect accessible primary public reference clips. Record species, acquisition, support conditions, camera motion, force/scale availability, exclusions and access limits. Public tracking datasets are not automatically material-calibration datasets.

## Acceptance and guardrails

Neural v2: fixed clean protocol stress P95 NRMSE <=1%; supported 3%-noise protocols median relative E error <5%, relative g/tau errors <15%, stress P95 NRMSE <5%. Nominal 90% marginal synthetic intervals must have >=85% test coverage, with widths reported. Gross declared mismatch rejection >=90%; supported IID false rejection <=10%. Weak excitation must be refused. These are synthetic promotion gates, not clinical accuracy claims.

Constitutive candidate: zero rest stress; rigid-rotation objectivity; finite-difference energy/stress agreement; correct small-strain E and bulk modulus; exponential stress relaxation; Python/TypeScript parity. On actual male/female cages, evaluate free fall, settle, grab/release, push, punch and repeated loading: positive Jacobians, finite trajectories, floor error, local/global volume, recovery, rejected/limited steps, safeguards, solver timing and simulation/wall-time ratio. Report failures and do not promote a candidate merely because its animation looks attractive.

Video metrics: optical flow and contours remain image-space evidence unless geometry/cameras support metric reconstruction. Use registered pairwise distances for trajectory shape change, separate rigid motion, report occlusions and frame coverage. No stiffness, viscosity, force, fracture or patient-specific claims from unscaled single-view video.

## Risks, boundaries and fallback

Available labels are predominantly synthetic; animal, phantom, ex-vivo and in-vivo evidence cannot be pooled without accounting for specimen and protocol. Material fit can be non-identifiable under inadequate excitation. The intact convex cage has no capsule, vessels, organ attachments, trocar mechanics or resolved jaw collision. A different neural architecture cannot fix absent boundary/geometry information. Keep v1 artifacts and legacy solver for reproducible rollback. Promote each component only against its declared tests; save unsuccessful candidates and remaining gaps.

Implementation, measurements and final promotion decisions are recorded alongside the corresponding model, mechanics and video reports.
