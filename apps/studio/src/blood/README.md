# Blood laboratory — experimental, separate from organ/fat engines

Open Studio with `?mode=blood`, or use **Blood lab** in the anatomy workspace.

The exterior-fluid view uses a separate WebGPU runtime. Independent artery and
thin-film playgrounds validate limited straight-tube and periodic shallow-film
models. None establishes surgical realism or bleeding from an anatomical cut.
Treat the displayed surfaces as experimental visualization.
The original `AnatomyAI-prompts-revision-3` research and references are unchanged.

## Implemented ownership

| Module | Responsibility |
|---|---|
| `scene.ts` | Whitelisted, versioned SI scene; FP32 timestep; deterministic initial state; configuration SHA-256; capability declaration |
| `material.ts` | Unmixed sourced CY tuples, strain invariant and separate citrated-blood surface-tension reference |
| `runtime.ts` | One device/queue for simulation and rendering; preallocated state; bounded submissions; asynchronous step-tagged telemetry; resource cleanup |
| `shaders.ts` | Cubic SPH kernel; exact spatial traversal; fixed-wall quadrature; Newtonian predictor; DFSPH correction; GPU acceptance |
| `boundary.ts` | Declared tray geometry and independent CPU reference for unilateral normal-velocity contact |
| `renderer.ts`, `surface.ts` | Accepted-state-only particles and separate depth/thickness/narrow-range/surface passes; native canvas recording lease |
| `bench.ts` | Explicit browser test harness; never imported by the product entry point |
| `BloodLab.tsx` | Settings apply by reset; pause/resume; orbit; text/scene sizing; report download; shared recorder with microphone support |
| `artery/solver.ts` | Separate transient axisymmetric momentum solve, nonlinear face stresses, numerical diagnostics and rejected-step rollback |
| `artery/ArteryLab.tsx`, `artery/renderer.ts` | Vessel/waveform controls, SI tracer transport integrated over accepted steps, signed field display and native recording |
| `capillary/solver.ts` | Conservative 1D thin-film dynamics, implicit capillarity, precursor wetting and energy/volume rejection gates |
| `capillary/CapillaryLab.tsx`, `capillary/renderer.ts`, `capillary/geometry.ts` | True-height periodic film extrusion, thickness profile, bounded presets, native recording and evidence export |
| `optics.ts`, `opticsLut.generated.ts` | Fixed-condition spectral slab lookup, declared RGB approximation and passive substrate composition |
| `surfaceReconstructionBench.ts`, `opticsBench.ts` | Independent GPU reconstruction invariants and CPU/GPU optical lookup parity |

No fat/tissue solver or generation code is imported or changed. The recording
registry gained a small native-canvas registration function; existing WebGL leases
retain their original implementation.

The third workspace opens at `?mode=blood&flow=film`. Its [model and tests](capillary/README.md)
cover a 1D overdamped ridge with 96 cells and a 5 ms fixed step, including all
12 exposed combinations of surface tension and wetting. The renderer uses
actual heights and slopes; width is a uniform extrusion. The
[optics documentation](../../../../blood/OPTICS.md) specifies the oxygenated,
hematocrit-45%, D65 conditions and source attribution. No new trained network
or calibrated tissue contact law is claimed.

## Numerical work order and pass contract

Initial outcome: revision-3 stages 0/1 and an **experimental** stage-2 vertical slice.
The later user request for actual fluid appearance prompted a separate surface
preview and fixed-volume tray boundary experiment. Neither is counted as having
passed the later free-surface/wetting/rigid-body stages.

The pressure sequence follows Bender/Koschier, *Divergence-Free SPH for
Incompressible and Viscous Fluids*, Algorithms 1–3, equations 9–12
([paper](https://dankoschier.github.io/resources/papers/BK17.pdf)).
Differences are explicit: fixed timestep; no warm start; relaxed Jacobi (0.5);
maximum rather than mean residual; signed residuals for the fully periodic
fixture. The tray uses a compression-only free-surface approximation, with sparse
divergence samples excluded below 20 neighbours. This approximation cannot
validate capillary suction or wetting.

Let `D_i = |Σ_j m_j ∇W_ij|² + Σ_fluid j |m_j ∇W_ij|²`.
Fixed solid-volume samples contribute to the first term and density, but not to
the neighbour-reaction term. The kernel has support `H = 2 dx`.

| Pass | Read → write | Equation / meaning |
|---|---|---|
| Begin/seed | accepted A → candidate C | Sticky run halt cannot be cleared by another queued attempt |
| Spatial/geometry | C positions → sorted indices, cell starts/ends, density, D | Exact `< H` cutoff; no fixed neighbour capacity; separate scalar start/end arrays |
| Predictor | C velocity → work velocity → C | Constant `ν=μ/ρ₀`; central 3D pair viscosity plus gravity only for tray |
| Density residual | C → work coefficients/residual | `e_i = ρ_i + dt Σ m_j(v_i-v_j)·∇W_ij − ρ₀`; impulse coefficient `e_i/(dt D_i)` |
| Density correction | old C + all coefficients → work → C | `Δv_i = −0.5 Σ m_j(c_i+c_j)∇W_ij`; boundary coefficient is zero |
| Tray contact | work velocity + fixed wall geometry → C and work | Project normal velocity into the non-crossing interval before the next pressure residual; no position clamp |
| Reduction/gate | per-particle residual → group maxima → control | `max |e|/ρ₀`; bounded slots, checked after the final correction |
| Advection | C velocity → C position | `x += dt v`; periodic wrap or guarded tray domain; no bounce/clamp force |
| Geometry refresh | moved C → rebuilt neighbours/factors | Earlier position epoch cannot be reused |
| Divergence residual/correction | C → work → C | coefficient `(Dρ/Dt)/D_i`; residual `max |Dρ/Dt|/ρ_i` in s⁻¹ |
| Final guard | candidate geometry/control → acceptance | Actual compression checked after advection, not just predicted compression |
| Commit then publish | C → A, then metadata | Guarded GPU copies; separate dispatch increments accepted clock |
| Render/readback | A → images; controls → staging ring | No solver dependency on camera, colour, frame dimensions or recording resolution |

The impulse coefficient is `dt κ_i/ρ_i`; an equivalent pressure increment is
`ρ_i² c_i/dt`, including the 0.5 relaxation. The current build does **not** accumulate,
gauge-fix or validate a pressure observable in Pa. In particular, a displayed
residual is not an arterial pressure measurement.

The explicit physical viscosity uses the central pair form
`10 ν Σ_j (m_j/ρ₀) ((v_i-v_j)·r_ij)/(r²+0.01 H²) ∇W_ij`.
This is a constant-Newtonian operator in this build. A CY viscosity evaluated
from speed and inserted into this formula would **not** be a validated
`div(2 μ(D) D)` implementation, so the UI does not offer that substitution.
Reference implementation inspected:
[SPlisHSPlasH standard viscosity](https://github.com/InteractiveComputerGraphics/SPlisHSPlasH/blob/master/SPlisHSPlasH/Viscosity/Viscosity_Standard.cpp).
No external simulation source files were copied.

## State, units and scheduling

- A/C each contain `N vec4<f32>(position metres, mass kg)` followed by
  `N vec4<f32>(velocity metres/second, padding)`. Stride is 16 bytes.
- IDs are immutable `u32` values separate from the sorted particle-index
  permutation. Tests include IDs near `2³²−1`.
- Work has velocity ping-pong, density/factor, coefficients, per-particle
  residuals and group maxima. No neighbour-dependent values are updated in place.
- Cell starts/ends use separate scalar arrays, avoiding concurrent vector-component writes.
- Solver loops do not map or wait for the GPU. Three staging buffers deliver
  telemetry asynchronously. At most two submissions (including render-only work)
  are outstanding.
- Accepted time is CPU-double `acceptedStep × uploaded FP32 dt`. A ten-million-step
  guard requires reset before counter overflow. No hidden-tab catch-up.
- There are no live physical input events yet. The exported cursor is a commit
  sequence, not evidence that cutting/release events have been implemented.
- Reset creates a new configuration/device lifetime. Device loss halts operation
  and requires explicit reset. The runtime has no background network dependency.

## Surface preview

The renderer reconstructs front depth from sphere splats, computes a separate
volume-normalized thickness field, smooths depth with an approximate separable
filter, and shades using a spectral slab approximation plus GGX/Fresnel highlights. The default
uses the narrow-range method of
[Truong and Yuksel](https://www.cemyuksel.com/research/papers/narrowrangefilter.pdf),
with two separable iterations and a 5×5 cleanup. The bilateral baseline remains
available to the explicit visual harness for identical-state comparison.
Support/filter lengths originate in world space. Camera-dependent reconstruction
never alters accepted positions. See
[Green's screen-space fluid rendering presentation](https://developer.download.nvidia.com/presentations/2010/gdc/Direct3D_Effects.pdf).

The optical coefficients come from the corrected, attributed reference described
in the optics documentation. The slab approximation, illumination, roughness
and Fresnel constant remain **uncalibrated**. Layer-aware filtering now preserves
the tested raw visibility masks; it does not recover sub-particle detail.
The separable filter and nearest-surface representation have known limitations.
The reconstructed image is not the independent geometric-volume estimator required
by I01. No droplets, contact angles, tissue wetting or blood spectra are certified
by the renderer.

The compact default uses two R32Float depth images, one R16Float thickness image
(the original RGBA16Float's unused channels are removed), and a depth attachment.
At native UHD these require `3840×2160×14 = 116,121,600 bytes`. Diagnostic depth
is allocated only in particle mode. Canvas, driver and simulation allocations are
additional. The original surface-mode allocation used 28 bytes/pixel including
the unused diagnostic attachment; exact raw-pixel regression checks retain that
reference path with `compactStorage: false`. Render targets are
allocated only for the active dimensions, reused across frames, destroyed on resize,
and released on teardown. A 4K output file does not prove 4K detail or real-time flow.

## Optimized execution and arterial playground

The default sort performs exact lexicographic bitonic comparisons in 256-pair
shared-memory tiles, then merges global strides with local eight-stage tails.
It preserves the original neighbour traversal and arithmetic order. Pressure
correction and contact are fused per particle because the correction gathers
neighbour coefficients and positions, not neighbour velocities. A separate
single-workgroup maximum/gate removes a dispatch without changing tolerances.
Original execution remains selectable through `BloodRuntime.create` options
`optimizedSort: false, compactPressure: false, localMerge: false`.

The optional timestamp profiler is development-only; normal rendering does not
request queries or add readbacks. See [PROFILING.md](PROFILING.md) for non-additive
Metal pass intervals and bounded resource ownership.

The separate [artery module](artery/solver.ts), available at
`?mode=blood&flow=artery`, solves filled, rigid, straight, fully developed flow
using annular finite volumes and backward Euler. Its Carreau–Yasuda face stresses,
no-slip radius, pulsatile inertia and signed wall shear do not alter the exterior
DFSPH solver. It is tested against independent Poiseuille, CY and Womersley
solutions; see [arterial validation](../../../../docs/artery-physics-validation-2026-10-20.md).
The cutaway and passive streaks are scientific visualization, not resolved cells
or a photorealistic surgical view. Neither model yet handles a cut organ.
Tracer transport integrates each accepted physical step before a display update,
so batching steps or reversing flow does not introduce frame-rate-dependent
displacement. A 6 ms CPU work budget and bounded catch-up slow simulated time on
overloaded devices without changing the physical timestep.

Read the [optimization measurements](../../../../docs/blood-optimization-2026-10-20.md)
and [research and realism requirements](../../../../docs/blood-realism-methods-2026-10-20.md).

## Running checks

Use Node 22+ and the existing pnpm workspace. A development server must be running
on `127.0.0.1:5174`; the GPU script launches its own isolated Chrome on macOS.

```sh
pnpm exec vitest run apps/studio/src/blood/blood.test.ts packages/render/src/sceneRecording.test.ts
pnpm exec vitest run apps/studio/src/blood/artery/solver.test.ts apps/studio/src/blood/profiler.test.ts
pnpm --filter @viscera/studio typecheck
node scripts/check_blood_gpu.mjs
node scripts/check_blood_gpu.mjs --flow
node scripts/check_blood_gpu.mjs --optimization
node scripts/check_blood_gpu.mjs --contact
node scripts/check_blood_gpu.mjs --long
node scripts/check_blood_ui.mjs
node scripts/check_artery_renderer.mjs
node scripts/check_artery_ui.mjs
node scripts/benchmark_blood.mjs --verify
node scripts/benchmark_blood.mjs --render
node scripts/benchmark_blood.mjs --lifecycle
```

`BLOOD_BASE_URL` and `BLOOD_EVIDENCE` override the local origin and evidence
directory. Tests never change the existing model API, Google Drive, Colab or
training weights. The fixture hooks are explicit test entry points, not product controls.

Read the raw evidence and final assessment in `artifacts/blood-2026-10-20/`.
The v2 periodic translation fixture completed 10 physical seconds with zero
mass drift, geometric-volume relative error below `3e-16`, and maximum density
error `3.97e-5`. This qualifies only that periodic transport case, not free-surface
volume or a surgical scenario. Its wall time was 483 seconds. Missing
hydrostatic, free-surface tube, capillary, wetting, rigid-coupling and measured
bleeding experiments remain NOT_RUN or UNSUPPORTED. The separately tested rigid
artery solver does not qualify these missing exterior-fluid cases.
