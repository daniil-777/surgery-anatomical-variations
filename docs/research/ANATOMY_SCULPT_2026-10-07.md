# Anatomy surface sculpting: research, implementation and verification

Date: 2026-10-07. Scope: interactive, persistent surface-point dragging in Atlas Studio. Research confidence: high for the established methods and their mathematical scope; moderate for their suitability to this browser workflow; no clinical validation claimed for this implementation.

## Decision

The implemented tool combines a regularized elastic displacement prior, mesh-connected support, displacement smoothing, a local volume correction and geometric acceptance guards. It accepts the raycast triangle and point directly, keeps the rest mesh immutable during a drag, and returns a complete new position buffer. This makes a released stroke reversible and exportable without integrating a noisy animation trajectory.

This is a deliberately scoped synthesis of established ideas, not a claim of a new elasticity formulation. Its advantage for the current atlas is immediate use on an indexed surface with no tetrahedralization, trained model, sparse matrix dependency or per-organ mechanics calibration. A mesh can have holes or inconsistent winding: surface sculpting still works, while volume correction is disabled and reported as unavailable.

## Questions investigated

1. Which deformation methods preserve fine anatomical shape while a user drags a surface point?
2. How can nearby folded or disconnected tissue avoid being pulled accidentally?
3. Which parts of a physically inspired brush can run directly on the browser's existing triangle mesh?
4. What geometric safeguards are defensible, and which stronger guarantees require a different solver?
5. What recent work offers a credible path from an authoring tool toward validated organ mechanics?

## What already exists and how it affects the decision

| Method | Established capability | Assessment for this atlas |
| --- | --- | --- |
| ARAP | Alternates local rotation estimation and a global solve to preserve local shape under handle constraints. | Excellent candidate for large rotations and persistent multi-handle posing; dynamic local handles require solver infrastructure and careful boundary selection. Our implementation is not ARAP. [Sorkine and Alexa, 2007](https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Sorkine07.pdf) |
| Bounded biharmonic weights | Computes smooth, bounded, shape-aware handle influence at bind time and permits rapid blending afterward. | Strong for a fixed skeleton, cage or established set of handles. Rebinding arbitrary clicks is an additional cost; weights alone do not establish material mechanics or collision safety. [Jacobson et al., 2011](https://www.research-collection.ethz.ch/entities/publication/dca89378-4fa3-40ff-9e58-5b9dd3c240a0) |
| Projective Dynamics | Alternating local projections and a global solve support implicit integration with several continuum-inspired energy types. | Appropriate future path for dynamic organ motion on a coarse volumetric cage. It needs masses, boundary conditions, energy definitions and a solver, beyond a one-stroke authoring edit. [Bouaziz et al., 2014](https://users.cs.utah.edu/~ladislav/bouaziz14projective/bouaziz14projective.html) |
| XPBD | Introduces compliant constraints and force estimates to address timestep/iteration dependence of ordinary PBD stiffness. | Appropriate for simulated graspers and calibrated constraints. Applying a few ad hoc projections without compliance, timestep and multiplier bookkeeping should not be labelled XPBD. Our static correction is not XPBD. [Macklin et al., 2016](https://mmacklin.com/xpbd.pdf) |
| Regularized Kelvinlets | Gives analytical grab, scale, twist and pinch displacement fields derived from regularized infinite-medium linear elasticity. | Best initial prior for arbitrary surface clicks with minimal setup. The original field has broad spatial influence and has no knowledge of this organ's finite boundary, folds or contact. [de Goes and James, 2017](https://graphics.stanford.edu/~djames/publication/kelvinlets/) |
| Dynamic Kelvinlets | Extends the analytical formulation to time-dependent elastic waves and affine impulses. | Relevant to secondary motion, but overshoot and elastic wave motion are unnecessary for persistent authoring strokes. [de Goes and James, 2018](https://graphics.stanford.edu/~djames/publication/dynamic-kelvinlets-secondary-motions-based-on-fundamental-solutions-of-elastodynamics/) |
| Heat geodesics | Computes distances using reusable sparse linear solves; modern intrinsic operators improve behavior on poor meshes. | A future improvement for less directional brush footprints and repeated queries on a fixed mesh. Current bounded Dijkstra distances follow edges and therefore approximate, rather than equal, continuous surface geodesics. [Crane et al.](https://www.cs.cmu.edu/~kmcrane/Projects/HeatMethod/) |
| Incremental Potential Contact | Couples nonlinear mechanics, contact barriers and collision-aware solution steps to obtain intersection- and inversion-free trajectories. | Sets the standard for stronger contact guarantees. Our local face/edge checks cannot provide IPC's global self-contact guarantee. [Li et al., 2020](https://ipc-sim.github.io/) |

Kelvinlets have also been evaluated as deformation bases in sparse organ registration, including liver phantom and in-vivo breast datasets, with accuracy and computation comparisons against FEM. That supports investigating the prior for anatomical geometry; it does not validate the brush here, whose compact support, smoothing and artistic resistance differ from that registration model. [Ringel et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC11869944/)

The 2025 Neural-Augmented Kelvinlet work couples analytical priors with FEM-supervised neural residuals and studies single- and multi-grasper liver deformation. Its finite-element models include anatomical fixed regions and nonlinear material assumptions. This makes a credible future research direction: learn an error correction against a specified mechanics model, with held-out geometry and interaction testing, while retaining an analytical fallback. Those learned models and datasets are not included in the implemented tool. [Shahbazi et al., version 2, September 2025](https://arxiv.org/html/2506.08043v2)

## Implemented mechanism

Implementation: `apps/studio/src/atlasSurfaceSculpt.ts`.

### 1. Rest-space contact and connected support

The browser supplies a mesh-local ray hit `c` and its triangle ordinal. The three triangle vertices seed a bounded Dijkstra search with their distances from the actual hit. Edge lengths are measured on the stroke-start mesh. Unreachable vertices have zero weight, so a physically nearby but disconnected sheet remains fixed.

The support radius `R` is at least 2.05 times the largest hit-to-corner distance. This avoids a radius smaller than a single triangle producing a one-vertex spike. The effective radius is returned to the caller. Within support, use the compact smooth profile

`w(d) = (1 - d/R)^4 (1 + 4 d/R),  0 <= d < R`, otherwise zero.

The graph follows topology, not Euclidean proximity. A distant part of a folded connected organ must be reachable through short mesh paths before it moves. Split vertices at unwelded seams remain separate: welding must be handled upstream if they should share a brush.

### 2. Normalized elastic grab prior

For `r = x - c`, `re = sqrt(dot(r,r) + epsilon^2)`, `epsilon = 0.45 R`, and `b = 1 / (4(1 - nu))`, use the regularized grab form with the common shear factor cancelled:

`K(r) delta = [(1-b)/re + epsilon^2/(2 re^3)] delta + b r dot(r,delta)/re^3`.

Multiplying by `epsilon / (1.5 - b)` normalizes the unmasked field at its center. Here `nu = 0.49` is an artistic near-incompressible prior, not an organ-specific estimate. The mesh support multiplies this field by `w`. This use of a compact mask changes the governing field: it must not be described as an exact finite-domain elasticity solution. [Original Kelvinlet formulation and scope](https://graphics.stanford.edu/~djames/publication/kelvinlets/), [libigl formulation](https://libigl.github.io/tutorial/#mesh-deformation-with-kelvinlet)

Requested displacement is limited to `0.7 R` per stroke and attenuated by `1/(1 + 1.8 s)` for resistance `s` in `[0,1]`. Resistance is a dimensionless authoring control. Because the input prescribes a displacement rather than a force, assigning it a Young's modulus in pascals would be misleading.

### 3. Detail-preserving regularization

Five Jacobi sweeps apply screened smoothing to **displacement**, never to the source coordinates:

`u_i <- [target_i + lambda mean(u_neighbors)] / (1 + lambda)`, with `lambda = 0.3 + 1.7 s`.

Outside-support displacements are fixed at zero. This regularizes the movement while retaining pre-existing surface details in the rest mesh. It is a uniform graph approximation, not a cotangent biharmonic or ARAP solve. Highly irregular triangulation can still bias the footprint.

### 4. Local volume compensation when defensible

A connected component qualifies only when every edge has exactly two oppositely oriented incidences, it has no degenerate triangle, and its signed volume is non-negligible. The signed volume uses a translated frame to reduce cancellation. Open, inconsistently oriented or nonmanifold components expose `closedComponent=false` and `volumeChangeFraction=null`.

For qualifying components, three linearized volume projections use the surface volume gradient. The mobility mask `m_i = w_i (1 - w_i)^2` reduces correction at the contact core and at the support edge. The scalar update is

`lambda_v = (V_target - V_current) / sum_i m_i ||grad_i V||^2`;
`x_i <- x_i + lambda_v m_i grad_i V`.

Each correction is bounded to `0.12 R`. The requested preservation strength sets a volume target between the uncorrected volume and the original volume; default is 90%. This creates compensating motion in neighboring tissue without scaling the whole organ. Closed-surface volume preservation does not establish local incompressibility or a valid interior deformation Jacobian.

### 5. Conservative geometric acceptance

The complete candidate is checked on the actual Float32 output:

- Modified edges must remain between 0.4 and 2.0 times their original length.
- Each nondegenerate affected triangle must keep at least 12% of its original oriented projected area relative to its stroke-start normal.
- When `guardPositions` supplies the immutable generated specimen, cumulative edits must also retain at least 2% oriented projected area relative to that specimen. This keeps repeated accepted strokes compatible with the exporter, which rejects faces reversed relative to the original generated geometry.
- Up to 15 global backtracking attempts reduce the stroke; if none passes, return the exact rest mesh.

These guards prevent the tested local collapse/orientation failures, and deliberately constrain large rotations. They do **not** test nonadjacent triangle intersections, collisions with other organs, interior tetrahedral inversions, or collisions along the full cursor trajectory. The `guarded` and `appliedFraction` diagnostics expose motion limiting to the interface.

### 6. Reversible stroke contract

`beginSurfaceSculpt(options)` snapshots positions and topology. Every `update(delta)` evaluates the displacement from that same snapshot. Moving the pointer back to its starting point returns the original Float32 positions exactly. Repeating the same delta is deterministic and independent of intermediate pointer events. On pointer release, the caller stores a complete positions snapshot as one history entry; undo and redo should restore snapshots rather than numerically applying inverse deformations.

Material coordinates should remain in rest space and share the vertex topology while visible geometry moves. Otherwise a procedurally evaluated texture can appear to slide across the sculpture. Recompute normals/bounds after a movement and export the same committed position buffer that is shown in the viewport.

## Verification

`apps/studio/src/atlasSurfaceSculpt.test.ts` exercises:

1. Exact zero-motion restoration, original-input immutability, deterministic stroke-start updates.
2. No movement on a nearby disconnected sheet, across a close fold connected by a long path, or outside the graph support.
3. Translation, rotation and uniform-scale equivariance.
4. Closed-sphere volume-error reduction with the correction enabled.
5. Safe fallback when winding is inconsistent or a surface is open.
6. Extreme drags with finite positions, positive face orientation and bounded edge lengths.
7. Broad contact, resistance response and support enlargement below triangle scale.
8. Sixteen sequential aggressive strokes remain consistently oriented against an immutable export specimen.
9. Invalid mesh, hit, baseline and displacement input rejection.

On 2026-10-07, all ten tests passed in 62 ms test time; the mirrored Studio TypeScript check also passed. Runtime benchmarks and viewport evidence are separate from these mathematical checks and must be read alongside them.

### Runtime and browser evidence

`scripts/benchmark_atlas_sculpt.mjs` runs 60 updates after five warmup updates. The recorded local Node 24 / macOS run measured:

| Mesh | Vertices | Stroke setup | Update median | Update p95 |
| --- | ---: | ---: | ---: | ---: |
| Closed subdivided sphere | 4,098 | 18.1 ms | 0.77 ms | 1.86 ms |
| Closed subdivided sphere | 16,386 | 58.9 ms | 1.98 ms | 5.52 ms |
| Closed subdivided sphere | 65,538 | 219.1 ms | 7.73 ms | 17.77 ms |
| HRA female liver | 18,011 | 23.4 ms | 0.29 ms | 0.32 ms |

These are **CPU solver timings**, excluding normal regeneration, WebGL rendering, pointer dispatch and browser automation. They establish an interactive solver budget on this machine; they do not prove a particular end-to-end frame rate. The largest mesh still has a noticeable one-time contact setup, which could be moved to a worker or reduced with topology caching.

An independent browser run used a 65 mm radius and 15% resistance with a diagonal drag. It reported 15.6 mm displacement, engaged the motion guard, and produced a smooth local shape change with no visible spike in the captured view. Undo and redo were exercised successfully; no JavaScript exception was reported. Pixel comparisons over the organ region found 19,279 visibly changed pixels after sculpting, **zero differing pixels** between the initial and undone images, and **zero differing pixels** between the sculpted and redone images. This also checks fixed camera framing and repeatable rendered restoration in the tested view. Before/after/undo/redo PNGs, a recorded WebM, browser findings and numerical timing JSON are saved in `benchmarks/results/anatomy-sculpt-2026-10-07/`. This is one tested liver view and interaction, not an assertion that every organ or drag is visually perfect.

Cancellation review found that recomputing original normals after Escape could slightly change the appearance even though positions were restored. The viewport now restores both original position and normal buffers. The final stable Escape run produced **zero differing pixels**, left Undo disabled, and reported no JavaScript exception. A run interrupted by development hot-reload was excluded from the conclusion. The review also corrected stale redo after replacing geometry, restored the displayed recipe when a shape change is blocked by an existing sculpture, blocked unreviewed learned shape replacement while edits exist, and aligned the right-drag action with its orbit hint. Pointer cancellation/lost capture share the same restoration function. Multi-organ self-contact and exhaustive mobile hardware testing remain outside this verification.

### Why the liver reports an open surface

The generated HRA female liver has 18,011 vertices, 35,606 triangles, seven connected components and 422 boundary edges. It has no nonmanifold edges or inconsistent winding in this audit. The largest component contains 15,133 vertices and itself has 230 boundary edges. Welding positions to 0.0001 mm merges 96 duplicate vertices but still leaves 230 boundary edges; its open status is not merely a texture seam artifact. Disabling enclosed-volume correction is appropriate for this reference. The six smaller components are not automatically attached to the larger component by Euclidean proximity, because doing so would also couple unrelated tissue sheets.

## Limitations and next work

The current result is a persistent shape-authoring tool. It has no calibrated tissue parameters, viscoelastic relaxation, gravity, organ attachments, cutting or surgical instrument contact. It does not produce a volumetric displacement field for internal vessels. Surface-bound vessel paths must follow the same topology or be reconstructed from the edited organ; an independent tube mesh cannot be left at its old world coordinates.

For higher mechanics fidelity, the next experiment should compare a coarse tetrahedral corotated or hyperelastic solver with the Kelvinlet baseline under identical grasp displacements and anatomical boundary conditions. Evaluate unseen shapes, large rotations, local volume/Jacobian error and force response. If a learned residual is added, compare it against the unlearned analytical prior and FEM on held-out interactions, not just attractive screenshots. For globally robust collisions, add a suitable contact solver and continuous collision detection rather than promoting local face checks into a collision guarantee.

## Methodology and source access

Targeted searches covered elastic sculpting, ARAP, bounded biharmonic weights, projective dynamics, compliant position constraints, geodesic distances, nonlinear contact, organ registration and recent neural Kelvinlet models. Primary research and authors' project pages were used. Full text was opened for ARAP, XPBD and the 2025 neural paper; the Kelvinlet author page and libigl mathematical reference were checked directly. Some older hosted PDF endpoints redirected or were too large to fetch, so their author/institution abstracts and accessible mirrors were used instead. No performance number from a paper is presented as a measurement of this implementation.
