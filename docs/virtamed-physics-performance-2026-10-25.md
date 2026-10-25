# VirtaMed physics and performance refinement

The scene keeps its twelve structures, white export, learned appearance, disease recipes and instrument guards. This update targets smoother displayed deformation, less CPU work, tissue-specific contact response and stable surface highlights.

## Mechanics

The existing per-tissue synthetic SLS fits (E, relaxation fraction and time) are unchanged. Each VirtaMed tissue now also has an explicitly authored response profile, independently reported in the physics snapshot:

| Tissue | Cubic stiffening coefficient | Local damping ratio | Support radius / characteristic length |
|---|---:|---:|---:|
| Liver | 14 | 0.90 | 0.90 |
| Gallbladder | 24 | 0.95 | 0.75 |
| Bile ducts | 32 | 0.90 | 0.65 |
| Cystic artery | 40 | 0.90 | 0.60 |
| Bowel and duodenum | 18 | 0.95 | 0.90 |
| Fatty apron | 28 | 1.05 | 0.90 |
| Membranes and ligaments | 55 | 0.90 | 0.75 |

The local equilibrium force adds `k_eq * beta * (|q| / R)^2 * q`. Its positive quartic energy gives progressively increasing resistance while its derivative vanishes at zero strain, preserving the fitted small-strain modulus. The original viscoelastic branch still governs relaxation. An implicit Newton solve includes the unilateral push or vector grasp spring; convergence failure stops the scene. Existing displacement, force and orientation-gradient limits remain active.

Contact support is scaled by the selected structure's characteristic size and the physical tip radius, with the old broad support as an upper limit. A coarse picked triangle can enlarge support to keep its rendered barycentric anchor consistent. Small contact masses use their density-derived volume estimate down to a 1 g numerical floor. These are reduced-order design choices, not measured organ masses or capsule properties.

[Samur et al., human cadaver liver/stomach indentation](https://pmc.ncbi.nlm.nih.gov/articles/PMC2693244/) supports nonlinear viscoelastic modeling in the relevant loading context. [Alkhouli et al., human subcutaneous and omental adipose tissue](https://pubmed.ncbi.nlm.nih.gov/24105412/) reports nonlinear tensile behavior and depot-dependent moduli. These papers motivate the model form; their fitted numbers were not copied into this different geometry and loading model. The new coefficients are authored, not identified by the inverse estimator. This remains a synthetic preview without full volume conservation, organ–organ sliding/contact, anisotropy, fluid pressure or clinical validation.

## Performance hypotheses and correctness gates

The bounded search compares the original path, cached contact footprints, packed surface updates, and higher display cadence on the same 82,018-vertex GLB (74,673 moving vertices). At most six implementation variants are evaluated. No geometry decimation or texture-resolution reduction is used.

1. Cache the exact rest-space contact kernel per binding/contact. Invalidate on a new or sliding contact, changed rest-buffer identity or reset. Released contacts retain their recovery fields.
2. Compute the same current corner-angle normals in packed arrays with reused scratch storage. Current AABBs remain exact; the sphere conservatively encloses the AABB. Triangle narrow-phase checks remain unchanged.
3. Spread normal work across frames while uploading current positions and collision bounds together. Preserve 120 Hz integration and the explicit 100 ms stall budget.
4. Reuse stationary camera-light shadows until geometry, instrument pose or the camera invalidates them.

The learned normal maps previously added an XY perturbation in camera coordinates. The new shader projects each triplanar slope through rest-space derivatives into the current deformed tangent frame. This keeps microrelief tied to the tissue as camera and anatomy move; it does not turn authored optics into measured tissue reflectance.

Initial three-run CPU benchmark (milliseconds per update, medians of run means):

| Variant | Solver | Deform | Normals/bounds | Total |
|---|---:|---:|---:|---:|
| Baseline | 0.283 | 4.160 | 7.263 | 11.692 |
| Cached contact footprint | 0.267 | 2.466 | 7.226 | 9.922 |
| Cached footprint + packed surfaces | 0.254 | 2.406 | 2.915 | 5.575 |

The baseline microbenchmark uses Three.js area-weighted normals; the optimized path performs the more expensive corner-angle weighting used by the production scene. Therefore the browser benchmark is the direct production comparison. Raw runs retain warm-up, per-frame percentiles and complete solver state; these timings are local measurements, not cross-device guarantees.

## Reproduction

Use Node 24 for the CPU script:

```sh
BENCH_SURFACE=fast node scripts/benchmark_virtamed_physics.mjs /tmp/physics.json
BENCH_OUTPUT=/tmp/browser-benchmark node scripts/benchmark_virtamed_browser.mjs
```

The browser script uses a 1600×1100 viewport, a two-second warm-up and eight-second measurement for idle, breathing, held grasp and release recovery. It records rAF cadence, actual scene draw count, main-thread/script work, heap, physical time, dropped time and screenshots. `BENCH_URL` selects a local preview or the deployed URL. Fixed-step replay, analytic/rendered anchor agreement, exact reset, normal equivalence, bounding containment, nonlinear force residuals, stiffness sensitivity and recovery are tested independently of timing.

## Final geometry and interface review

After the performance experiments, the reconstruction was refined separately: denser, irregular bowel folds; a rounded gallbladder with a matched duct ring; fine liver relief and an inferior crease; thin connected fatty drapes; and registered membrane/ligament insertions. The hepatic membrane now approaches each capsule with a tangent cubic collar, removing the dark angular root visible in an earlier close-up. The final white GLB is 4,508,832 bytes, SHA-256 `ba6aea527f3af0401444fa9bdfd80cdf089e6fc923786d77a24787bae4401627`.

The four insertion pairs now share rest-space PBR fields. The fatty rim has a support-gated cover approximation. Appearance, band width and interface microdetail respond to the neighboring recipes and remain attached to the moving geometry. See [the interface research and implementation report](research/virtamed/tissue-interfaces.md) for anatomical sources, equations and limitations.

The final review recorded 43 canvas captures at 1890×1400 pixels: white geometry, healthy tissue from three views, five disease recipes at 80% severity from front/left/right/closer views, nine guarded push/grasp/release cases, and a final white-material switch. All five variation replays reproduced their geometry and material signatures. No page or shader errors occurred. The largest captured rendered-anchor discrepancy was 0.00000333 mm; the largest captured reaction was 0.069 N for this deliberately light interaction protocol. These values verify implementation consistency, not biological accuracy. The static preview logged expected 404s for unavailable optional live API status endpoints; scene assets loaded successfully.

Inspection compared the supplied 00:08 video frame and earlier local renders with the final baseline, oblique disease views and force captures. The root artifact and hard liver–ligament color discontinuity improved. Remaining visible limitations include stylized vascular branching, repeated microtexture, simplified pathological nodularity and incomplete inferred hidden anatomy. Free overlaps intentionally retain distinct tissues. Clinical realism is not established by screenshots or software tests.

Final Chrome/Metal benchmark, 1600×1100 viewport, eight-second measurement after warm-up:

| State | Rendered FPS | Geometry updates/s | rAF p95 (ms) | Main-thread CPU (s) | Dropped physics time |
|---|---:|---:|---:|---:|---:|
| Idle | 0, on demand | 0 | 16.7 | 0.244 | 0 |
| Breathing | 60.0 | 60.0 | 16.7 | 3.016 | 0 |
| Held grasp | 60.0 | 60.0 | 16.7 | 4.447 | 0 |
| Recovery | 60.0 | 60.0 | 16.7 | 3.282 | 0 |

The old scene's first held-grasp run measured 53.5 FPS/p95 33.3 ms, but its repeat also reached 59.9 FPS/p95 16.7 ms. No reliable fixed FPS uplift can therefore be claimed. The optimized per-update path supports three times the prior mesh-upload cadence; the denser final geometry, shared interface shading and increased update rate use more total CPU than the old 20 Hz path. Idle physics still advances its clock without redundant geometry uploads when unforced and breathing is disabled.

Release checks: TypeScript passed; 98 tests in eight focused geometry/physics/contact/navigation suites passed; five browser tests passed, including import/export, white/material switching, paired interface variation replay, corrupted-asset rejection, resting upload suppression and narrow-screen layout. The production static build completed in approximately nine seconds using a clean locked dependency install.

The built-site smoke test also passed all six routes: atlas generation, calibrated physics lab, whole-scene operative navigation, VirtaMed import/material/physics workflow, procedural studio and texture lab. Local review artifacts are saved under `artifacts/virtamed-refinement-2026-10-25/`, with an offline HTML gallery and the full motion recording; these large artifacts are not bundled into the public site.
