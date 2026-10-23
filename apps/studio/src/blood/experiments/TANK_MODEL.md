# Hydrostatic tank experiment

This is an isolated CPU reduced model, not the existing DFSPH implementation. It
simulates conservative long-wave motion and reciprocal interaction with **one
vertically guided, spatially regularized sphere or cube**. A cubic enclosure
does not imply a deep fill: the shipped enclosure is 150 mm per side, with a
12 mm liquid fill. The solver and renderer use SI metres and actual surface
height; they do not scale waves for appearance.

It cannot resolve the impact pressure, vertical added mass, sharp-body boundary
layers, overturning surfaces, air entrainment, spray, rotation, horizontal body
motion, tissue wetting or shear thinning. Its small-amplitude guards restrict
excursions but do not establish the validity of the hydrostatic approximation
at every wavelength. In particular, motion near the entering body is
regularized and should not be compared with a resolved 3D impact experiment.

## Model and units

For a cell of area \(A_c=\Delta x\Delta z\), define:

- \(w_i\): actual conserved liquid volume divided by cell area, m.
- \(H_i\): free-surface height above the floor, m.
- \(q_f\): horizontal depth-integrated discharge at internal faces, m²/s.
- \(y,v,m\): body-centre height, vertical velocity and mass, m, m/s and kg.
- \(W_i\): a compact, normalized spatial weight, m⁻², with
  \(\sum_i A_c W_i=1\).
- \(V(d)\): exact geometric body volume below a plane \(d\) above its centre,
  m³; \(M(d)\): the corresponding first vertical moment about the centre, m⁴.

Each surface height is found from the monotone local volume relation

\[
w_i=H_i-W_i V(H_i-y).
\]

The weight is proportional to \((1-r^2/R_c^2)^3_+\), sampled at cell centres and
normalized using actual cell area. Its support radius is
\(R_c=\max(5a,3\max(\Delta x,\Delta z))\), where \(a\) is sphere radius or cube
half-side. Its waterplane occupancy is constrained below 0.45, so
\(\partial w/\partial H=1-W V'>0.55\). This is an explicit distributed coupling
approximation: the drawn object's sharp silhouette is **not** the fluid
exclusion boundary.

Closed-wall evolution is

\[
\dot w=-\operatorname{div}q,\quad
\dot q=-gH_0\nabla H-\gamma q,\quad
\gamma=\frac{3\mu}{\rho H_0^2},
\]

\[
\dot y=v,\qquad
m\dot v=-mg+\rho g\sum_i A_c W_i V(H_i-y).
\]

Here \(H_0\) is reference fill depth, \(\rho\) is density in kg/m³ and \(\mu\)
is constant Newtonian dynamic viscosity in Pa·s. The damping coefficient is the
laminar parabolic-profile bottom-friction closure with a no-slip bottom and
stress-free top. It is not a calibrated high-Reynolds-number drag law, and it
does not model the transient vertical viscous profile. Constant reference-depth
inertia omits nonlinear advection.

Sphere volume/moment use exact spherical-cap integrals; cube integrals are
exact truncated prisms. In a spatially uniform surface, integrating the
normalized weights recovers ordinary Archimedean buoyancy.

## Reciprocal energy and volume

The potential and kinetic energy of the reduced system are

\[
E=\rho g\sum_i A_c\left[
\frac{H_i^2}{2}-W_i\{yV(H_i-y)+M(H_i-y)\}\right]
+\frac{\rho A_c}{2H_0}\sum_f q_f^2
+mgy+\frac12mv^2.
\]

At fixed \(w\), differentiating the fluid potential with respect to body
height gives \(-\rho g\sum A_cWV\). At fixed body height, its derivative with
respect to each \(w_i\) is \(\rho g A_cH_i\). Thus the wave pressure and body
buoyancy come from the same energy; neither is a separately prescribed
animation. Internal face contributions telescope, giving exact semi-discrete
water-volume conservation and

\[
\dot E=-D,\qquad
D=\frac{\rho A_c\gamma}{H_0}\sum_f q_f^2\ge0.
\]

The fixed-step RK4 integrator also integrates \(D\). A body-floor collision is
located within the step by bisection and treated as perfectly inelastic; its
lost mechanical energy is added separately to the ledger. A sufficiently
buoyant body can subsequently lift off. This simple contact law is not a
material-dependent collision model.

Drop insertion is explicit external work and resets the energy reference while
retaining accumulated dissipation. It does not change water volume. Only one
body can be present; repeat trials require resetting the experiment.

Before committing a candidate:

- nonlinear column-volume residual must be ≤\(10^{-11}\) m;
- relative cumulative water-volume error must be ≤\(10^{-10}\);
- cumulative \(|E+D_\mathrm{integrated}+E_\mathrm{contact}-E_\mathrm{reference}|\)
  must be ≤\(2\times10^{-4}\) of the characteristic dynamic energy;
- surface excursion/reference depth must be ≤0.25, discrete surface slope
  ≤0.3, and a conservative horizontal Froude bound ≤0.3;
- no drying, overflow, non-finite state or negative contact loss is accepted.

The dynamic energy scale is the larger of the initial standing-wave energy
scale and \(mg(2a+h_\mathrm{drop})\), with a \(10^{-12}\) J floor. It does not
use the large constant potential energy of the undisturbed tank to conceal
integration errors. Rejection preserves the exact previous accepted state and
time. Guards do not clip velocities, heights or water volume.

## Validation, 20 October 2026

The final 11-test run passed in 25.79 s of CPU test execution. Tests include
independent sphere/prism geometry, the continuum standing-wave frequency,
second-order spatial convergence, independently evaluated damped-oscillator
decay, exact dry free fall, coupled entry/contact temporal refinement, detached
exports, rejection rollback and the complete shipped control matrix.

The matrix tested 54 combinations for two physical seconds each:

- sphere radius 4 mm / cube edge 8 mm;
- body density 500, 750, 1,000 kg/m³;
- initial bottom clearance 0.25, 0.5, 1 mm;
- viscosity 3.45, 10, 30 mPa·s;
- 32×32 cells and a fixed 1 ms step.

Three additional standing-wave runs, one per viscosity, ran for five seconds
with 0.5 mm initial cosine amplitude. All 123,000 steps were accepted:

| Measurement | Maximum |
| --- | ---: |
| Cumulative relative energy-balance error | \(1.92358\times10^{-5}\) |
| Cumulative relative water-volume error | \(1.06582\times10^{-14}\) |
| Nonlinear column-volume residual | \(1.73473\times10^{-18}\) m |
| Discrete surface slope | 0.089694 |
| Conservative horizontal Froude bound | 0.083452 |

A separate twelve-case exploratory run covered sphere/cube, densities
500/750/1,200 kg/m³ and drop heights 0/1 mm for five seconds each at 24×24
cells. All 60,000 steps passed; maximum energy-balance error was
\(1.03042\times10^{-5}\) and volume error \(5.0\times10^{-15}\).
These are tested durations and finite parameter sets, not guarantees for
arbitrarily long simulation or arbitrary settings.

At 80 ms, coupled sphere position for fixed steps
2/1/0.5/0.25 ms was respectively
0.004213603799/0.004213608586/0.004213608672/0.004213608679 m.
The test includes an inelastic floor contact. The energy-rejection fixture
uses a very light cube and a 2 ms step; it intentionally fails the energy guard
and verifies byte-for-byte preservation of the accepted state.

Reproduce from `viscera/`:

```sh
node node_modules/vitest/vitest.mjs run \
  apps/studio/src/blood/experiments/tankSolver.test.ts --reporter=verbose
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
```

The measured envelope execution was approximately 24 s CPU wall time for
123,000 steps, including snapshot copies and diagnostic reductions. This is
not a formal performance benchmark and excludes browser rendering. UI batches
must retain a bounded CPU budget and allow physical time to advance more
slowly when the device cannot keep up.

## Research basis and distinction from published methods

[Brutto and Dumbser (2023)](https://onlinelibrary.wiley.com/doi/full/10.1002/fld.5143)
describe hydrostatic fluid/structure coupling through nonlinear volume
functions and conservative fluid equations. This implementation uses that
physical idea but has a different, explicitly regularized volume function and
linear horizontal inertia; it is not a reproduction of their six-degree
solver.

[Godlewski et al. (2020)](https://www.numdam.org/articles/10.5802/smai-jcm.67/)
emphasize energy transfer in shallow-water/floating-body coupling. The
reciprocal potential and discrete flux argument above are the derivation for
this particular reduced implementation.

[Chentanez and Müller (2010)](https://matthias-research.github.io/pages/publications/hfFluid.pdf)
combine a heightfield with separate particles for phenomena that cannot be
represented as a single-valued surface. Their hybrid method helps identify
the scope limitation here: this module implements neither their splash
particle exchange nor their visual stabilization/clamping heuristics.

No real-blood impact experiment, surgical footage or measured contact
trajectory has calibrated this model. Passing the numerical tests establishes
the listed reduced-model properties, not surgical visual realism.
