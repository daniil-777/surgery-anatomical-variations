# Whole-scene visual quality pass — 2026-10-08

The scene now contains **39 structures**, including the mesentery, celiac trunk, superior/inferior mesenteric and splenic arteries, and paired renal arteries and veins. All original 30 structures retain identical vertex positions and triangle indices. The new meshes preserve their source atlas coordinates; they were not moved to improve composition. All **36 soft structures** have accepted synthetic-history material estimates.

The renderer now distinguishes hepatic/renal capsules, pleural surfaces, bowel serosa, pancreatic lobules, muscular surfaces and vessel walls. A shared 1 MiB 3D texture supplies authored, scale-filtered optical detail in original rest coordinates. Revised light balance and organ-specific wetness/roughness reduce the pale plastic appearance. Selection uses a restrained contour highlight, preserving the central tissue colour for inspection.

A reproducible self-organ ambient-visibility bake adds indirect shading to bowel folds. Sixteen bounded hemisphere rays per vertex measure occlusion within 18 mm, with at most 35% indirect-diffuse attenuation. It changes no coordinates, triangles or source normals. It is static shading, not a contact solver or topology repair. Stomach render normals use corner-angle weighting; this also leaves its geometry unchanged.

**Full torso**, **Abdominal** and **Deep anatomy** presets reveal underlying anatomy. Selected organs and the structure list provide camera focus and visibility controls. The mobile focus action returns the user to the scene, with a compact selection card. PNG exports use a 4,096-pixel long edge and restore the live canvas and camera afterwards.

Static scenes render on demand. Camera input, selection, visibility, focus and geometry changes invalidate the image; moving anatomy invalidates cached shadows. Authored breathing uses matching visible/depth deformation. A shared-field interpolation optimization reduces Float32 writes while preserving the same physical model. Its synthetic 392,000-vertex CPU microbenchmark improved from 19.49 to 7.18 ms median, with maximum coordinate difference 0.0000916 mm. This is a kernel benchmark, not an end-to-end frame-rate claim.

## Verification

All **167 frontend unit tests**, TypeScript checking and the production build pass. The 12 whole-scene unit checks were repeated after the interpolation optimization. The final quality browser suite passes **7/7**. The existing suite passed 8/9 initially; its navigation screenshot helper incorrectly waited for the whole-scene element on the separate organ workspace. After correcting that test-only guard, navigation passed independently. This verifies **16 distinct browser scenarios** across the recorded runs, not one combined clean run.

The final quiet physics observation measured 46.69 rendered FPS, 5.1833 seconds of simulation over 5.2255 seconds of wall time, and 0.0335 seconds of dropped time. These are local observations at a 1282 × 1007 interactive canvas. The recorded tour encoded approximately 23 FPS; 4K resolution applies to still PNG export, not the video. [Build and test record](../benchmarks/results/whole-scene-quality-2026-10-08/build-checks.json).

## Evidence and limits

The [quality evidence directory](../benchmarks/results/whole-scene-quality-2026-10-08/) preserves matched baseline/candidate images, before/after comparisons, browser results, real exports, numerical audits and the final independent review. The original release's evidence remains unchanged in its separate directory. Asset source hashes, licenses and exact reproduction commands are in [the source record](../references/whole-scene/README.md).

The quality pass does not establish photographic realism or surgical mechanics. Bowel source components retain visible cut/cap seams and coarse facets. Cross-atlas heart/lung fitting remains approximate: a sampled containment screen detects overlap, with source open-boundary and component caveats. These surfaces were not shifted to conceal the defect. The reduced-order physics model still lacks resolved organ contact/sliding, pressure, surgical interaction and calibration against human tissue. Richer materials and stable video do not validate those mechanisms.
