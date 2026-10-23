# Arteries and bleeding from a cut: evidence and implementation boundary

Date: 2026-10-20. This document records engineering decisions, not medical
validation. The existing UI does not yet simulate either anatomical scenario.

## What the current experiments mean

Passing a periodic shear test exercises velocity diffusion and the runtime;
it does not establish no-slip wall traction, a correct lumen radius, pulsatility,
perfusion, or blood loss. A fixed tray is a useful next boundary fixture, but
it does not have a vascular pressure source. A red surface alone supplies none
of these physical conditions.

The initial vortex trial exhausted its 16 pressure iterations at step 56. A
64-slot trial completed 400 steps at unchanged tolerances. Tray experiments
also exposed a spatial range-storage risk and post-advection density failures.
Failed observations are retained; reducing the timestep is evaluated rather than
silently loosening the 1% density guard.

## Filled arteries

Use a filled single-phase flow model as the primary vascular reference, with
explicit inlet waveform, outlet resistance/compliance, a pressure reference and
declared rigid/compliant wall mechanics. The
[SimVascular boundary-condition documentation](https://simvascular.github.io/documentation/multi_physics.html)
provides an appropriate native-reference interface; its
[reduced-order model documentation](https://simvascular.github.io/documentation/rom_simulation.html)
describes network boundary conditions and validation examples.

Proposed browser/native division (engineering inference): validate straight and
pulsatile tubes against a native solver, then use a validated reduced model for
network supply. A local free-surface region handles blood leaving a cut. Do not
force the vascular solver into DFSPH's particle layout. Exchange section flux in
m³/s, pressure in Pa, wall shear in Pa, geometry versions and accepted timestamps.
The existing `VascularObservables` type establishes only this data boundary.

Before integrating organ meshes:

1. Test steady Poiseuille/CY flow using the **internal bore radius**, with flow,
   velocity profile and independently evaluated wall traction at three spatial
   resolutions. Do not fit an effective radius to conceal wall error.
2. Test pulsatile straight-tube amplitude and phase, then outlet impedance and
   multi-branch conservation. A visually moving red column is not this test.
3. Only then evaluate curvature, bifurcation and compliant-wall coupling, with
   measured or justified inlet/outlet data. Do not infer patient-specific values
   from a generic anatomical mesh.

## Cutting an anatomical surface

A cut must update the actual tissue boundary and identify intersected vessel or
perfusion sources. A surface triangle's area alone cannot determine blood supply.
The source region needs pressure, available volume, perfusion/vascular topology
and a valid connection to the exterior fluid domain.

Proposed accepted-step coupling contract:

- A cut event carries an immutable mesh version, source compartment, cut-face
  geometry, normal and assigned accepted step.
- The vascular model proposes a flux/traction for the local exterior solve.
  The exterior solve returns interface pressure/traction and transferred volume.
- Candidate transfers are accounted on both sides of one ledger:
  vascular loss = exterior gain + explicitly collected/removed volume.
  Unused fractions of a particle's volume remain in a reservoir accumulator.
- Rejecting either side preserves both accepted states and the unconsumed cut
  event. No continuously firing emitter creates mass without debiting a source.
- Open-surface flow, cut-surface motion, suction and compression must be tested
  independently before combined operation.

This is a proposed interface, not a functioning surgical cut feature.

## Free surfaces, wetting and blood rheology

[Blank, Nair and Pöschel (JFM 2024)](https://arxiv.org/html/2311.09640v1)
addresses truncated kernel support, curvature and contact-line errors in 3D
free-surface SPH. Its validation cases are a useful next reference. The method
cannot be reduced to adding an attractive force or a friction slider: pressure,
surface normals, support correction and wetting conditions must remain consistent.

[Unified Pressure, Surface Tension and Friction (TOG 2024)](https://cg.informatik.uni-freiburg.de/publications/2024_TOG_unifiedPressureSurfaceTensionFriction_v3.pdf)
was subsequently downloaded from the authors because it exceeds the web
extractor's size limit. Sections 3–4 and 7 were inspected. Its interface-energy
formulation and simultaneous implicit solve are a stronger candidate than adding
unrelated attraction and friction forces after pressure projection. It requires
distinguishing fluid–boundary, fluid–vapour and boundary–vapour interfaces.
The paper's pressure model is an IISPH variant, so it is not a drop-in DFSPH shader.
Its larger surface-tension neighbourhood and small collision timesteps are
material costs; the complex examples in Table 5 take hours per simulated second,
even with an RTX 4090. This is a potential accuracy reference, not evidence of a
browser real-time solution. Its equations have **not** been implemented here.

[Sun and Liu (2024)](https://onlinelibrary.wiley.com/doi/10.1002/rcs.2663)
reports a blood-accumulation SPH boundary treatment and liver/vessel examples.
The available page provides an abstract and references, not enough reproducible
details to replace the baseline; it also states that no datasets were generated
or analysed. Boundary penetration results alone would not establish correct flow
or wall shear. The adaptive-particle bleeding paper
[Bleeding simulation with stepless adaptive particles](https://www.sciencedirect.com/science/article/pii/S0169260724003158)
was access-blocked in this run; bibliographic details and equations need verification
before adoption.

The current fluid uses constant dynamic viscosity 3.45 mPa·s. The two CY tuples
are tested as constitutive equations only. Physical shear thinning requires the
velocity-gradient invariant and `div(2μ(D)D)`, with consistent wall contributions,
positive dissipation and nonlinear convergence. It does not establish clotting,
red-cell transport, haemolysis or tissue adhesion.

### Boundary correction under test

The v3 fixed tray retains solid-volume pressure/viscosity terms and adds a
frictionless, zero-restitution contact envelope. In each pressure iteration it
projects the normal velocity into the interval that cannot cross a static plane
over the fixed timestep. The next residual is evaluated on that velocity.
It does not relocate positions or bypass a failed density solve. Its centre
clearance is explicitly `dx/2` from the physical wall, and changes with resolution.
It therefore cannot establish the no-slip bore or wall traction needed by T01.
The benchmark retains a `pressure-only` baseline and tests timestep/resolution
refinement. A contact correction count and maximum velocity change are recorded.

For smooth organ meshes, investigate
[volume maps](https://animation.rwth-aachen.de/publication/0565/) instead of
extending the tray's regular sample lattice: the authors address force artifacts
from sampled walls and decouple precomputed solid volume from the smoothing
kernel. Compatibility with a wetting method still needs a separate interface
representation and tests. This is a proposed replacement, not an implemented map.

## Optical realism

The next optical reference is
[Bosschaart et al., whole-blood optical properties](https://pubmed.ncbi.nlm.nih.gov/24122065/).
The record includes a 2022 correction, which must be considered before using its
tables. Absorption, scattering, anisotropy, oxygenation and haematocrit matter;
three arbitrary RGB absorption values are only a preview. The current renderer
does not claim to implement these spectra.

A visual acceptance set should include: thin rim and meniscus; droplet formation
and impact; a spreading/pinned contact line on the actual substrate; connected
pooling without beads; incision outflow under changing upstream pressure; and
moving camera/light views. Use matched real recordings with documented scale,
timing, illumination and material conditions. Do not claim a surgeon has reviewed
synthetic output without an actual review.

The earlier bilateral surface filter has a visible streaking/flattening problem.
The implemented alternative follows
[Truong and Yuksel 2018](https://www.cemyuksel.com/research/papers/narrowrangefilter.pdf):
depth-range filtering, symmetric rejection at occlusions, two separable
iterations and a small 2D cleanup. The positive-depth convention reverses the
paper's signed-depth inequalities. Sample count is bounded while filter support
remains tied to world scale. This addresses surface reconstruction only. A
nearest-depth screen-space representation still cannot resolve hidden layers,
correct refraction through multiple interfaces, or recover sub-particle droplets.

## Decisions against the requested end state

| Observed limitation | Implementation or next architectural step | Required evidence |
|---|---|---|
| Beaded/ribbed surface | Depth/thickness renderer; compare bilateral and narrow-range reconstruction at identical states | Orbit and motion captures; inspect thin edges and silhouette stability |
| Wall penetration | Explicit contact within pressure iterations; then smooth hydrodynamic boundary representation | Swept crossing tests, density guard, tube geometry bias and traction |
| Drop cohesion and meniscus absent | Select one consistent interface-energy or corrected-CSF model | 3D Laplace pressure, oscillation frequency/damping, sessile drops |
| Tissue wetting/trails absent | Substrate-specific contact behaviour; resolve or separately model thin films with conservative exchange | Advancing/receding angles, incline/pinning tests, mass accounting |
| Uniform viscosity only | Verified strain tensor, shear-dependent stress and a stable nonlinear viscosity solve | Dissipation, Newtonian limit, CY tube profiles at three resolutions |
| No arteries | Separate filled-vessel reference plus a validated network/local-domain coupling | Flow, pressure, wall shear, pulsatile phase and branch conservation |
| No incision outflow | Geometry-aware cut sources and transactional vascular/exterior volume ledger | No bleeding before a source is intersected; rollback and supply-limited loss |
| Illustrative blood colour | Corrected optical measurements and controlled light/camera calibration | Matched reference footage across depth, oxygenation and illumination |
| Throughput far below real time | Profile actual GPU phases; compare data layout/dispatch changes at fixed error | Identical physical horizon and states; display FPS and physical throughput separately |
| No demonstrated surgical fidelity | Matched-scale physical reference captures and actual expert review | Blinded motion/appearance assessment; failure cases retained |

No paper inspected establishes that all these requirements can be met at native
4K in real time on every phone. Rendering resolution, physical resolution and
clinical fidelity are separate claims. The current implementation is an
experimental foundation, not a completed surgical blood simulator.

## When to change architecture

The current small-fixture throughput is far below the prompt's physical real-time
target. Measure inactive-slot/dispatch and neighbour traversal costs first.
Changing `dt`, tolerances or particle count is an error-versus-cost experiment,
not an optimization at identical accuracy.

If wall, capillary or throughput gates still fail after targeted corrections,
compare one MAC/FLIP or APIC baseline against the **same** tube, drop, wetting,
mass and geometric-volume fixtures. A visually attractive MPM/SPH demonstration
does not automatically supply incompressible vascular flow or correct CY stress.
Keep raw equal-physical-horizon trials and a KEEP/REVERT/INCONCLUSIVE decision.
This run does not include a second production solver or a validated replacement.
