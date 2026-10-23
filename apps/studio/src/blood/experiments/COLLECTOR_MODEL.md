# Spatial collector model and validation

Validated 2026-10-20. `CollectorFilm` in `collector.ts` is an inertial, depth-averaged collector. Its historical API name does **not** imply that inertia is neglected. `CollectorThinFilm` is a separate, restricted creeping-flow reference; it is not used for arterial impacts.

## Physical scope and units

The collector evolves a single-valued liquid layer on a flat, impermeable rectangular tray. State is cell-average thickness `h` in metres and horizontal discharge `q = h(u,w)` in m²/s. Density is kg/m³, dynamic viscosity Pa·s, surface tension N/m, pressure Pa, time s, volume m³ and energy J. Grid order is `z * nx + x`; world cell centres are `origin + (index + 0.5) * spacing`.

The equations implemented between impact events are

```text
∂t h + ∇·q = 0
∂t q + ∇·(q⊗q / h + ½ g h² I)
    = −(h/ρ) ∇pσ − 3 μ q / (ρ h²)
pσ = −σ ∇·(∇h / sqrt(1 + |∇h|²))
```

The hydrostatic, depth-averaged mass/momentum equations and their gravity-wave characteristics follow the [Clawpack shallow-water reference](https://www.clawpack.org/riemann_book/html/Shallow_water.html). They omit resolved vertical acceleration and are most defensible for long horizontal scales compared with depth. The laminar basal-drag closure approximates a no-slip base and shear-free upper surface; its applicability at rapidly changing impact sites is not established merely by accepting a numerical step.

The model extends graph capillarity beyond linear curvature. This fixes the earlier artificial rejection at a slope of 0.3; it does **not** remove the hydrostatic or single-valued-surface approximations. Graphics heightfield methods such as [Chentanez and Müller](https://matthias-research.github.io/pages/publications/hfFluid.pdf) motivate the representation, but this implementation does not claim to reproduce that paper's complete solver or its splash model.

## Source deposition and physical prewetting

The default tray is 0.16 × 0.20 m with 64² cells and a **physical, initially stationary 20 µm blood film**. Initial volume is 0.64 mL. Both this volume and its optical thickness remain in the accepted grid. The renderer must not subtract the initial layer, conceal it as zero-thickness geometry, or make only newly deposited volume visible.

Only authoritative flight-model landing events are deposited. Each carries a unique ID, analytic impact time, world x/z location, volume and velocity. A fixed outer step is split at those exact times. Cloud-in-cell transfer uses four neighbouring cell centres, preserving total volume, subcell first moments away from walls, and incoming horizontal momentum `ρ V (vx,vz)`. Support folds into boundary cells at a closed wall. Hits outside the tray are recorded as escaped; their mass is never redistributed into the visible pool.

The standalone flight model retains a **fixed collection plane** when no surface is supplied. The current coupled experiment supplies the previous accepted collector height field and finds contact with its upper surface. The historical fixed-plane envelope results below must not be mistaken for validation of this later integration.

This is a local grid source, not a fitted impact footprint. It does not infer a radial impulse from a visually chosen splat radius. The vertical kinetic energy is explicitly lost in this reduced impact closure. Horizontal inelastic mixing loss is also recorded. Drop deformation, impact crown/splash, air entrapment and reconversion of vertical momentum into horizontal motion require another model.

### Height-aware contact integration contract

The implemented height-aware flight extension consumes a **private, previous-accepted** collector field: `{timeSeconds, heightM, nx, nz, widthM, depthM, originXM, originZM}`. It is optional in the standalone flight API and always supplied by `VesselFlowExperiment`. Values are depths above the base collection plane, including the entire prewet film. The field remains immutable throughout the flight step. Outside its rectangle, the base plane is the contact reference.

Its contact reconstruction must match the displayed continuous surface: each shared corner averages the four adjacent clamped cell values; each cell is a four-triangle fan around the mean of its corner heights. Using nearest-cell heights, an unrelated bilinear cell-centre surface or an invented impact radius would introduce a second, inconsistent surface. Float32 renderer-coordinate rounding is the only intended discrepancy.

Even continuous ballistic crossing against that field is **first-order lagged coupling**: impacts within `[t,t+dt]` see `h(t)`, and the collector then evolves/deposits to `h(t+dt)`. It does not resolve a moving surface during the step, feedback from earlier same-step impacts into later contacts, or vertical fluid/drop collision dynamics. A trajectory entering and leaving a local ridge within one step must not be missed merely because both endpoint clearances are positive. Integration validation for this extension belongs to the flight/coordinator tests; the fixed-plane envelope results below do not establish its correctness.

## Discretization and acceptance

Internal hydrostatic fluxes are pairwise conservative Rusanov fluxes. Reflective wall fluxes have zero mass transport and exert the corresponding wall forces. Time integration uses SSPRK2 with half-step exact exponential basal-drag updates before and after it.

Capillary energy is a symmetric four-quadrant graph-area quadrature. Each quadrant uses the two adjacent one-sided height differences; the resulting pressure is the **exact discrete gradient of that energy** divided by cell area. There is no height smoothing pass, volume clipping or rendering-only flattening. The full continuum energy being approximated is

```text
E = ∫ [½ρ |q|²/h + ½ρ g h²
       + σ(sqrt(1 + |∇h|²) − 1)] dx dz.
```

The graph-area expression evaluates `s² / (sqrt(1+s²)+1)` to avoid cancellation in nearly flat regions. Local source-energy differences visit only affected cells and their immediate neighbours; this is algebraically the same energy as the full-grid calculation.

Every accepted inner step must satisfy:

- finite, strictly positive heights and finite momenta;
- maximum height below 10% of the smaller tray dimension;
- an advective/gravity CFL limit of 0.3, plus a conservative capillary-frequency limit;
- no unforced energy increase beyond `max(1e-24 J, 2e-12 * |E|)` arithmetic tolerance;
- bounded substep work; rejection rather than silently advancing a partial frame.

Failed trial stages halve the step. Failure to make progress, exceeding the work budget, or violating the volume ledger rejects the complete outer step. `prepareStep()` leaves accepted state untouched; `commit()` is single-use and rejects stale previews. Opaque owner-tagged checkpoints support rollback. Exported arrays are detached from private state.

The layer-volume identity is

```text
film + escaped = initial film + input
input = deposited + escaped.
```

The accepted relative mass-error limit is `2e-10`. The coupled coordinator separately verifies that collector input equals authoritative flight landings and includes the initial film exactly once in its global inventory.

## Energy diagnostics and warnings

`sourceEnergyJ` is the change in represented layer energy caused by inserting fluid. `basalDissipatedEnergyJ` is the analytic split-drag loss. `numericalDissipatedEnergyJ` records the remaining discrete loss, including Rusanov diffusion, and must not be presented as measured viscous dissipation. `impactDissipatedEnergyJ` separately accounts for discarded vertical kinetic energy and horizontal mixing.

The layer ledger checks `E + basal + numerical − E_initial − sourceEnergy`. This is a solver-work balance, **not proof that the entire vessel/jet/impact process conserves physical energy**. The source closure does not resolve the incoming drop's interfacial energy, deformation or detailed contact work.

`steepFrontWarning` is true when `maxSlope > config.maxSlope` (default 0.3). The slope diagnostic is a conservative bound formed from maximum x/z differences. Recommended visible wording:

> Steep local front: capillary geometry is nonlinear, but hydrostatic impact and basal-drag accuracy are approximate.

Display it separately from a numerical rejection. The accepted field must remain visible; warning dismissal must not alter its height or momentum. Also identify the initial 20 µm film in the UI and export. The high-end tested cases reached film Reynolds number 726 and slope 0.579. Those values are useful warnings about closure accuracy, not evidence of a resolved turbulent or three-dimensional flow.

The model currently assumes a Newtonian user-selected viscosity, no absorption or coagulation, no dry moving contact line/contact-angle hysteresis, and closed tray walls. The global aspect guard alone cannot establish local shallow-flow accuracy. Dense 3D impact/splash, wetting on tissue, non-Newtonian film rheology and patient-specific parameters remain unvalidated.

## Independent tests and measured results

`collector.test.ts` checks stationarity, physical volume, exact source momentum and position, edge/corner source-work equivalence, missed-impact accounting, positivity, symmetry, nonlinear relaxation, and transactional failures.

Independent analytic checks:

| Check | Reference | Result |
|---|---|---|
| Full graph curvature | Analytically differentiated `A cos(kx) cos(kz)`, slopes near one | Relative L2 errors 0.0117543, 0.00267204, 0.000673025 at 24²/48²/96²; approximately second order |
| Variational pressure | Directional finite difference of total energy, including boundaries | Absolute derivative discrepancy below `2e-10`; integrated pressure below `2e-16` |
| Small gravity/capillary waves | `ω² = g h₀ k² + σ h₀ k⁴/ρ` | 32/64/128 refinement reduces error by at least 30% per doubling; finest amplitude error below 3% |
| Wet-bed dam break | Independent rarefaction/shock Riemann construction | 32/64/128 mean height error decreases by at least 20% per doubling, before wall reflection |
| Steep graph relaxation | No source, initially symmetric positive ridge | Energy falls, peak lowers, symmetry and volume survive without clipping |

`collectorEnvelope.test.ts` runs **12 actual coupled vessel/flight cases for one physical second each**, using the UI's curved vessel, all three punctures and analytic flight impacts. Eight arterial corners use 140 mmHg, 0.6 mm puncture radius, μ = 3.45/30 mPa·s, σ = 45/65 mN/m and initial jet disturbances 0.5/2%. Four venous cases cover 5/20 mmHg, 0.2/0.6 mm radii and both viscosity endpoints.

All 12 accepted every step. Worst observed values were 10 inner substeps per 2 ms outer step, relative film mass error `7.254e-15`, layer-energy ledger error `8.240e-17 J`, slope 0.5792 and film Reynolds number 725.8. No source volume escaped in these particular trajectories. These are numerical-envelope tests, not experimental physiological validation. The final three-file collector/reference/envelope run passed **31 tests in 39.37 seconds** on the development machine; this includes test assertions and concurrent test workers and is **not** an application frame-rate benchmark.

The separate creeping-film oracle follows

```text
∂t h = ∇·[h³/(3μ) ∇(ρgh − σΔh)].
```

It uses conservative local fluxes with exact quadratic-energy/positivity step bounds and rejects large slopes or film Reynolds number above one. Eight tests cover Fourier-decay refinement, inverse-viscosity time scaling, boundaries, mass, energy and rollback. It is retained because low-Re lubrication theory is useful independently; forcing it to accept arterial impact momentum would be unjustified. The broader theoretical background is [Oron, Davis and Bankoff, Reviews of Modern Physics 69 (1997)](https://doi.org/10.1103/RevModPhys.69.931).

## Reproduction

From `viscera/`, using the repository's supported Node version (22 or newer):

```sh
node node_modules/vitest/vitest.mjs run \
  apps/studio/src/blood/experiments/collector.test.ts \
  apps/studio/src/blood/experiments/collectorThinFilm.test.ts \
  apps/studio/src/blood/experiments/collectorEnvelope.test.ts \
  apps/studio/src/blood/experiments/vesselFlow.test.ts --reporter=verbose
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
```

The 2026-10-20 collector/reference/envelope receipt is in `artifacts/blood-experiments-2026-10-20/collector-validation.json`. It includes the edge/corner source-work regression and the final stage-validation optimization. The four original coordinator transaction tests were also run separately; subsequent cardiovascular integration has its own additional tests and receipts.

## Stage-validation optimization

An isolated optimization removes unused speed, Reynolds and next-step CFL calculations from the two RK trial-stage validations. It retains their finite-state, positivity and aspect guards exactly. Accepted-state timestep selection, arithmetic updates, source transfer and energy acceptance are unchanged.

`artifacts/blood-experiments-2026-10-20/collector-optimization/compare.mjs` bundles the saved pre-optimization source and current source independently. The comparison requires exact equality of every accepted snapshot, every energy/mass/source ledger and all telemetry. It covered 1,350 steps, including 1,550 authoritative three-hole arterial impacts at both viscosity endpoints, stationary film and steep relaxation. Two rejection/rollback scenarios also matched exactly.

Alternating before/after CPU timings measured 3,791.8 → 2,928.7 ms and 3,048.8 → 2,416.8 ms for the two one-second arterial event tapes (1.29×/1.26× speedups). Steep relaxation improved 914.3 → 685.6 ms (1.33×). These exploratory Node 24.18.0 timings include collector snapshot construction; they do not measure browser rendering, GPU throughput or a guaranteed real-time playback rate. Source hashes and raw results are in `collector-optimization/comparison.json`.
