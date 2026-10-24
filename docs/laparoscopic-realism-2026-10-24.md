# Laparoscopic Import 3D: research, implementation and visual review

Date: 2026-10-24. Scope: `apps/studio/src/imports`, the existing BodyParts3D scene loader, generated disease morphology, materials, viewport illumination and GLB export compatibility.

The import viewer now has distinct surface disease operators, finer connected vascular detail, smoother atlas surfaces and camera-attached illumination. Three visual refinement passes were compared with the previous renderer, followed by another seed/intensity and export checks. This is an improved procedural anatomical visualization. It does **not** yet reproduce the full appearance of an operative field or establish conference-level/clinical realism by validation.

## Research and actual image inspection

The research addressed four questions: which disease changes are visible on an intact external surface; which shape and appearance changes must share a location; what differentiates wet capsule, serosa, fat and scar; and which rendering/export constraints currently prevent those distinctions.

- [Hepatobiliary evidence and image observations](research/laparoscopic-2026-10-24/hepatobiliary.md): nine publications, liver nodularity/steatosis/masses/cysts, gallbladder inflammation and image licensing.
- [Pancreas, bowel, spleen and kidney evidence](research/laparoscopic-2026-10-24/abdominal-disease.md): primary gross/surgical observations, external versus mucosal/cut-surface distinctions, four deep reads and inspected figures.
- [Code and graphics audit](research/laparoscopic-2026-10-24/rendering-audit.md): original code findings, five primary graphics sources and verification priorities. Its line numbers describe the pre-change implementation.

Actual reference images were inspected, not just image-search descriptions. The [official Endoscapes example sheet](https://github.com/CAMMA-public/Endoscapes/blob/main/endoscapes_examples.png) shows fine serosal vessels, localized wet glints and dark tissue recesses; segmentation overlays obscure some regions, so its colors were not treated as measured reflectance. [CAMMA's dataset page](https://camma.unistra.fr/datasets/) identifies Cholec80 as CC BY-NC-SA 4.0; public access is not an unrestricted asset license. The example sheet is retained only in the local research-artifact folder.

The freely accessible operative photographs in [Sugrue et al., Figures 2–5, CC BY 4.0](https://link.springer.com/article/10.1186/s13017-015-0005-x) were inspected from the PDF. They show pale blue-grey gallbladder, dark smooth liver, variable-caliber vessels, and thin adhesions extending into irregular yellow fat. [Tiutiuca et al., Figures 4–5](https://pmc.ncbi.nlm.nih.gov/articles/PMC10817520/) show a smooth pale cyst roof with superficial vessels and fat around its shoulders. Figure context and permissions are recorded in the research reports. Restricted figures were studied as references; none was embedded in the application or used as a photographic texture.

The geometric/optical parameters in the implementation are authored inferences. These papers do not provide calibrated RGB, roughness values or population distributions for this generator.

## Implemented changes

### Surface morphology

`surfacePhenotypes.ts` replaces the generic repeated spherical displacement field. It builds a seam-welded adjacency graph for traversal without modifying source connectivity, then uses bounded edge-geodesic distances for focal support. Nearby disconnected bowel surfaces no longer receive the same lesion merely because they are close in Euclidean space. Geometry and pigmentation use the same rest-surface masks.

- Cirrhotic variants use many unequal small surface nodules instead of a universal minimum radius of 11% of the organ diagonal. The capsule no longer acquires a dense artificial cracked-cell texture.
- Steatotic enlargement uses diffuse fullness and mottled pallor; it no longer adds large external fat weights to the liver material.
- Cysts use smooth blended domes with a restrained pale apex and retained host tissue around the shoulders.
- Metastases use unequal surface sites with shallow central umbilication.
- Healed infarct support has an asymmetric shallow scar envelope. This is an approximate surface territory, not a reconstructed vascular territory.
- Crohn-associated external changes remain surface-confined and have restrained contour displacement. Mucosal cobblestoning is not added to intact serosa. A bowel centerline, wall lumen and true mesentery-connected creeping fat are still absent.
- Chronic pancreatic contraction/fibrosis remains distinct from diffuse swelling; kidney cancer coloration no longer borrows a bright cut-surface tumor appearance.
- Disease severity and shape strength have continuous zero endpoints. Surface displacement directions use world-transformed normals, including rotated/nonuniformly scaled uploads.

The graph metric is an edge-distance approximation. Very coarse uploaded meshes still limit small-lesion fidelity; exactly coincident disconnected surfaces can be joined by the seam-weld heuristic. Preset bowel/pancreas meshes receive additional subdivision and controlled fairing; arbitrary uploads are not automatically remeshed.

### Appearance and illumination

Connected vessel trees now have finer caliber, softer contrast and trunks that emerge gradually beneath the capsule. Liver and spleen vessel visibility remains restrained even with nodular pathology. Continuous periodic noise supplies subtle tissue mottling and wet-film variation, replacing prominent polygonal cell boundaries. The external capsule palette is separated from the learned recipe's internal tissue patterns. Mesentery receives a separate warm fat/membrane color.

Single-organ and multi-organ paths share the same PBR optical settings. Cloth sheen is removed from generated capsule material. Clearcoat uses the generated normal detail and a scalar film roughness; base roughness remains spatially varied. The scalar film value avoids redundant per-material packed images that would exceed the importer's image budget.

`surgicalLighting.ts` supplies a camera-attached spotlight, restrained ambient fill and inter-surface shadows. The old room environment's rectangular studio reflections are removed. Light intensity is normalized to camera distance to support arbitrary upload units; this is **not** radiometric calibration. The camera-light placement is motivated by [EndoPBR](https://arxiv.org/abs/2502.20669), whose reported colonoscopy setting is not a direct calibration of abdominal laparoscopy.

### Correctness and interoperability

The clearance search now covers the full neighboring-cell range of its threshold. Scene variations reject collapsed source triangles. Original-UV tangents are rebuilt after pathology changes surface normals. UI/report wording no longer promises collision-free anatomical contact or claims that the analytic warp's Jacobian covers every local change.

Original imported resources remain retained for reset. Geometry connectivity is unchanged during variation; preset refinement occurs during scene loading. Export uses ordinary glTF material channels and geometry, with no viewport-only shader needed to see the generated tissue detail.

## Visual iterations

All captures use actual atlas meshes and production variation functions. No generated image, postprocessing, retouching or reference-photo compositing was used.

| Pass | Observed problem | Change and outcome |
| --- | --- | --- |
| [Baseline](../artifacts/laparoscopic-2026-10-24/baseline/) | Healthy liver showed visible cell borders; cirrhosis resembled cracked leather; gallbladder was saturated green. Broad room reflections dominated. | Established fixed-camera seed-42 comparisons for healthy liver, cirrhosis, steatosis, metastases, inflammation, chronic pancreatic disease and Crohn-associated changes. |
| [Iteration 1](../artifacts/laparoscopic-2026-10-24/iteration-1-complete/) | New nodules were distinguishable, but vessels remained too bold; highlights exposed facets; bowel swelling was too focal. | Added geodesic phenotypes and scope illumination; identified the next corrections from rendered views. An earlier partial capture was interrupted by Vite dependency refresh and is not used as complete evidence. |
| [Iteration 2](../artifacts/laparoscopic-2026-10-24/iteration-2/) | Smaller vessels and smoother geometry helped, but material color remained overly red and capsule detail too uniform. | Refined bowel/pancreas geometry, reduced vessel scale and cell-edge relief. A separate normal/shadow/material diagnostic isolated material effects. |
| [Iteration 3](../artifacts/laparoscopic-2026-10-24/iteration-3/) | More coherent capsule color and wetness; remaining atlas-layout and projection limitations visible in full scenes. | Added continuous fine detail, external palettes, shared optics and restrained Crohn contour changes. Inspected anterior, subhepatic and posterior full-scene views. |
| [Export review](../artifacts/laparoscopic-2026-10-24/verified-final/) | Extra clearcoat roughness images initially caused the full-scene import preflight to reject the generated GLB. | Removed redundant film-roughness images; retained clearcoat normals. Diseased-organ channels and full scene now roundtrip successfully. |
| [Mild seed 43](../artifacts/laparoscopic-2026-10-24/mild-seed43/) | Checks variation beyond one severe sample. | Captures healthy, cirrhotic, fatty, metastatic and cystic liver cases at mild intensity. Opposite-side views are in [oblique disease review](../artifacts/laparoscopic-2026-10-24/oblique-disease-review/). |

The final recorded cases include source SHA-256 values and recipes in `receipt.json`. The subsequent original-UV tangent correction does not change these synthesized-UV captures and is covered by a regression test.

Quick comparisons: [old cirrhosis](../artifacts/laparoscopic-2026-10-24/baseline/liver-cirrhosis.png), [revised cirrhosis](../artifacts/laparoscopic-2026-10-24/verified-final/liver-cirrhosis.png); [old gallbladder](../artifacts/laparoscopic-2026-10-24/baseline/gallbladder-cholecystitis.png), [revised gallbladder](../artifacts/laparoscopic-2026-10-24/iteration-3/gallbladder-cholecystitis.png); [full posterior scene](../artifacts/laparoscopic-2026-10-24/verified-final/scene-posterior.png).

## Verification

- Imports unit suite: **92 tests passed**. Covers deterministic generation, source/reset retention, transformed upload equivalence, disconnected surface confinement, coincident contact vertices, continuous zero strengths, original-UV tangent orthogonality, noise continuity, vascular connectivity and material/export constraints.
- Studio TypeScript check and normal production Vite configuration build. The temporary preview configuration bypasses an existing development Babel dependency issue; production uses the application's normal plugins. The production build retains existing large-chunk warnings.
- Browser test `generated tissue maps survive GLB export and reimport`: passed with exact decoded base color, normal and roughness pixels.
- Actual cystic liver GLB: **11,580,720 bytes**, 129,098 vertices and 258,192 triangles. Export/reimport maximum error **0** for positions, normals, UVs, vertex colors and tangents, and **0** for decoded base color, normal, roughness and clearcoat-normal channels.
- Actual complete scene GLB: **60,070,224 bytes**, 24 meshes/materials, 568,364 vertices, 1,136,289 triangles and 52 imported textures, below the 64-image/texture import limit. The live scene shares 42 maps. Full export plus reimport took approximately 1.62 seconds in the captured local run; this is not a generation or frame-rate benchmark.
- Actual Import 3D UI opened the 24-structure preset and displayed its generated result. The export-review browser receipt recorded no page errors.

Reproduce from `viscera/` with the local preview on port 5176:

```sh
node node_modules/vitest/vitest.mjs run apps/studio/src/imports --pool=forks --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
node node_modules/vite/bin/vite.js build --config .laparoscopic-build.config.mjs
REVIEW_CASES=liver REVIEW_SCOPE=1 REVIEW_SCENE=1 REVIEW_EXPORT=1 REVIEW_OUTPUT=artifacts/laparoscopic-new-review node scripts/laparoscopic_realism_review.mjs
```

The review script refuses to overwrite a nonempty capture directory. Use a new directory for each run. It currently uses the installed macOS Chrome executable.

## Remaining realism limits

The source remains an exposed atlas assembly, with incomplete surrounding fat, peritoneum, attachment membranes and operative retraction. Distension does not reconstruct a wall lumen; advanced inflammatory adhesions and true creeping fat have not been generated. Fine vascular texture is authored and periodically projected, not anatomically registered vascular reconstruction. The retained oblique planar UV projection can stretch on steep faces; a true exportable surface atlas remains necessary to remove that limitation. Texture detail is 512² per map. Full inter-organ/self-intersection detection is not implemented, and sampled contact damping is only a heuristic.

These limits are visible in the screenshots. An anatomist/surgeon review and a blinded comparison against appropriately licensed surgical footage are still needed before claiming surgical-conference benchmark performance, clinical fidelity or training validity.
