# Punctured-vessel perfusion experiment

This module provides a conservative **lumped chamber and ballistic-jet
reference**. It is not a resolved model of blood flowing along a curved artery
or vein. Its purpose is to make puncture discharge depend on pressure,
viscosity, aperture geometry, gravity and finite available volume, while keeping
every transfer auditable. It does not claim surgical or patient-specific accuracy.

Implementation: [vesselSolver.ts](vesselSolver.ts).
Numerical checks: [vesselSolver.test.ts](vesselSolver.test.ts).

## API and units

```ts
const config = createVesselPreset("artery", {
  innerRadiusM: 0.003,
  lengthM: 0.06,
  viscosityPaS: 0.0035,
});
const experiment = new VesselExperiment(config);
experiment.setHoles([{
  id: "site-1",
  positionM: [0, 0.03, 0.0036],
  direction: [0, 0, 1],
  radiusM: 0.0004,
  wallLengthM: 0.0006,
  dischargeCoefficient: 0.62,
}]);
const accepted = experiment.step(8); // eight fixed 2 ms steps
```

All lengths, volumes, time, pressure, density and viscosity are SI. Pressures
are gauge pressures relative to the external environment, set to zero.
Coordinates are right-handed with positive Y upward. The default collector is
the infinite plane `y=0`, and chamber pressure is referenced at `(0,0.03,0) m`.
The UI overrides that reference with the actual curved centreline midpoint.
Renderer geometry maps the chosen aperture site to an outer-wall position and
outward direction; the solver normalizes that direction.

`step(count)` returns a `VesselSnapshot`. It throws on invalid arguments,
numerical invariant failure or parcel-capacity exhaustion; the entire requested
batch rolls back. `setHoles()` validates the whole list before committing. It
keeps time, inventory, in-flight parcels and cumulative per-hole discharge
history when a hole is removed or occluded. `reset()` restores initial inventory
and removes all holes and transfer history.

The current experiment supports zero to three holes, radii 0.05–1.5 mm, further
limited to half the lumen radius. These are computational bounds, not medical
recommendations. Discharge coefficients must be 0.05–1. The default 0.62 is an
illustrative empirical orifice coefficient, not a measured puncture value.

## Chamber and boundary conditions

One compliant storage compartment has

```text
P(V) = P_initial + (V − V_initial) / C
dV/dt = Q_in − Q_distal − Σ Q_hole
```

The finite perfusion reservoir supplies
`Q_in = max(P_source − P,0)/R_in`, capped by available supply per timestep.
The distal collection boundary accepts `Q_distal = max(P − P_distal,0)/R_out`.
These one-way boundaries describe a **bench perfusion circuit**, not anatomical
valves or arbitrary reverse flow in an artery. Either boundary can be closed.
The initial supplied volume is finite; no source volume is manufactured when
it empties.

[Hughes and Parker (2020), equations 1–4 and 10–11](https://pmc.ncbi.nlm.nih.gov/articles/PMC7705641/)
derive conservation/compliance relations and exponential pressure relaxation.
Their discussion also identifies the limitation of treating pressure as uniform
instead of resolving travelling waves. We use those basic balance equations;
we do not implement their modified wave-reservoir model or identify its
parameters from patient data. Relevant derivation and limitation sections were
read in full text.

The artery preset specifies a periodic, piecewise-linear **pressure** boundary,
with an exactly subtracted cycle mean and declared peak-to-trough pressure.
Its points give a rapid rise followed by relaxation and a small notch-like
feature. This shape is an illustrative input, not an acquired waveform or a
learned model. The vein preset uses a steady lower source pressure and larger
compliance. No sine wave or animation multiplier is applied to the discharge.
Mean-pressure, geometry and resistance overrides recalculate initial equilibrium
pressure and geometric inventory unless the initial values are explicitly
overridden. The initial pressure is the equilibrium at the **mean** boundary,
so a pulsed experiment may have a physical startup transient.

The chamber has a configured minimum volume. Reaching that boundary scales
outgoing transfers to the actual available volume and reports
`inventoryLimited=true`. This is an operating limit, not a vessel-collapse
law. Negative transmural pressures, axial pressure gradients, vein collapse,
wave propagation, deformable vessel walls and patient-specific compliance
require a different model. A fixed cylinder in the scene supplies geometric
context; it must not be presented as a solved compliant lumen shape.

## Circular puncture loss and gravity

For aperture radius `a`, wall-channel length `l`, Newtonian viscosity `μ`,
density `ρ`, empirical discharge coefficient `Cd`, and geometric area `A`:

```text
A = π a²
R_visc = 3 μ/a³ + 8 μ l/(π a⁴)
K = ρ/(2 Cd² A²)
ΔP = P + ρ g · (x_hole − x_pressure_reference)

ΔP = R_visc Q + K Q²          for ΔP > 0
Q = 0                        for ΔP ≤ 0
Q = 2 ΔP / [R_visc + hypot(R_visc, 2 sqrt(K) sqrt(ΔP))]
u_aperture = Q/A
```

The gravity term is signed: a lower opening gains hydrostatic pressure; an
opening above the reference loses it. A negative total pressure does not become
a positive leak. Ambient-liquid ingress, air entrainment and negative-pressure
collapse are not modeled.

[Hadjaje et al. (2025), equations 2–4](https://link.springer.com/article/10.1140/epjp/s13360-025-06658-6)
give the combined Sampson access and Poiseuille resistance, and investigate
inertial corrections using water/oil experiments and numerical pore flow.
Their full methods and analysis were read. Their results are **not blood
puncture validation**: in particular, they distinguish the low-Re correction
from the higher-Re quadratic pressure loss. Our `RQ+KQ²` blend preserves the
limiting resistance and an empirical inertial asymptote; it does not reproduce
every intermediate-Re correction or their particular fitted geometry.

The [US Bureau of Reclamation orifice derivation](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap09_05.html)
distinguishes contraction and velocity contributions to discharge. Its manual
was consulted for that distinction, not for a blood coefficient. `Cd` alone
cannot determine vena-contracta area and local maximum velocity separately;
the displayed speed is therefore the unambiguous area average `Q/A`.

The viscosity is a chosen effective Newtonian value. The module does not
resolve shear-dependent rheology, erythrocytes, aggregation, coagulation, tissue
recoil, irregular cracks, surface-tension menisci or clogging. It exports
aperture Reynolds number `ρ u (2a)/μ` using **diameter**, and null when `μ=0`
in analytical-limit tests. A user must not interpret it as a turbulence
validation or a guarantee that the loss model is accurate.

## Integration, inventory and downstream motion

Backward Euler solves the scalar volume balance at the next fixed time. The
residual is monotone: increasing volume increases chamber pressure and outgoing
flow, while decreasing inlet flow. A bracketed 56-iteration bisection finds
the root. The inlet cannot exceed finite supply. If the root would cross the
minimum chamber volume, outgoing transfers are proportionally limited. Final
transfers debit a shared nonnegative budget, including floating-point rounding
at exhaustion.

The reported closed volume ledger is

```text
initial supply + initial chamber
  = remaining supply + chamber + distal collected + in flight + landed
expelled = in flight + landed
```

Every positive accepted `Q_hole Δt` creates one **volume packet**, emitted at
the step midpoint with velocity `(Q_hole/A) × outward_direction`. A packet is
an integration sample of the jet, not a simulated breakup droplet. Its motion is

```text
x(age) = x_emit + v_emit age + ½ g age²
v(age) = v_emit + g age
```

The first intersection with the horizontal collector is solved analytically.
On arrival, the same packet volume moves into the landed ledger; it is not
silently removed. There is no artificial jitter, arbitrary droplet count,
sinusoidal jet path, restitution, spray, splash, coagulation or landing-pool
dynamics. Fluid interaction, drag, capillary breakup and collision with the
vessel itself are absent. A downward or oblique trajectory can therefore require
future collision handling in complex geometry. Renderer interpolation between
accepted packets is a display reconstruction, not additional fluid dynamics.

The new packet has age `Δt/2` at the accepted step endpoint. This represents a
finite emission interval with midpoint timing, not an instantaneous
zero-duration jet segment: the emission-time resolution is `±Δt/2` and the
discharge integration is first-order backward Euler. Collection is reported at
the first fixed-step boundary at or after the exact packet-centre landing event,
so that reporting delay is less than `Δt`. These time approximations do not
change packet volume. The unit tests independently check the initial age,
trajectory, accepted `QΔt` and first containing landing boundary.

Default runs stop at 30 simulated seconds. A stopped frame can legitimately
contain in-flight inventory; it is still accounted for. The bounded parcel
capacity fails atomically rather than deleting old fluid. Rendering cadence
can batch fixed steps but must not change `fixedDtSeconds`, invent parcels,
advance an unaccepted state or hide an integration error.

## Numerical acceptance checks

The implementation passes **20 focused numerical tests**, plus one
567-configuration operating-envelope test:

| Gate | Independent expectation / tolerance |
| --- | --- |
| Pure viscous and inertial discharge | Analytic `ΔP/R` and `sqrt(ΔP/K)`, relative error ≤`1e−12` |
| Mixed discharge | Known forward balance `17×3 + 11×3² = 150` |
| Aperture sensitivity | Inviscid radius doubling gives 4× flow; low-Re access limit gives 8×, relative error ≤`1e−8` |
| Isolated RC relaxation | Backward-Euler recurrence, relative error ≤`2e−11`; timestep halving gives error reduction >1.9 toward `P0 exp(−t/RC)` |
| Pressure coupling | Puncture reduces chamber pressure; increasing aperture increases expelled volume |
| Signed gravity | Lower zero-pressure opening leaks; upper opening is suppressed |
| Full inventory ledger | Three punctures over 2 s, absolute error <`1e−17 m³`; expelled agrees with airborne + landed |
| Depletion | Finite supply and chamber do not create extra discharge; collection retains the emitted inventory |
| Batch scheduling | 120 steps equal fifteen batches of eight, including parcel state |
| Occlusion | Removing a hole stops new emission while old packets land and history remains |
| Failure handling | Capacity and invalid-edit errors preserve the prior accepted state |
| Ballistic reference | Exact projectile location, energy and floor intersection |

The [operating-envelope artifact](../../../../../artifacts/blood-experiments-2026-10-20/vessel-ui-envelope.json)
records every UI combination of arterial mean source pressure **60–140 mmHg
in 5 mmHg increments**, venous mean **5/10/15/20 mmHg**, viscosity
**0.00345/0.01/0.03 Pa·s**, aperture radius **0.2/0.4/0.6 mm**, and
**one/two/three holes**. Each run covers two simulated seconds at `Δt=2 ms`;
statistics are sampled every 16 ms. It uses the shared curved geometry and
actual site-normal mapping. The curve length is **61.3185 mm**, also used for
initial chamber inventory; an unrelated nominal 80 mm volume would be
inconsistent with this scene.

All **567** combinations passed finite-state, nonnegative-inventory,
volume-ledger and flight/collection accounting gates. The maximum observed
diameter-based Reynolds number was **1149.96**, sampled aperture speed
**3.3382 m/s**, and absolute total-volume error **5.49e−19 m³**. The Reynolds
number does **not** validate a blood puncture, turbulent transition, or the
empirical `Cd`: the reference law remains an approximation even in a
numerically stable run. The source waveform and compliance are illustrative.
For the UI's downward site directions, the infinite-speed straight-line floor
intercept bounds every finite-speed gravity trajectory. That independent bound
lies inside the displayed 160 × 200 mm collection footprint at all three sites.
The solver itself still treats collection as an infinite plane.

The artifact stores solver, geometry, UI and test source digests. A later
geometry, control-range or equation change requires revalidation. The envelope
checks numerical behavior over two seconds; it does not establish long-duration
clinical behavior or three-dimensional flow accuracy.

Run from `viscera`:

```sh
node node_modules/vitest/vitest.mjs run apps/studio/src/blood/experiments/vesselSolver.test.ts
VISCERA_WRITE_VESSEL_ENVELOPE=1 node node_modules/vitest/vitest.mjs run apps/studio/src/blood/experiments/vesselEnvelope.test.ts
```

These tests establish the declared reduced model's numerical behavior.
Validation against measured perforated-tube pressure/discharge, high-speed jet
video, independently measured aperture geometry and uncertainty in `Cd`, `μ`
and compliance is still required. Neither mathematical conservation nor an
attractive rendering establishes equivalence to a surgical bleeding event.
