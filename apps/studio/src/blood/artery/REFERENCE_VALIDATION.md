# Independent artery solver references

The JSON fixtures are numerical oracles for a straight, circular, rigid tube. The
radius, heart rate, and pressure-gradient waveform are synthetic verification
inputs. They are not patient measurements or a validated physiological preset.
The viscosity and density agree with the [Weddell et al. 2015 constitutive
parameters](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0124575).
The Newtonian pulsatile solution follows [Womersley 1955, equation 9](https://doi.org/10.1113/jphysiol.1955.sp005276);
that equation was checked directly on page 554 of the
[original paper scan](https://pdodds.w3.uvm.edu/files/papers/others/1955/womersley1955a.pdf).

Regenerate from the repository root:

```sh
.venv/bin/python scripts/generate_artery_references.py
.venv/bin/python scripts/generate_artery_references.py --check
```

The generator uses 80-decimal-digit mpmath evaluation and stores 45-digit strings
alongside normal JSON numbers. The application solver is never imported. It
checks the Womersley solution against radial quadrature, the local differential
equation, integrated momentum, no slip, and independent SciPy Bessel evaluation.
For steady Carreau–Yasuda flow, it uses constitutive inversion and quadrature in
shear-rate space, then independently checks against SciPy inversion/integration
in physical radius.

## Phase and traction conventions

The driving gradient is positive downstream:
`G(t) = -dp/dz = 300 + 200 cos(omega*t)` Pa/m.
Every harmonic response uses `Re(hatValue * exp(i*omega*t))`.
Thus the real part is the cosine coefficient and the **negative imaginary part**
is the sine coefficient. A negative complex argument means a response lag.

`wallTractionOnSolid` means the signed axial traction exerted by fluid on the
solid wall: `-mu * du/dr` at the physical radius. The traction exerted by the
solid on the fluid has the opposite sign. Do not take the absolute value before
checking momentum balance or harmonic phase.

For `R = 0.003 m`, `rho = 1060 kg/m³`, `mu = 0.00345 Pa·s`, and 72 bpm:

| Quantity | Reference |
| --- | ---: |
| Period | 0.8333333333333333 s |
| Womersley number | 4.566097670992281 |
| Mean flow | 2.765967445008405e-6 m³/s |
| Complex harmonic flow | (1.846267963940718e-7 − 4.873742225427222e-7 i) m³/s |
| Flow harmonic phase | −1.2086813787746735 rad |
| Mean fluid-on-wall axial traction | 0.45 Pa |
| Weddell Carreau–Yasuda steady flow at G = 300 Pa/m | 2.102134673690784e-6 m³/s |

## Recommended convergence checks

These are verification procedures derived for this implementation, not acceptance
thresholds specified by the papers.

1. **Boundary/steady balance.** With constant viscosity and constant positive
   gradient, converge to the Poiseuille profile, `Q = pi*G*R^4/(8*mu)` and
   `tauWall = G*R/2`. Keep the physical wall at the configured radius; do not
   adjust the radius to fit a cell-centred discretization. Verify zero velocity
   at the wall and zero radial derivative at the centre. Compare negative
   gradients too, with signed velocity, flow, and traction.
2. **Pulsatile amplitude and phase.** Compare a complete periodic cycle to
   `womersley-reference.json`. Either initialize the numerical field with the
   analytical periodic solution or settle startup transients. The slowest
   Newtonian transient decay time here is approximately 0.478148 s. Starting
   from rest, use repeated cycles until successive-cycle changes are below the
   intended discretization error; eight cycles reduce this slow mode by roughly
   9e-7. Do not compare the first cycle from rest to periodic steady state.
3. **Extract complex coefficients correctly.** For uniformly sampled completed
   cycles, use `2/N * sum((sample - sampleMean) * exp(-i*theta))`. Use N distinct
   phases without duplicating both zero and one full period. Compare both
   complex relative error and phase. Comparing only peak speed misses a wrong
   inertia term or phase convention.
4. **Temporal convergence.** At fixed sufficiently fine radial resolution, try
   `dt = T/128, T/256, T/512`. Compare complex flow, velocity, and wall-traction
   errors. Backward Euler should approach first-order temporal convergence.
   Confirm the spatial error floor is smaller before interpreting ratios; do
   not impose second-order expectations on a first-order time integrator.
5. **Spatial convergence.** Compare 32, 64, and 128 radial cells with a much
   smaller fixed timestep, or use converged steady Carreau–Yasuda flow to remove
   temporal error. Compare Q, sampled velocity, and wall traction separately.
   A nominal second-order interior stencil does not guarantee second-order wall
   traction if its wall gradient is only first-order. Report measured order.
6. **Coordinate-aware comparison.** A finite-volume unknown may be a point value
   at a cell centre or an annular average. Compare with the corresponding exact
   quantity, integrating the analytical profile over each annulus for averages.
   Include radial measure `2*pi*r dr` when forming velocity L2 errors or flow.
   Do not use an unweighted arithmetic average as the mean tube velocity.
7. **Nonlinear rheology.** A Womersley comparison validates constant-viscosity
   behavior only. Check the steady CY oracle separately, nonlinear convergence
   at every step, `muInf <= mu <= mu0`, dissipation, and the Newtonian limit
   `mu0 = muInf`. With CY, the radial PDE must use
   `(1/r)*d/dr(r*mu(abs(du/dr))*du/dr)`, including spatial viscosity variation.
8. **Integrated momentum and energy.** Evaluate
   `rho*dQ/dt = pi*R²*G - 2*pi*R*tauWall` and the analogous discrete finite-volume
   balance. For rigid, fully developed flow, pressure power per unit length is
   `G*Q`; viscous dissipation is `2*pi*integral(mu*(du/dr)^2*r dr)` and cannot be
   negative. Turning off the gradient should dissipate kinetic energy.

Use mesh/time refinements to choose tolerances before treating a failing case as
acceptable. Preserve raw error tables and distinguish numerical accuracy from
physical-model adequacy.

## Physical scope to display in the UI

A radial fully developed model resolves axial velocity variation across one
straight rigid vessel. It does not resolve bends, bifurcations, stenoses,
secondary flow, entrance development, turbulent jets, moving walls, or external
bleeding. Pressure-gradient input determines flow; do not independently prescribe
inconsistent pressure and flow waveforms. Length changes total pressure drop
`DeltaP = G*L`; it does not independently change a fully developed solution when
G is held fixed.

Carreau–Yasuda is an instantaneous generalized-Newtonian viscosity model. It does
not represent cell-resolved motion, aggregation history, coagulation, or
viscoelastic memory. The published tuple is a computational material reference,
not a donor-specific calibration. A red-cell or tracer visualization should be
labelled as visual flow markers unless particle transport is separately modeled.

For a later vascular network, pressure/flow boundary conditions and wall mechanics
need their own model and validation. The [SimVascular documentation](https://simvascular.github.io/documentation/rom_simulation.html)
provides network boundary-condition and wall-property mechanisms; these are not
present merely because a single-tube solver runs. Cutting an organ additionally
requires coupling the vascular supply to exterior fluid with a conserved volume
ledger. No result in these fixtures validates surgical cutting or clinical use.
