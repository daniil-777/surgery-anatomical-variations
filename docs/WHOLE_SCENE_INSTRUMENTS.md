# Whole-scene laparoscopic interaction

Open **Whole scene**, then **Apply learned physics to all organs**. The scene toolbar provides **Camera**, **Push** and **Grasp** modes. The instruments act on the visible, deformed triangles of the atlas surfaces. The three skeletal structures remain fixed.

## Controls

1. Rotate or focus the body to expose the intended surface. Use a dissection preset or hide an overlying structure when necessary.
2. Choose **Push** for the blunt palpator or **Grasp** for the fenestrated grasper. Click a visible soft-organ surface to attach, then move the pointer; click again or press Escape to release. Holding and dragging also works, with release on mouse-up. Touch continues to use hold-and-drag. Camera orbit is suspended during manipulation.
3. Adjust insertion depth with the wheel, **Move deeper / Withdraw**, or Page Up / Page Down. The instrument settings also provide a probe tip radius and initial push depth. Grasper jaw dimensions are fixed.
4. Release a held drag, click again after a click attachment, or press Escape to release the tissue and observe recovery. Keyboard users can focus the canvas, press Enter to engage at the view centre, use the arrow keys to move, and press Enter or Escape to release.
5. **Record interaction** exports a 20-second WebM with a fixed camera and live instrument control. **Record tour** remains a separate orbit recording.

In **Push** mode, enable **Continuous push** in the scene toolbar to keep pressing without moving the pointer. Hold the primary mouse or trackpad button on a visible soft surface; release it to stop loading and observe recovery. **Push speed** in the instrument settings controls the advance from 0.5–5 mm/s (default 3 mm/s). The toolbar shows the current depth. The probe stops advancing at the existing 20 mm depth limit or a collision obstruction; while held at the limit it maintains the accepted target. This advances a displacement-controlled probe, so reaction force varies with the material response rather than remaining at a prescribed force. Even a short click releases in this mode; disabling the option restores click-to-attach behavior.

Changing anatomy or visible layers, pausing or removing physics, resetting motion, or changing interaction mode invalidates the active attachment. Contact does not change the saved atlas shape, material assignment or variation seed.

## Geometry and mechanical scope

Surface picks retain the hit triangle and barycentric coordinates. A grasp follows that material attachment as the mesh deforms. Push applies unilateral normal loading; withdrawing the probe must not pull tissue. Requested motion, the displayed contact point, estimated reaction and target residual are separate quantities. An amber marker and line show a requested position that the tissue cannot fully follow. A motion limit or blocked approach is not a successful command to the requested position.

Hover previews a surface cursor. The full instrument is shown only during accepted contact, then hidden on release so the recovery remains visible. A blocked approach never displays an unchecked rigid instrument through the anatomy. This interaction uses one instrument at a time.

The contact accelerator refits triangle bounds to the current surface. Sphere sweeps test faces, edges and vertices. Separate articulated capsule guards cover each jaw, the clevis, shaft and proximal taper. This preserves the open space between the jaws instead of filling it with a single wide capsule. A rotating capsule that starts in separating contact uses a sphere-cover fallback so its opposite end cannot silently cross the same triangle later in the sweep; the conservative stop is reported. These are conservative geometric envelopes around generic instruments; the handles and rotation collars are excluded. Finite-radius tools cannot access every occluded point from every camera angle. Hidden dissection layers are deliberately excluded from tool collision.

Continuous requested instrument sweeps are evaluated against the current refitted surface. Tissue motion and jaw closure are checked at discrete displayed poses; this is not continuous space-time collision detection between deforming triangles and rotating metal surfaces. Geometric overlap and conservative stops therefore remain observable diagnostics.

Local, material-dependent viscoelastic deformation is added to the shared whole-scene displacement field. Nearby soft structures therefore respond together, and coincident reference coordinates use the same deformation. The local response recovers after release. Bounded motion and a displacement-gradient guard restrict this reduced-order preview. It does not solve organ-to-organ contact, self-contact, contact pressure, frictional jaw capture, tissue damage, hollow-organ pressure, pneumoperitoneum or trocar constraints. The existing synthetic inverse-material estimates are reused; no new human-tissue training or calibration is implied.

The source geometry includes open components and approximate cross-atlas thoracic fits. Two-sided triangle contact avoids assuming these meshes are watertight. Tests can establish picking, numerical stability and geometric tolerances in specified cases; they cannot establish perfect collision detection or surgical validity.

Physics uses fixed 120 Hz steps and admits up to 100 ms per rendered frame. Longer stalls report discarded time. Local attachment forces refresh their projected field at every physics step, so rendering at 75–100 ms intervals reproduces the tested held/released push and grasp trajectories at 120 Hz exactly. Displayed geometry and collision refits remain separate from that solver cadence.

## Instrument references

The procedural models use insulated shafts, articulated fenestrated jaws, a rotation collar and a pistol-style handle. Professional design references include the [KARL STORZ CLICKLINE 33423AF](https://www.karlstorz.com/us/en/product-detail-page.htm?cat=1000209314&productID=1000125035), specified with a 5 mm shaft and 43 cm working length, and the [Aesculap laparoscopic instrument catalogue](https://www.aesculapusa.com/content/dam/aesculap-us/us/website/aesculap-inc/healthcareprofessionals/or-soultions/pdfs/24-0046%20Laparoscopic%20Catalog.pdf), which includes 5 mm fenestrated graspers. The rendered shaft is shortened to 240 mm for the scene. These are generic authored visuals, not manufacturer CAD, endorsements or validated device replicas.

## Verification

The [independent evaluation contract](../benchmarks/results/whole-scene-tools-2026-10-08/EVALUATION-CONTRACT.md) separates real pointer/touch/keyboard interaction, rendered-triangle witnesses, fast contact queries, numerical mechanics and sampled video review. New evidence is retained in [whole-scene-tools-2026-10-08](../benchmarks/results/whole-scene-tools-2026-10-08/); earlier scene-quality evidence remains historical.

The full frontend suite passes **240 checks in 28 files**, including contact, material response, instrument envelopes and broad-phase bounds. TypeScript checking and the production build pass. A separate [actual-atlas material check](../benchmarks/results/whole-scene-tools-2026-10-08/all-soft-structure-contact.json) applies a 3 mm push at a real triangle of each of the 36 soft structures: all responses are finite, displacement ranges from 2.037 to 2.772 mm, and the worst rendered barycentric attachment discrepancy is 0.00000701 mm. These are numerical coverage results, not measured tissue agreement.

The [instrument-envelope audit](../benchmarks/results/whole-scene-tools-2026-10-08/instrument-envelope-triangles.json) verifies **48,064 triangle/pose combinations** across five jaw closures and three probe radii. Every tested working-metal triangle fits in a single convex guard capsule, with zero escaping triangles. Handles and collars are explicitly excluded. Earlier envelope gaps at the closed jaw, clevis and shaft details were corrected; earlier broad open-jaw false obstructions are retained in development evidence. This spatial containment check does not certify continuous motion between the sampled poses.

Median-partition BVH construction reduces the measured total build time for the bundled 784,624 triangles from 2.63 seconds to 0.558 seconds on the local machine. Runtime contact builds/refits only needed surfaces. The [contact-method record](../benchmarks/results/whole-scene-tools-2026-10-08/CONTACT-SCOPE.md) distinguishes these CPU timings from browser frame rates and records the force, displacement and gradient limits.

Browser verification uses a fixed production build after an unrelated reference-colour hot reload interrupted a development-server run. [Bundle, asset and source-map hashes](../benchmarks/results/whole-scene-tools-2026-10-08/production-build.json) identify the tested implementation. Only unrelated optional reference-segmentation availability is stubbed in those browser tests; scene geometry, learned material data, rendering, instrument contact and video encoding are real.

On the final build, a held-contact interval with 39 loaded / 36 visible structures rendered at **37.15 FPS**, with a **0.9951 simulation/wall-time ratio**. An unengaged Grasp-mode interval rendered at **30.17 FPS** but advanced physics at only **0.7126 of wall time**. These local samples show remaining stalls; this is not a general real-time performance guarantee. The fixed-step numerical tests and browser timing measure different properties.

**Eight distinct browser scenarios pass on the final build**, covering availability, grasp, push/withdrawal, keyboard/pointer handoff and interruptions, multiple/deformed surface picks, obstruction and fixed bones, camera-tour export, and native mobile touch. One final test needed a locator-only correction because the same status appeared in two panels; its original failure and targeted passing rerun remain preserved. The earlier candidate demonstrated a reachable surface on each of 36 soft structures; that longer browser matrix was not rerun on the final build. Current numerical material coverage still includes all 36.

Actual [grasp](../benchmarks/results/whole-scene-tools-2026-10-08/final/grasp-interaction.webm) and [probe](../benchmarks/results/whole-scene-tools-2026-10-08/final/probe-interaction.webm) recordings were decoded and sampled. They show a fixed camera, visible tool contact, smooth nonrigid displacement and recovery. Encoded rates were about 11.46 and 10.76 FPS, respectively; recording cadence is lower than the unrecorded held-scene sample. The images do not establish a physically pinched tissue fold or calibrated force response.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test --config playwright.whole-scene-tools.config.ts
```
