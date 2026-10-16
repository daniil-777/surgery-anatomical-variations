# Whole-scene anatomy and learned material preview

The **Whole scene** workspace (`?mode=scene`) assembles the thorax, abdomen and pelvis, with 39 named structures. It includes the stomach, liver, gallbladder, pancreas, spleen, bowel, kidneys, bladder, ureters, airways, heart, lungs, principal vessels, biliary routes, diaphragm, mesentery, ribs, spine and pelvis. The expanded arterial and venous anatomy includes the celiac trunk, mesenteric and splenic arteries, and paired renal arteries and veins.

Use **Joint scene variation** to change shape, colour/material and synthetic disease appearance across the assembly. **Replay seed** reproduces the selected seed and slider settings; **Restore atlas** restores the baseline geometry/material. Six anatomical camera presets, a continuous camera tour, PNG capture and 12-second WebM recording are available. Full torso, Abdominal and Deep anatomy presets, category toggles and individual Hide/Show controls reveal deeper anatomy without moving it out of place. Selecting an organ exposes close-up camera focus; the structure list also provides direct focus controls on mobile. PNG images export at a 4,096-pixel long edge and restore the live viewport afterwards.

## Anatomy, references and rendering

BodyParts3D abdominal organs and connection surfaces retain their shared coordinate frame: +X patient left, +Y superior and +Z anterior. The displayed millimetre scale is an explicit source-unit assumption. Heart/lung exterior surfaces come from the Human Reference Atlas and are approximately fitted to the thoracic atlas envelope; they are not certified same-subject registrations. A sampled containment screen detects some fitted heart/lung overlap; the diagnostic is recorded in the quality evidence and does not certify intersection volume or clinical fit. Bone/support layers are translucent and can be toggled.

The renderer uses organ-specific capsule, pleural, serosal, muscular and vascular display materials, a shared 3D tissue texture anchored to original atlas coordinates, scale-filtered pigment/micro-normal fields, environment lighting and soft-tissue shadows. The capsule and pleural surfaces use different roughness, pigment and wet-coat profiles. Selection highlights the contour without washing out the tissue colour. These are authored appearances, not measured optical tissue properties. A bounded, self-organ ambient-visibility bake adds depth in bowel folds; it attenuates only indirect diffuse light by at most 35%, does not change any mesh coordinates and does not model changing inter-organ contact. Stomach normals use corner-angle weighting to reduce sensitivity to uneven triangle size. Static views render only when changed; moving geometry updates the cached shadows, and authored breathing uses the same deformation in its visible and depth shaders. Coincident source vertices are welded for smoother shading; this does not repair all source topology. The liver uses a derived outer display envelope: a 1 mm voxel reconstruction, smoothed signed-distance field and surface smoothing remove the source segmentation seams. Its sampled candidate-to-source triangle distance is 0.821 mm at the 95th percentile and 2.143 mm maximum; bounding-box drift is below 0.976 mm. These are one-direction sampled comparisons, not a symmetric exterior Hausdorff guarantee: source interior sheets were removed. The original segments and rejected candidates remain preserved. Detailed modification provenance is recorded in the bundled manifest.

[Sources and comparison rubric](../references/whole-scene/README.md) retain the publisher URLs, credits, licenses and exact local reference images. The in-app reference desk includes OpenStax's 2013 accessory-organ image (CC BY 3.0), separate BodyParts3D and Human Reference Atlas credits (CC BY 4.0), and the full model manifest. Source image/model licenses remain separate from application code.

Every shape variant uses one smooth invertible spatial map, including ducts and vessels. Coincident attachment points remain coincident; independent organ recentering/scaling is not used. This preserves source spatial relations but does not prove physiological lumen continuity, population realism or collision-free cross-atlas fitting. Disease appearance is a synthetic patchy congestion/inflammation design, not a diagnosis or a trained whole-patient pathology distribution.

## Apply learned physics to all organs

The button loads an atomic material assignment for all **36 soft structures**. The three skeletal structures remain fixed supports. The existing V2 neural inverse standard-linear-solid ensemble proposes elastic modulus, relaxation fraction and relaxation time from explicitly synthetic, category-dependent design histories; bounded physical refinement and the existing application checks are retained. This reuses trained weights rather than misrepresenting extra synthetic samples as measured multi-organ training.

Model SHA-256: `949e8725e5839eaaa73d6e33e9cbe179ad75614231cd9fb92e2e290f6b48476e`.

All 36 synthetic fits were accepted. A different 101-sample strain waveform per organ gives worst stress NRMSE **0.0006503 (0.0650%)**, below the declared 2% synthetic response check. This measures agreement with the synthetic constitutive response, not human tissue accuracy. Density is an authored assumption; confidence intervals remain synthetic and marginal.

Motion uses a coupled reduced-order viscoelastic model integrated implicitly at 120 Hz. Each soft structure contributes a material-dependent mode; local mode coupling and a shared trilinear displacement lattice deform the displayed surfaces. Continuous shared interpolation preserves coincident attachments. An explicit displacement-gradient limit protects orientation of this shared motion field; it is not a contact solver. Physics advances independently from the 20 Hz surface upload schedule. Long-frame time loss, stabilization, material assignments and actual rendered vertex samples are recorded in diagnostics.

**Breathing** applies authored respiratory loading. **Palpate selected organ** applies a short modal force to the selected soft structure (liver by default). **Pause physics**, **Reset motion** and **Remove physics** control the experiment. Material application is all-or-nothing, and geometry variants reset/rebind the physics state. Joint disease appearance does not infer additional disease-dependent tissue parameters.

The [laparoscopic instrument extension](WHOLE_SCENE_INSTRUMENTS.md) adds surface picking, a blunt palpator, a fenestrated grasper, local viscoelastic deformation, depth controls and fixed-camera interaction recording. Tool contact uses the displayed triangles with separate tip, articulated jaw and shaft guards; a grasp retains its material attachment through deformation.

This is a working material-driven mechanical preview, not a validated surgical simulator. It does not resolve organ-to-organ contact/sliding, hollow-organ pressure and walls, blood flow, ligament anatomy, cutting or patient-specific tissue mechanics. No surgeon review or human-tissue measurement is claimed. A smooth, finite video does not establish these missing mechanisms.

## Initial delivery verification and evidence

The following records the first 30-structure release. The subsequent 39-structure quality pass retains separate evidence in [whole-scene-quality-2026-10-08](../benchmarks/results/whole-scene-quality-2026-10-08/).

- Full Studio TypeScript check and production build pass.
- All 167 frontend unit tests pass, including 12 new whole-scene tests. New checks cover variation replay, all-organ geometry/material changes, positive shared-map Jacobians, coincident-point preservation, invalid/incomplete material rejection, stiffness-dependent deformation, time-step replay, equilibrium, load/recovery, reset and repeated forcing.
- All **9 real-browser cases pass**, with no browser errors or HTTP failures. Two targeted mobile/footer and workspace-navigation cases also pass after the final mobile layout correction. They cover six named camera views plus an inferior inspection, per-organ cutaways, 12 successive joint samples, replay/reset, disease controls, PNG/WebM exports, mobile scrolling/navigation, all 27 material assignments, actual rendered deformation, pause, pulse/recovery, reset and removal. A warmed 5.232-second local Chrome interval recorded 47.4 FPS and a simulation/wall-clock ratio of 1.0003, with 0.0001 seconds of dropped time. These are local observations, not target-device guarantees.
- Real-browser verification and video findings: [evidence directory](../benchmarks/results/whole-scene-2026-10-08/), [reference review](../benchmarks/results/whole-scene-2026-10-08/reference-review.md), [physics review](../benchmarks/results/whole-scene-2026-10-08/physics-review.md). Final browser verdict is recorded in that directory; historical development failures are not anatomy-validation passes.

Reproduce frontend checks from `viscera`:

```sh
pnpm typecheck
pnpm test
pnpm build
VISCERA_WHOLE_SCENE_BROWSER=chrome pnpm exec playwright test --config playwright.whole-scene.config.ts
```

Asset/inference scripts are in `scripts/whole_scene/`. The static scene and learned material table are bundled in `apps/studio/public/anatomy-scene/`; scene operation needs no running generation API. The original single-organ workspace still uses its API.

Local verification required restoring iCloud-placeholder JavaScript dependencies. Fresh dependencies were installed from the unchanged workspace `package.json`; prior dependency directories are retained in ignored `node_modules/.before-scene-*` backups. No lockfile or trained model activation was changed.
