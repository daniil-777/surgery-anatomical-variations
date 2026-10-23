# Conservative convected capillary breakup

`jetBreakup.ts` replaces the experiment's indefinitely smooth ballistic jet
display with an **authoritative reduced flight model**. It predicts a growing
axisymmetric capillary mode, then replaces a complete material wavelength by a
detached volume-equivalent sphere. The sphere owns its trajectory and impact;
its constituent emissions can no longer land independently.

This is an intermediate model between an unbroken ballistic tube and a resolved
free-surface solver. It is **not** nonlinear slender-jet CFD, a blood-specific
breakup law, or evidence of clinical/photographic realism.

## Primary theory and explicit assumptions

The full seven-page author manuscript of
[Driessen et al., *Stability of viscous long liquid filaments* (2013)](https://arxiv.org/pdf/1307.3139)
was read, including equations 1–5 and the numerical/discussion sections. It
describes viscous Rayleigh–Plateau growth, dependence on initial disturbance,
finite-filament contraction and end effects. Its own numerical model solves a
regularized slender-jet problem; this implementation does not reproduce that
solver. The publisher-hosted institutional PDF returned 403, so the author
manuscript is the inspected source.

For density ρ, viscosity μ, surface tension σ and source radius R:

```text
tcap = sqrt(ρ R³ / σ)
OhR = μ / sqrt(ρ σ R)
κ = k R
ω tcap = sqrt[½(κ² − κ⁴) + 9/4 OhR² κ⁴] − 3/2 OhR κ²
κmax = 1 / sqrt(2 + 3 sqrt(2) OhR)
λmax = 2πR / κmax
amplitude/R = ε exp(ω t)
tbreak = −log(ε) / ω
```

The positive growth root is rationalized in code to avoid cancellation at high
viscosity. Only the unstable band `0<κ<1` is treated. The inviscid *long-wave*
maximum is κ=1/√2 and ωtcap=1/(2√2); it is not the exact Bessel-function dispersion
of the full Rayleigh cylinder problem.
The independent 80-digit reference also solves the inviscid Bessel form from
[Pekker (2017), equation 2](https://arxiv.org/pdf/1712.07069) (introduction and
equations inspected). The exact maximum is κ≈0.697019 and ωtcap≈0.343339;
the long-wave maximum overestimates this growth by **2.9751%** even before
uncertainty in blood properties or disturbance amplitude is considered.

The source supplies actual `Q`, aperture `R`, and `u=Q/(πR²)` from the pressure
solver. The flight handoff verifies `V=πR²|u|Δt`; a renderer cannot substitute a
decorative jet speed. Within each accepted fixed step, flow is approximated as
constant. A parcel can span more than one instability wavelength, so its volume
is split at material-coordinate boundaries, with consistent subinterval birth
times. Splitting adds no mass and does not claim to recover unmeasured
within-step flow variation.

The current **engineering eligibility gates** require radius-based
`WeR=ρu²R/σ ≥ 4` and at least four emitted wavelengths. These reduce use of an
infinite, convected-cylinder approximation on very slow or short streams; neither
threshold is a universal experimentally established dripping transition.
Low-We flow is labelled `unresolved-dripping`, incomplete runs `short-ligament`,
and already intercepted material `intercepted`. Those cases retain conservative
ballistic ligaments rather than fabricating capillary droplets.

Initial relative disturbance ε=.01 is an exposed model assumption. It is
deterministic and not frame-random noise. Changing ε changes breakup time
logarithmically. The paper also discusses uncertainty in initial disturbance;
its use of a 1% value does not calibrate a punctured blood vessel.

σ=.055 N/m is an illustrative measured-scale input.
[Hrncír and Rosina (1997)](https://pubmed.ncbi.nlm.nih.gov/9728499/) report a
drop-method whole-blood measurement near .05589 N/m at 22°C, whereas the
[Rosina et al. (2007) abstract](https://pubmed.ncbi.nlm.nih.gov/17552890/) describes
a temperature-dependent ring-method regression from a different sample.
Only those abstracts were inspected for this parameter; it is not asserted to
be a calibrated value for blood at 37°C, a particular patient, or a contaminated
operative interface.

## Mass, topology and impacts

Material coordinates are cumulative accepted emitted volume per uninterrupted
aperture run. Occlusion, a zero-flow step, or an aperture change starts a new run.
One full capillary cohort has reference volume `πR²λmax`.

Before pinch, 17 points represent each contiguous live ligament. Their radial
profile follows the selected growing mode. The radii are normalized to the
accepted volume using the sum of circular-frustum volumes:

```text
V = Σ π length_i (r_i² + r_i r_(i+1) + r_(i+1)²) / 3
```

This normalization is a conservative geometry closure, **not** a local solution
of axial momentum/continuity. Linear growth extrapolated toward zero neck is an
estimate of pinch onset, not a resolved nonlinear neck solution. The renderer
may correct only polygonal discretization volume and must not introduce its own
disturbances, growth rates, or extra droplets.

An eligible complete cohort can pinch only before its first constituent impact.
At pinch, its volume is transferred once to a sphere of radius
`(3V/(4π))^(1/3)`. Its centre and velocity are the volume-weighted constituent
states at that event time, preserving volume and linear momentum. Replacement
removes internal velocity variance; this kinetic energy loss is reported as
`mergeKineticEnergyLostJ`. Surface-energy conversion, capillary recoil, transient
drop deformation and satellite drops are not resolved or included in that
energy tally.

The resulting drop then advances under gravity until its **finite-radius**
vertical support reaches the collection surface. A single continuous impact event transfers
its entire volume to the collector. It never shrinks because an underlying
legacy parcel crossed that plane. Unbroken portions continue to use the
midpoint point-contact ballistic impact approximation. Events are sorted by their
physical time and are returned only for the latest accepted fixed step.

The caller must use the external-flight vessel mode. Rendering both the old
parcels and new droplets would double-count liquid and is unsupported.

### Contact with accumulated collector blood

Optional `collectorSurface` in `JetBreakupExperiment.step` carries
`{timeSeconds,nx,nz,widthM,depthM,originXM,originZM,heightM}` from the **previous
accepted collector state**. Heights are cell-average depths above
`collectionPlaneYM`; the 20 µm prewet is included. The surface timestamp must
match the beginning of the flight interval. The input array is read only and
privately reconstructed once per step.

Collision uses the same clamped four-cell corner average and four-triangle
centre fan as the visible collector mesh, in binary64 before renderer
Float32 packing. It solves quadratic ballistic intersections with the triangle
planes and their projected edges. Testing only the interval endpoints would
miss a narrow hill crossed between two clear endpoints; edge/plane roots detect
that case continuously. Trajectory bounds include horizontal turning points,
and a height bound rejects material that cannot yet reach the film. At most
4096 candidate cells are allowed per trajectory; pathological traversals reject
the complete step rather than permitting unbounded work.

The graph is held fixed during this flight step: this is an explicit first-order
coupling with a one-step surface lag, not a simultaneous free-surface/contact
solve. Material already overtaken by an increased film height is absorbed at
the current interval start, never at a retroactive time. A lateral entry below
the film is absorbed at the domain edge. Event x/z and time are the continuous
entry values; event y denotes the receiving graph height, including for an
already submerged point. No extra radial splash impulse is introduced.

Detached spheres use a **vertical radius offset** over this graph; this is not
full sphere/triangle-edge contact on steep fronts. Unbroken portions remain
point contacts. All transferred mass belongs to the accepted portion or drop,
and a new pinch whose equivalent sphere already intersects the film is
transferred once at its pinch time. Outside the finite tray, contact uses the
base plane and the collector records escaped volume. Omitting `collectorSurface`
preserves the original fixed-plane behavior exactly.

This correction prevents accumulated film from being ignored. It does not
model impact spray, meniscus engulfment, finite droplet deformation, contact-line
wetting, or the back-pressure of a submerged puncture.

## Transaction and boundary contracts

```ts
const vessel = new VesselExperiment(vesselConfig, { externalFlight: true });
const flight = new JetBreakupExperiment(flightConfig);
// Root coordinator checkpoints both, steps vessel and flight once, prepares
// the collector, and commits/reconciles only if every participant accepts.
const emitted = vessel.step();
const state = flight.step({ timeSeconds: emitted.timeSeconds, emissions: emitted.emissions });
vessel.reconcileExternalFlight(state);
```

`checkpoint()/restore()` tokens are opaque and owned by their originating
instance. Invalid emissions, numerical/geometry failure, or capacity overflow
roll back the complete flight step. The root coordinator also restores vessel
and flight state when a collector preview fails.

Optional `externalPerfusion:true` accepts a fresh
`{sourcePressurePa,distalPressurePa,inletVolumeLimitM3,distalVolumeLimitM3}`
for each fixed step.
It records actual boundary pressures and signed cumulative net transfers;
it does not consume the unrelated 20 mL laboratory reservoir. Its local ledger
is `initial local + external supplied = current local + distal returned + expelled`.
The return is a transfer back to circulation, not an extra stored blood volume.
External ports are reversible resistive connections:
`Qin=(Psource−Plocal)/Rin`, `Qdistal=(Plocal−Pdistal)/Rout`.
Positive inlet and negative distal flow are bounded by the corresponding
external donor inventory. Negative inlet, positive distal and puncture outflow
share the available local volume above its minimum; the same proportional
limiter applies if that local inventory is exhausted. The coupled circulation
must additionally bound combined withdrawals when both ports refer to the same
compartment. The finite-reservoir laboratory mode retains its original
one-way reservoir contract. Wall compliance is lumped; wave propagation,
resolved entrance inertia, FSI and venous collapse are not thereby solved.

## Validation gates and remaining work

Unit tests independently check the growth polynomial, analytic inviscid limit,
stationary maximum, viscosity/surface-tension/radius scaling, disturbance
sensitivity, exact geometry volume, retained detached-drop mass, timed impacts,
mass/momentum replacement, low-We/short/zero-instability fallback, duplicate or
invalid source rejection, capacity rollback, checkpoint ownership, unchanged
pressure/discharge under external flight, and external RC/perfusion balance.
Height-field tests additionally check raised-flat analytic timing, sloped
intersections, within-step hill crossings, tray-edge entry, rising-surface
engulfment, fresh-pinch contact, exact single mass transfer, immutable inputs and
transaction rollback.

These are equation/implementation gates. They do not validate the closure's
breakup length or drop-size distribution against blood recordings. Next physical
validation requires measured nozzle/puncture geometry, initial disturbance,
surface tension, flow waveform, calibrated high-speed video, and comparison of
breakup length/time, diameter distribution and collected mass. A nonlinear
slender-jet or resolved interface solver is needed to test pinch shape, end
contraction, satellite drops and strong axial stretching rather than extending
this closure beyond its stated range.
