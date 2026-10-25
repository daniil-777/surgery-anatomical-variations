# Video-referenced hepatocystic scene

Open `?mode=scene&scene=virtamed`, or choose **VirtaMed scene** in Import 3D. The scene opens in white. **Apply learned textures** changes materials without replacing geometry or resetting active mechanics. **Video camera · instruments enabled** returns to the operative framing while retaining push/grasp interaction. The white GLB is downloadable and independently importable.

## Evidence and scope

The supplied `Full.mp4` is 13:07.77 at 1920×1080/60 fps. The review covered 53 timeline samples, nine original-resolution frames, and the traction intervals around 06:26–06:35 and 11:58–12:05. The reconstruction targets the intact 00:08–00:15 hepatocystic field. Later cautery marks were not treated as baseline anatomy or disease.

This is an independently authored approximation of visible silhouettes and overlaps, not extracted simulator geometry, an exact 3D recovery, or a full abdominal survey. The identity of partly visible pink visceral surfaces, hidden surfaces, anatomical scale and boundary conditions require assumptions. No source-video pixels, simulator assets or logos are embedded in the GLB.

Appearance research inspected actual DSAD, CholecSeg8k and Endoscapes fields. DSAD informed capsule continuity, connected adipose tissue, membrane coverage, embedded vessels and wet highlights. Restricted CholecSeg8k/Endoscapes images were used for visual research only and were not added to the public assets. Details and primary links are in [the surgical appearance audit](research/virtamed/surgical-appearance.md), [video audit](research/virtamed/video-anatomy.md), and [mechanics audit](research/virtamed/physics-audit.md).

## Implementation

- Twelve named surfaces: liver, gallbladder, separate cystic/common bile ducts and cystic artery, partly visible bowel/duodenal approximations, a connected fatty apron, two ligament/membrane sheets and posterior cavity support.
- Smooth implicit unions join the liver lobes and adipose tissue; transported lofts form the gallbladder, ducts and bowel. Fairing removes marching-grid shading. The shipped GLB is compared against the generating code and checked against a SHA-256 manifest at load time.
- Liver and bowel use checksum-verified learned RGB tiles from the existing library. Four surfaces use three learned tissue families. They are 512 px previews; derived normals and authored roughness are not measured human optics. Gallbladder, fat, vessels, wall and membrane optics remain authored.
- Rest-space triplanar texture coordinates remain attached under deformation. A camera-mounted light supplies the operative view; white geometry remains available independently.
- Generative Model 2 supplies organ-conditioned shape/material recipes. A common spatial deformation field preserves coincident attachment coordinates. Five illustrative phenotypes couple shape and pigment: gallbladder inflammation/distension, fatty liver enlargement, nodular/fibrotic liver, and focal hepatic lesions. Seed replay is deterministic. These are visual phenotype studies, not diagnoses or validated disease mechanics.
- Eleven tissues accept distinct synthetic inverse-fit viscoelastic parameters and real triangle instrument anchors. The cavity wall is fixed and cannot be palpated. Fat is a directly interactive scene part, not only a passive visual overlay.

## Mechanics evidence

The existing browser inverse estimator fitted noisy synthetic ramp–hold–release histories. Independent sinusoidal protocols supplied 36 held-out waveforms. The maximum held-out stress NRMSE was **0.0504% of waveform peak**; the maximum target-parameter recovery error was **0.967%**. Both values describe synthetic recovery, not agreement with biological tissue. The procedure reproduced its artifacts byte-for-byte.

| Structure | Fitted E, kPa | Relaxation fraction | Relaxation time, s |
|---|---:|---:|---:|
| Liver | 4.206 | 0.401 | 0.697 |
| Gallbladder | 2.799 | 0.440 | 0.849 |
| Cystic duct | 6.793 | 0.269 | 0.525 |
| Extrahepatic bile duct | 7.202 | 0.260 | 0.491 |
| Cystic artery | 9.018 | 0.281 | 0.426 |
| Colon approximation | 4.807 | 0.401 | 0.748 |
| Foreground bowel | 3.500 | 0.450 | 0.799 |
| Duodenal approximation | 4.298 | 0.400 | 0.701 |
| Fatty apron | 2.202 | 0.550 | 1.198 |
| Hepatocystic membrane | 11.997 | 0.220 | 0.504 |
| Cranial ligament | 9.509 | 0.250 | 0.597 |
| Cavity wall, held fixed | 17.491 | 0.200 | 0.399 |

The source video contains no calibrated force, camera or scale. It therefore supplies no absolute stiffness calibration. Coupled reduced-order mechanics do not resolve full organ contact/sliding, cutting, tearing, lumen pressure, anisotropy or surgical FEM. No surgeon qualification, blinded surgeon assessment or clinical validation is claimed.

## Inspection and verification

Seven recorded review passes retained intermediate failures. Revisions addressed a narrow fatty rope, excessive regular bowel folds, strong hepatic texture, studio lighting, overexposed duct/membrane ends, gallbladder foreshortening, surface faceting and camera/contact test points covered by UI. Instrument guards remained enabled; blocked paths were approached from another visible triangle.

The final review captured 28 views/states and nine push/grasp/release trials across three camera angles on liver, gallbladder and fat. All force states remained finite. Observed maximum estimated reaction was 0.0651 N, tip overlap 0.00154 mm and rendered-anchor discrepancy 0.000790 mm for these particular modest loads; these values are numerical checks, not surgical safety limits. The recording is 1600×1100, 69.6 s, encoded at 25 fps. Actual render-frame counters and timestamps are retained separately; encoded cadence is not a rendering benchmark.

Verification also covered 182 distinct unit cases across the affected regression suites, four new browser cases (material-only switching, physics, GLB import/export, corrupted-asset rejection and narrow layout), and 17 existing model/UI regression cases. The deployment smoke suite now explicitly includes this scene alongside the existing atlas, physics, whole-scene, legacy and texture workflows.

Reproduce assets with `node scripts/build_virtamed_scene.mjs`. Reproduce synthetic calibration with `node scripts/whole_scene/build_virtamed_materials.mjs --repo . --out /tmp/virtamed-calibration`. Run `node scripts/virtamed_review.mjs` against the production preview; `REVIEW_URL` and `REVIEW_OUTPUT` select its endpoint and evidence directory.
