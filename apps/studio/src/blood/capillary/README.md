# Conservative capillary-film reference

Validated on 2026-10-20: **15 CPU tests pass**, including continuum references,
space/time convergence, nonlinear wetting motion and every exposed playground
combination. This component evolves an actual conserved height field. Its
surface-tension coefficient is the coefficient of interface energy in N/m.
It does not add an uncalibrated attractive force to the existing DFSPH particles.

## Physical scope

The model is a **Newtonian, inertialess, small-slope film on a flat, rigid,
impermeable substrate**, periodic in one horizontal direction and uniform in
the other. `widthM` gives the physical extrusion width used for volume, energy
and force. A rendered extrusion is a liquid ridge, not a simulated
three-dimensional drop or puddle.

No air dynamics, spherical drops, droplet breakup, inertial oscillation,
contact-angle hysteresis, inclined-substrate gravity, tissue absorption,
coagulation, shear thinning or vascular/DFSPH exchange is implemented here.
The coefficient choices and 8 μm precursor in the playground are declared
demonstration parameters, not measured blood–tissue calibration.

Height slopes are restricted to at most 0.3, height/domain-length to at most
0.1, and the contact-angle parameter to at most 0.25 radians. Accepted
candidates must have film Reynolds number at most one. These are scope guards,
not sufficient proof of validity for every possible spatial or temporal
profile. The independently tested playground has maximum film Reynolds
number 0.01744.

## Equation and units

The gradient-dynamics form follows the single-liquid limit described by
[Thiele, Todorova and Lopez (2013), opening formulation](https://www.uni-muenster.de/Physik.TP/~thiele/Paper/ThTL2013prl.pdf):

```text
∂t h = ∂x(M(h) ∂x p)
M(h) = h³ / (3 μ)
p = -σ ∂xx h + φ′(h)
E = W ∫ [σ (∂x h)² / 2 + φ(h)] dx
```

`h`, `x`, `W` are metres; time is seconds; viscosity `μ` is Pa·s;
`σ` is N/m; pressure is Pa; energy is J. `surfaceTensionNm` in the TypeScript
API denotes N/m, not torque. Mobility has units m³/(Pa·s), and the face flux
`q=-M∂xp` is m²/s per unit extrusion width.

Partial wetting uses a repulsive/attractive binding potential:

```text
φ(h) = B/(5 h⁵) - A/(2 h²)
A = (5/3) σ θ² h*²
B = A h*³
φ′(h) = A/h³ - B/h⁶
```

This potential and physical coefficient mapping appear in
[Engelnkemper and Thiele (2019), model and dimensional scaling footnote](https://www.uni-muenster.de/Physik.TP/~thiele/Paper/EnTh2019el.pdf).
The minimum is at `h=h*`, with `φ(h*)=-σθ²/2`. Thus `θ` is the
long-wave equilibrium contact-angle parameter. A finite periodic ridge's
largest slope need not equal `θ`; its precursor pressure and finite height
also affect its shape. For the independent reference used here, `θ=0.12`
but the continuum maximum slope is `0.09286177293`.

With wetting disabled, `A=B=0`; capillary leveling remains active. Turning
wetting off does not create a zero-contact-angle boundary condition at an
artificial moving edge. Both models retain a positive, periodic film.

## Discretization and acceptance

Cell-centred heights have exact planform area `W Δx`. Each periodic face owns
one shared flux. The old-state arithmetic face height determines positive
mobility, and the update is:

```text
p*ᵢ = -σ Dxx hⁿ⁺¹ᵢ - B/(hⁿ⁺¹ᵢ)⁶ + A/(hⁿᵢ)³
Mᵢ₊½ = [(hⁿᵢ+hⁿᵢ₊₁)/2]³ / (3 μ)
qᵢ₊½ = -Mᵢ₊½ (p*ᵢ₊₁-p*ᵢ)/Δx
hⁿ⁺¹ᵢ - hⁿᵢ = -Δt (qᵢ₊½-qᵢ₋½)/Δx
```

This is a first-order implicit convex split: surface energy and singular
repulsion are implicit; attraction is explicit. It adapts the methodology of
[Zhang, Wang, Wise and Zhang, section 3](https://arxiv.org/pdf/2012.11802).
That paper analyzes a different potential exponent and constant-mobility
scheme; this implementation does not claim to reproduce its theorem verbatim.
The present finite-volume energy inequality follows directly from convexity
and discrete summation by parts with positive, frozen face mobility:

```text
Eⁿ⁺¹ - Eⁿ ≤ Σᵢ p*ᵢ (hⁿ⁺¹ᵢ-hⁿᵢ) WΔx
          = -Δt D
D = Σfaces M [(p*ᵢ₊₁-p*ᵢ)/Δx]² WΔx ≥ 0
```

Newton iteration uses an analytical Jacobian and pivoted linear solve. A
positivity-preserving line search reduces the update; it never clamps or
renormalizes heights. Preallocated work arrays bound allocation. This CPU
reference deliberately supports only 8–256 cells; its dense matrix occupies
72 KiB at 96 cells and 512 KiB at 256 cells.

The entire candidate is rejected if it fails convergence, positivity,
geometry scope, Reynolds, volume or energy checks. Rejection leaves the
accepted profile and clock untouched. No hidden substep or consumed simulation
time occurs. Invalid inputs throw before mutation.

Default gates:

- Nonlinear residual `max|hⁿ⁺¹-hⁿ+Δt div q| / max(hⁿ)` ≤ `1e-10`.
- Cumulative volume deviation from the initial state ≤ `2e-10`.
- `ΔE+ΔtD` ≤ `2e-8` times the declared energy scale.
- `Re_film = ρ max|q| / μ` ≤ 1.

The energy inequality permits the known numerical dissipation of implicit
stepping. It is not a claim of exact energy conservation. The wetting binding
energy can be negative, so decreasing energy may become more negative.

The capillary force conjugate to vertical cell displacement is
`Fᵢ=-p_capillary,ᵢ WΔx`. Its sum vanishes on the periodic grid, and tests verify
both that cancellation and the derivative of the actual interface energy.
The wall's wetting interaction and viscous drag are external interactions;
this overdamped model does not claim conservation of free-fluid momentum.

## API and tested playground

```ts
import { CapillaryFilmSolver, DEFAULT_FILM_CONFIG } from "./solver";

const config = { ...DEFAULT_FILM_CONFIG };
const initial = Float64Array.from({ length: config.cells }, (_, i) => {
  const x = (i + 0.5) * config.lengthM / config.cells;
  return 8e-6 + 80e-6 * Math.exp(-Math.pow((x - 0.002) / 0.0008, 4));
});
const film = new CapillaryFilmSolver(config, initial);
const result = film.step(0.005);
if (!result.accepted) {
  // Pause and display result.reason; the accepted state has not changed.
}
const state = film.snapshot(); // Detached Float64 arrays, all SI.
```

Default domain: 4 mm × 1 mm, 96 cells, `σ=0.05 N/m`, `μ=0.01 Pa·s`,
`ρ=1060 kg/m³`, `h*=8 μm`, `θ=0.12 rad`, timestep 0.005 s.
The playground's **12 discrete configurations** are `σ={0.04,0.05,0.06}`
crossed with wetting off or `θ={0.08,0.12,0.16}`; other parameters and the
initial profile are fixed. All 12 ran for one physical second, 200 accepted
steps each. This evidence does not imply arbitrary parameter combinations
are validated.

At the default settings over one second:

| Quantity | Observed result |
| --- | --- |
| Peak height | 87.99996 → 78.97356 μm |
| Minimum final height | 8.076901 μm |
| Free energy | −2.947108e−10 → −3.785415e−10 J |
| Maximum Newton iterations | 3 |
| Maximum normalized nonlinear residual | 9.48818e−11 |
| Maximum relative volume error | 1.74635e−16 |
| Maximum film Reynolds number | 0.0143977 |

Across all 12 configurations, the maximum volume error was `5.76296e−15`,
maximum Reynolds number `0.0174378`, maximum Newton count 4, and maximum
normalized residual `9.84899e−11`.

## Independent tests and observed convergence

`solver.test.ts` contains 15 CPU tests. The physical references are derived
from continuum expressions, not the production Newton matrix.

| Check | Observed errors / result |
| --- | --- |
| Fourier leveling, `λ=σh₀³k⁴/(3μ)=1.29878788045 s⁻¹` | Relative rate error 0.0254069 / 0.00640698 / 0.00160522 at 16/32/64 cells: second-order spatial convergence |
| Fourier temporal decay over `λT=0.5` | Relative amplitude error 0.0153080 / 0.00787902 / 0.00407198 at 8/16/32 steps: first-order time convergence |
| Viscosity/tension scaling | Measured rate doubles for doubled σ and halves for doubled μ |
| Circular-ridge apex Laplace pressure | Radii 0.5/1/2 mm give 100/50/25 Pa (`σ/R`, one curvature); finest relative error 1.52585e−6 with second-order convergence |
| Wetting-ridge continuum pressure | 4.91267889114 Pa; relative RMS error 0.0782804 / 0.0202661 / 0.00513146 at 64/128/256 cells |
| Wetting-ridge maximum slope | Continuum 0.09286177293; finest relative error 8.92790e−5 |
| Evolved continuum wetting equilibrium | Relative profile error 3.59043e−4 / 8.78221e−5 / 2.18545e−5 at 64/128/256 cells after 0.2 s |
| Spinodal wetting instability | Independent growth `3.57256002089 s⁻¹`; amplitude errors 0.0225497 / 0.0116465 / 0.00586956 at 25/50/100 steps over 0.1 s |
| Volume, positivity, energy | All 2400 playground steps accepted, with stated bounds |
| Periodic seam/reflection | No preferred grid position or direction within `1e-10` relative profile error |
| Transaction failure | Iteration-limit and inertia-domain rejection preserve profile, time and energy |
| Input/output ownership | Invalid inputs rejected; mutating a snapshot does not mutate the solver |

The equilibrium oracle integrates the independent first integral
`σ h′²/2=φ(h)-φ(h_min)-p(h-h_min)`, choosing pressure from its two height
turning points. A `sin²` transformation removes the endpoint singularities
before 32,768-panel quadrature. The dynamic test starts from this continuum
profile, so any evolving deviation measures spatial/time discretization error.

The local Laplace test concerns a cylindrical-ridge apex, not a full
three-dimensional sphere. **Spherical `2σ/R` and Rayleigh–Lamb oscillations
remain unsupported and untested.** The overdamped model instead has independent
capillary relaxation and wetting-instability rate tests.

At 256 cells, timestep 0.005 s in the near-equilibrium reference encountered
Float64 cancellation in the stiff fourth-order residual and was correctly
rejected at approximately `1.95e−10`, above the unchanged `1e−10` gate.
The refinement test uses a common 0.001 s timestep at all three resolutions.
Implicit stability is not a guarantee of temporal accuracy or arbitrarily
small nonlinear residual at a chosen timestep and resolution.

Reproduce from `viscera/`:

```sh
node node_modules/vitest/vitest.mjs run apps/studio/src/blood/capillary/solver.test.ts
node node_modules/typescript/bin/tsc -p apps/studio/tsconfig.json --noEmit
```

The final 15-test run took 870 ms of test execution on the development Mac,
including assertions and reference generation. This is not a browser, mobile
or renderer performance benchmark.

## Browser, capture and visual evidence

The real-Chrome gate in `scripts/check_capillary_ui.mjs` passed on the development
Mac. [QA evidence](../../../../../artifacts/blood-capillary-2026-10-20/browser/qa.json)
records all 12 UI combinations, each actually run for approximately 1.895–1.9
physical seconds; maximum exported volume error was `5.44e-15`. Pause preserved
the complete exported profile. Keyboard camera changes altered the actual image
without advancing physics. The 375/768/1440px layouts, 200% text, real scrolling,
scene resize, full-screen round trip, workspace/reset recording guards and
workspace recreation passed, with zero recorded page errors, failed requests or
automated accessibility violations.

The development-only [renderer gate](../../../../../artifacts/blood-capillary-2026-10-20/browser/renderer.json)
passed 39 checks: invalid inputs, detached geometry, monotonic frame handling,
render-cadence independence, camera isolation, native dimensions, exclusive
capture ownership, resize during capture, abort, repeated restore and disposal.
Neither the application nor production bundle imports `renderBench.ts`.

Both recorded movies were decoded and checked with `ffprobe`:

| Actual recording | Encoded stream | Frames / duration | Observed average encoded rate |
| --- | --- | --- | --- |
| HD | H.264, 1280×720, native canvas, no upscale | 132 / 4.3923 s | 30.0654 FPS |
| 4K | H.264, 3840×2160, native canvas, no upscale | 135 / 4.698267 s | 28.7191 FPS |

The target was 30 FPS. These short measurements are not a sustained-device
performance guarantee. Capture metadata correctly leaves `encodedFps` unknown;
the rates above come from the encoded streams. Microphone audio was disabled
for these film checks.

Decoded HD and 4K frames show a continuous, shallow orange-red ridge with a
readable true-scale label and no visible mesh cracks in the inspected views.
The recorded frames change as the computed film evolves and the camera moves.
The smooth patch, simple substrate and approximate illumination still read as a
scientific rendering: **this evidence does not pass surgical photorealism**.
The film height has not been exaggerated to hide its limited physical scope.

Run the complete browser gate only when it has exclusive GPU ownership:

```sh
node scripts/check_capillary_ui.mjs
```

It uses the existing local Studio server at port 5174; it does not start or
restart a server. `BLOOD_BASE_URL` and `BLOOD_EVIDENCE` override the URL and output
directory. For a production candidate, set `CAPILLARY_CHECKS=ui`: the direct
renderer harness intentionally exists only in the development source graph.
Use a fresh evidence directory for each reviewed run.

## Integration boundary

The existing DFSPH scene/runtime/shaders are unchanged by this solver. Its
compression-only free-surface controls and uncalibrated cohesive coefficient
mapping would need separate validation before accepting physical capillarity.
[Jeske et al. (2023), section 3.1 and limitations](https://animation.rwth-aachen.de/media/papers/85/2023-TOG-SPH_Implicit_Surface_tension-compressed.pdf)
specifically distinguish their cohesion coefficient from the conventional
curvature-based coefficient, so assigning a measured σ directly would not be
justified.

A two-dimensional puddle model needs an independently validated 2D spatial
operator, a suitable sparse nonlinear solver, equilibrium-shape and spreading
tests, and its own cost measurements. Film/drop/vascular exchange additionally
needs one transactional volume ledger so that the same liquid is never counted
twice. Neither extension is implemented by this reference.
