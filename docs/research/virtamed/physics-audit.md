# Viscera full-scene mechanics audit

2026-10-25. Read-only audit of `/tmp/viscera-operative-release`; no implementation changed. This report concerns the existing mechanics and what can be supported when adding the video-inspired scene. The video itself is being inspected separately by the parent agent; this report does not claim a metric reconstruction from it.

## What is already implemented

### Whole scene: interactive, bounded reduced model

`apps/studio/src/wholeScenePhysics.ts` implements a coupled reduced-order standard-linear-solid (SLS) preview. It has one three-axis mode per soft structure, a shared 9 × 15 × 7 trilinear displacement lattice, nearest-neighbor modal springs, and local smooth compact-support tool fields. Distances render in millimetres, integration uses SI. The fixed timestep is 1/120 s; at most 100 ms of a render stall is admitted, with dropped time recorded. It preserves identical shared coordinates exactly across separately rendered organs.

Per-part `young_pa`, `relaxation_fraction`, `relaxation_time_s`, and density determine modal stiffness/mass and local tool compliance. However, stiffness-to-mode scale, damping, posterior supports, neighbor graph, contact stiffness, and load amplitudes are authored approximations. Global motion is capped at 8 mm; local push/grasp modes are capped; total displacement-gradient bound is kept ≤0.45. This prevents orientation reversal in the continuous authored field but is not a tissue stress/incompressibility criterion.

`beginToolContact` and `moveToolTarget` implement push/grasp. Push has compressive-only normal force; grasp permits arbitrary target motion. The default displayed reaction is capped at 3 N (up to 9 N with strength 3). This is a simulator limit, not a clinical safe-force threshold. Barycentric triangle anchors match the actually rendered triangle, including coarse meshes. Releasing a tool retains its memory and decaying deformation rather than snapping back.

`wholeSceneContact.ts` implements refittable triangle BVHs and real face/edge/vertex contact. Sphere sweeps prevent the tool tip tunneling through thin faces; capsule checks cover shafts and jaws. `wholeSceneTools.ts` integrates these with actual instrument geometry, connected grip-patch exclusions, keyboard/pointer continuity, and explicit blocked movement. These are instrument guards. They are not organ–organ collision, a friction solver, cutting, or fluid pressure.

### Existing materials are synthetic inference, not biological training

`scripts/whole_scene/build_learned_materials.py` starts from category presets and deterministic random perturbations, synthesizes ramp-hold-release stress histories, adds tiny noise, and sends these histories through the existing inverse model. It validates on a separate smooth cyclic waveform. The shipped table assigns 36 soft structures; its maximum held-out normalized stress error is 0.0006503, but this is a synthetic constitutive-model recovery test. It does not measure how any human organ responds.

Examples in the shipped table: liver E ≈4.13 kPa, stomach ≈4.08 kPa, gallbladder ≈3.90 kPa, small bowel ≈4.10 kPa, mesentery ≈11.24 kPa. These are generated design values, not tissue literature measurements. A nominally different value per organ does not establish organ-specific learned physiology. Density is fixed at 1000 kg/m³ and explicitly not inferred.

The parser currently accepts ONLY `observation_origin: "synthetic-design-history"`, E 500–20,000 Pa, relaxation fraction 0.05–0.75, relaxation time 0.05–2 s, and density 900–1200 kg/m³. It rejects duplicate/missing organs, non-finite values, unaccepted fits, and invalid model hashes. Do not relabel measured data as synthetic just to pass this parser. If calibrated observations are supported later, introduce an explicit provenance variant with calibrated-data validation.

### Fat is a follower in the whole scene

`fat/sceneLayerView.ts` builds omental/perirenal geometry, applies the same anatomical warp, binds every fat vertex to the shared displacement field, and updates normals/bounds. This prevents a visibly static fat sheet while an underlying organ moves.

Fat layers currently do not become `WholeScenePhysics` modes, are not in the parts supplied to `WholeSceneTools`, and therefore cannot receive an independent material or direct tool contact. Their snapshot correctly says “Shared atlas warp / interpolated scene motion; no fat contact solve.” The navigation camera includes fat surfaces, but the instrument system does not. Any new full-scene integration should either register fat as explicit physics/tool parts or keep this limitation visible in its engineering metadata.

`fat/physics.ts` is a separate homogeneous material bench: compressible Neo-Hookean elastic response, free-lateral compression, exact positive multi-branch Prony recurrence, prescribed ramp/hold/release or cyclic strain, stress relaxation, work, and rate effects. It does not integrate a 3D adipose volume or solve contacts. Default parameters are explicitly illustrative. Its visceral shear modulus 8 kPa and Poisson ratio .49 imply small-strain E ≈23.84 kPa, beyond the whole-scene parser’s 20 kPa upper bound; its 30 s relaxation branch is also outside the scene’s 2 s bound. Copying these values into the liver inverse model is not valid without a new calibration domain.

### Stronger mechanics exist for an isolated liver cage

`liverContinuumMaterial.ts` / `liverPlaygroundSolver.ts` implement the browser finite-strain continuum with Neo-Hookean equilibrium, objective Green-Maxwell history, tetrahedral masses, implicit vertex block descent, 120 Hz integration, augmented unilateral triangle contact, floor friction, minimum-volume protection, and explicit rejected-step/penetration/Jacobian diagnostics. Python `liver_physics.py` uses the corresponding constitutive formulation. `liverMotionCapture.ts` records actual node positions, camera pose, time, tool reaction/work, and provenance.

This is not a safe drop-in replacement for the whole scene: the solver resets by centering and dropping one cage onto a floor; the cage is an enclosing convex domain, not a conforming tetrahedralization of every anatomical organ; attachments, sliding interfaces, hollow walls, and organ–organ contact are absent. Instantiating one solver per organ would break the registered arrangement and tissue connections. Reuse it for a focused isolated-organ bench only, unless a true coupled volume/shell/attachment system is added.

## What can be learned from available evidence

`py/viscera_core/physics_learning_v2.py` and the browser port `atlasPhysicsCalibration.ts` identify E, relaxation fraction, and relaxation time from calibrated uniaxial force, displacement, and timestamps with reference length and reference area. The browser `loadPhysicsModel()` / `inferObservationLocally()` already run without an API. The ensemble proposes parameters; bounded robust physical refinement fits the exact SLS convolution; residuals, sensitivity, excitation, training-bound, and convergence gates can refuse application.

The supported observation contract is 16–257 samples, 1–12 s duration, initially tared force/zero strain, 0.5–5% peak positive strain, and sufficiently excited loading/unloading. Inference retains absolute stress/strain/time scales. It does not identify density, Poisson ratio, contact stiffness, fracture energy, capsule structure, anisotropy, nonlinear strain response, or extra relaxation times. Synthetic conformal intervals are not patient uncertainty.

From an ordinary rendered video, visible contours, occlusions, relative proportions, texture layout, camera motion, and apparent displacement/relaxation can be compared. Absolute 3D geometry and material stiffness are not uniquely identifiable without scale, camera calibration, known loads/contact geometry, boundary conditions, and occluded anatomy. For example, in a static elastic fit, multiplying both E and force by the same factor preserves displacement. A monocular apparent displacement also mixes depth and viewpoint. Time constants might be fitted from a known release sequence only conditionally on the load ending, fixed view, and the correct constitutive law. A simulator video demonstrates that simulator’s response, not measured human tissue mechanics.

Primary evidence supports keeping these distinctions:

- [Jordan et al., Constitutive Modeling of Porcine Liver in Indentation Using 3D Ultrasound Imaging](https://pmc.ncbi.nlm.nih.gov/articles/PMC2702784/) paired measured force/displacement, calibrated full-field 3D deformation, and inverse finite-element modeling. Boundary conditions and material-model selection matter. Its fitted porcine conditions should not be transferred unchanged to a human abdominal scene.
- [Analyzing Liver Surface Indentation for In Vivo Refinement of Tumor Location](https://pmc.ncbi.nlm.nih.gov/articles/PMC8058013/) used known constant force (0.588 N), a measured spherical tip, and a calibrated 3D scanner to estimate deformation/material behavior in porcine specimens. It is useful evidence for a controlled validation experiment, not evidence that unknown-force video alone yields modulus.
- [Juliar et al., Viscoelastic characterization of diabetic and non-diabetic human adipose tissue](https://pmc.ncbi.nlm.nih.gov/articles/PMC7876417/) measured frozen/thawed abdominal fat in small-strain oscillatory shear. Depot and test mode affect interpretation; diabetes did not imply a universal macroscopic stiffness increase in that study. These data do not justify assigning a single disease stiffness multiplier to all fat.
- [Kerdok et al., Effects of perfusion on the viscoelastic characteristics of liver](https://www.sciencedirect.com/science/article/pii/S0021929005003180) found different responses with perfusion state and multiple time scales during large deformation. A single fast SLS branch cannot be described as comprehensive surgical tissue mechanics.

## Concrete integration hooks for the new scene

1. Preserve world-space millimetres, semantic structure IDs, and immutable source positions. Separate baseline positions, disease-varied rest positions, and live deformed positions. Apply disease generation once; never repeatedly deform already deformed buffers. Make material/white-view changes independent of geometry/physics state.
2. Follow `WholeSceneViewport.tsx`’s `applyPhysics` transaction: validate all materials; create the candidate solver from all non-rigid parts and their current varied bounds; build every binding; then publish it atomically. On geometry changes release the instrument, rebuild bindings/contact structures, and reset physics history. Material-only swaps can follow `applyReferenceColors` and retain the current motion.
3. For ordinary organs reuse the existing accepted table only as explicitly synthetic design mechanics. For newly named structures provide a documented material-family assignment, not a fake organ fit. If adding fat/contact support, register its semantic ID, rest/variant/current geometry and bounds as an explicit soft part; provide accepted parameters with truthful provenance. Peritoneal walls should have posterior/fixed support semantics instead of moving as a free organ.
4. Reuse `WholeSceneTools` and current-surface `SceneSurfaceContact` for every force target. Include generated fat and visible walls in tool broad/narrow phases. Preserve connected-patch exclusions so a grasp on one bowel loop does not ignore all adjacent loops. Confirm a force target actually lies on the selected visible structure, rather than its bounding-box center.
5. Derive superficial vessels, membranes, and fat from the same rest coordinates or explicit anchors. The shared field preserves coincident coordinates; it does not create missing anatomical attachments. Independent per-organ scale or disease bulges can tear ducts. For localized disease, use anchored displacement fields that decay at attachment rings, and test those rings after variations.
6. Add a reproducible scene experiment recorder modeled on `LiverMotionCapture`: source/geometry hashes, material provenance, variation seed, target/actual barycentric contact, force, displacement, simulation/wall time, camera extrinsics, gradient/limit flags. Synthetic scene measurements should remain labeled as simulator observations; fitting them back into the same law is a numerical regression check, not new biological learning.
7. Keep internal inspection, rendering, and instrument state separate. Existing WholeSceneViewport deliberately pauses physics and tool interaction while in exploration mode. If the new scene allows tools from the laparoscopic camera, this exclusion must be deliberately changed and tested; simply reusing the old exploration toggle will not satisfy inside-camera interactive deformation.

## Meaningful validation matrix

- Every scene soft structure: select a nondegenerate actual triangle at several anatomically exposed sites; 3 mm push over 0.5 s, hold 2 s, release, recover 8 s. Record reaction, rendered anchor, displacement, max gradient, and finite state. Use gentler probes for narrow vessels; “3 mm” here is a test input, not a clinical prescription.
- Liver dome/edge, stomach wall, gallbladder fundus, three separate bowel loops, mesenteric sheet, omentum, perirenal fat, and cavity wall: additional lateral grasps with bounded travel. Inspect organ neighbors and attached vessels. Confirm adjacent loop contacts are not excluded by a shared organ ID.
- Capture each experiment at anterior, right/left oblique, cranial/caudal, and internal operative poses. Compare identical simulation timestamps, not random render frames; keep illumination and material seeds fixed. Check coherent bulging, no disconnected fat sliding through underlying tissue, no stretched texture coordinates, no penetration hidden by a convenient camera.
- Assertions: all positions finite; rest reset exact; contact is on rendered triangles within ≤0.05 mm; force cap respected; push never produces tensile normal force; gradient ≤0.4500001; shared attachment coordinates match; force after release is zero; residual deformation falls below 2% of held displacement after adequate recovery. Scale these tests to the authored solver and record when caps are active.
- Material sensitivity: below saturation, lower E gives larger deformation and lower reaction for the same prescribed tool path; altering relaxation time changes transient response. A prettier deformation that ignores assigned parameters is a regression.
- Determinism/time: replay 120 Hz, 60 Hz, 20 Hz and 10 Hz rendering; fixed-step states must agree. Inject 500 ms stall and verify exactly the admitted time is integrated and remaining time reported. No silent slow motion.
- Guard coverage: high-speed tip sweep, rotating shaft and articulated jaws, both-sided thin membrane, selected grasp patch beside another bowel loop, cancellation/blur/Escape, pause, white-to-textured switch, disease change during held contact, context-loss cleanup.
- If continuum cages are introduced: require positive tetrahedral Jacobians and an actual mesh/time/iteration convergence study, volume error, force–displacement/relaxation curves, penetration/complementarity, known rigid-motion invariance, and density/mass consistency. Do not use the reduced-field gradient cap as a substitute for volume/contact validation.
- Report “expert surgeon review not performed” unless an actual qualified reviewer participated. Automated geometric and visual inspection can be thorough without claiming surgeon certification.

## Audit verification performed

Ran baseline tests, without changing implementation:

```
node node_modules/vitest/vitest.mjs run \
  apps/studio/src/wholeScenePhysics.test.ts \
  apps/studio/src/wholeSceneContact.test.ts \
  apps/studio/src/fat/physics.test.ts \
  apps/studio/src/liverContinuumMaterial.test.ts \
  --pool=forks --maxWorkers=1
```

Result: 64/64 tests passed in four files. These validate existing numerical mechanics; they do not validate a not-yet-built video scene.

Implementation-path pitfall: the current `scripts/whole_scene/build_learned_materials.py`, `check_all_tool_materials.mjs`, and `check_scene_connections.py` assume a parent containing `viscera/`. In the standalone temporary clone they resolve to the wrong source/assets directory. Parameterize repository root/input/output before invoking them for the new scene. Existing all-materials coverage probes only the first valid triangle per organ and should be expanded to multiple representative surface sites.
