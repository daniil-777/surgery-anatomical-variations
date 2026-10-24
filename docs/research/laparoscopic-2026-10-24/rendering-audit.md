# Laparoscopic Import 3D rendering audit

Date: 2026-10-24. Scope: source inspection of the current Three.js Import 3D pipeline and five primary graphics/surgical-rendering sources. This report records the code before implementation of this iteration; line numbers may move. No source files were changed by this audit. Findings below are code-derived, not the result of a surgeon validation study or measured GPU benchmark.

## Highest impact changes

1. **Make disease morphology genuinely profile-specific.** The common 11–16% bounding-box-diagonal lesion radius floor erases small-lesion distinctions. Replace it with profile-level radii, surface-attached footprints, and explicit nodular, cystic, retractile, diffuse, and segmental behaviors. Share one lesion mask between displacement and appearance.
2. **Correct the capture model.** Add a camera-attached scope light, lower ambient illumination, and real contact shadows. Preserve an overview camera for anatomical review. Current fixed studio lights and bright room reflections are a substantial source of plastic appearance.
3. **Correct deformation validity and normal transforms before strengthening geometry.** Local pathology and relief are excluded from the reported Jacobian; imported-mesh normals are sometimes applied in the wrong coordinate frame. Contact protection is a heuristic, not a collision guarantee.
4. **Improve tissue hierarchy, not simply noise strength.** Smooth capsule, sparse subserosal vessels, irregular mesenteric fat, organ-specific lobulation, and correlated lesion pigmentation need different spatial supports. Current vascular and Worley detail is one repeated 2D field.
5. **Inspect the same seed and views at least three times.** Use before/after baseline, focused disease, and alternate seed/camera comparisons; export/reimport the final variant. Current tests establish array changes and map presence, not visual realism.

## Existing strengths to preserve

- Recipes retain honest provenance (`meshEncoding: false`, `diseaseInference: false`) and source data remains immutable. Pending resources publish atomically and are disposed on cancellation/failure in `variations.ts:1012–1040, 1278–1311, 2053–2099`.
- Co-registered BodyParts3D geometry is loaded into a shared coordinate frame. Separate arterial and venous meshes survive import (`laparoscopicScene.ts:434–515`). Support structures are excluded from organ disease sampling (`variations.ts:1675–1688`).
- Vascular raster trees taper and join, including across tile borders. PBR channel color spaces are correct: sRGB base color and linear normal/roughness maps (`tissueDetail.ts:21–89`; `variations.ts:847–862`).
- The GLB export path clones resources and converts byte RGBA DataTextures to canvas-backed textures without changing the live viewer (`importModel.ts:232–282`). Continue to test this path after any material changes.

## Precise findings

### Disease shape and color are insufficiently differentiated

**P0 — all positive lesions have a large shared minimum footprint.** `buildImportedDiseaseField` sets `minAnatomicalRadius = diagonal * 0.11` (positive) or `0.16` (negative), then takes the maximum with the profile-specific radius (`variations.ts:923–925`). Profiles such as cirrhosis (`rMin=.02`), diverticulosis (`.021`), and polycystic kidney (`.035`) therefore lose much of their intended small-scale morphology. For a 300 mm bounding-box diagonal, the positive minimum support radius is 33 mm. This is the algorithm's support radius, not a measured clinical lesion size.

**P0 — all profiles reduce to essentially the same bump/pull kernel.** Each site repeatedly translates vertices along one constant site direction under a compact cubic Euclidean envelope (`1095–1117`, `1814–1837`). Appearance uses a separate spherical support-squared mask and a symmetric ring (`1149–1163`, `1900–1913`), while geometry has sinusoidally perturbed anisotropy. Consequently shape and color footprints do not exactly agree. Nodular/fibrotic patterns only add a dark ring and a globally modified cellular texture. Profile-specific color alone cannot distinguish a fluid cyst, dense mass, surface scar, and inflammation.

**P0 — Euclidean distance crosses adjacent folds.** Anchors and supports use straight-line distance (`915–941`, `1104–1111`, `1904–1909`), with no connected-component, face-normal, or geodesic constraint. A lesion near two closely packed bowel loops can affect both; a thin wall's reverse side can receive the same color. A minimum bounded fix is an oriented tangent-plane footprint with normal-facing/depth gates; stronger treatment uses mesh adjacency and truncated geodesic distance. Cache the resulting per-vertex mask and use it for shape, base color, roughness, and vascular prominence.

**P1 — vertex sampling is tessellation-dependent.** Additional anchors come from a regular stride through at most roughly 768 vertices (`930–942`). Dense triangulated regions gain more candidate sites than equal-area sparse regions. Use area-weighted triangle barycentric samples with reproducible seeds, then reject overlaps according to each phenotype.

**P1 — aggregate and multi-mesh assumptions are inconsistent.** `buildImportedDiseaseField` examines only `state.meshes[0]` (`894–897`), yet single-reference apply can affect every mesh. The multi-organ wrapper builds a disease field independently per mesh (`1776–1788`). An organ spread across several meshes can therefore have repeated independent lesions. Slot-level surface sampling should produce one field, then evaluate it on every slot mesh.

### Transform and deformation validity

**P0 — source normals can be in the wrong coordinate frame.** `createVariationState` stores centered world coordinates (`283–313`), but disease-site direction blends these with untransformed local source normals (`952–963`). Scene physiological relief likewise adds raw local normal components directly to world coordinates (`1864–1870`). The bundled preset bakes transforms to geometry, hiding this problem; rotated/nonuniformly scaled uploads expose it. Apply `new Matrix3().getNormalMatrix(rest.world)` and normalize before world-space use. Preserve the outward orientation of actual surface normals; a radial dot test can misorient concave regions.

**P0 — reported Jacobians do not validate the final map.** `derivative` covers seven analytic scale/taper/twist/bend/shear controls (`995–1008`). Single-object disease and scene local residual/clearance/physiological relief are absent from that derivative (`1132–1135`, `1881–1886`). The single-object path checks final triangle areas (`1220–1234`); the scene path has no equivalent. A positive `minJacobian` therefore cannot establish no flips/collapses for the complete variant. Add finite coordinates, nonzero area and orientation checks relative to the expected shared deformation; reject or back off residual amplitude if a proposed variant fails. Report the analytic determinant's limited scope honestly.

**P0 — contact neighborhood is undersized.** Clearance free distance is 1.85 spatial-hash cells, but lookup visits only ±1 cell (`1575–1578`, `1602–1605`). Nearby samples in cells offset by two can lie within the support radius and be missed. Use `ceil(freeThreshold / cellSize)` as search radius, with distance pruning. The subsampling cap of roughly 1,800 points per mesh also misses small surface contact patches (`1581–1592`). Nearest-triangle or at least denser area-aware sampling is needed before stronger contact claims.

**P1 — the clearance field does not lock a vessel to an organ anchor.** Support meshes follow only the shared warp (`1726–1729`), while organs also receive local residuals blended by sampled contact clearance (`1858–1863`). Small gaps and vessel insertion separation can remain. Store explicit attachment anchors for known preset anatomy and propagate the organ displacement onto a short vessel-root blend region. Do not infer anatomical attachment from arbitrary proximity for uploads.

**P1 — smoothing and subdivision claims exceed the implementation.** Taubin-style fairing moves every supported source vertex and has no contact/volume constraint (`laparoscopicScene.ts:174–250, 472–474`); near-constant volume is not mathematically enforced. PN midpoint offset is capped at 6.5% edge length, but does not query adjacent organs (`257–329`). The test only verifies original vertices for PN subdivision (`variations.test.ts:359–379`), not the preceding fairing step. Avoid claiming exact submillimeter contact preservation without measurements.

### Texture, vessels, and optics

**P0 — “seamless 3D” PBR maps are a single oblique 2D projection.** `tissueUv` uses two fixed linear forms of rest position (`tissueDetail.ts:94–96`). This is deformation-stable and tile-seamless, but necessarily has a blind projection direction. It stretches on near-edge-on surfaces and maps different depth layers to the same pattern. The normal map inherits that distortion. The core issue is recognized in the NVIDIA triplanar discussion cited below. Prefer a proper rest-space triplanar field or an atlas bake. Do not implement a runtime-only custom shader without an export bake/fallback: glTF does not carry arbitrary `onBeforeCompile` shader logic.

**P1 — vascular placement is decorative rather than anatomically attached.** Four independent random root trees span a tile (`tissueDetail.ts:78–83`). Their roots do not connect to the named 3D arteries/veins, mesenteric border, or organ hilum. Major vessels should use geometry/landmarks; tiled vessels should remain fine and subserosal. For a bounded iteration, reduce large trunk prominence on smooth capsules and create a controlled mesenteric/curvature vascular zone using preset landmarks.

**P1 — cellular detail is repeated across too many tissue types.** The same grid11/grid23/grid47 Worley patterns, vein/artery/fat/fascia layers, and height recipe drive most organs (`variations.ts:655–763`). Sinusoidal fascia (`tissueDetail.ts:85–87`) and sinusoidal physiological ripples (`variations.ts:582–613`) introduce obvious regularity. Healthy capsules need lower high-frequency normal energy; pancreas/fat need larger irregular lobules; bowel exterior needs smooth wet serosa and sparse embedded vessels. Avoid adding gastric mucosal rugae to exterior serosa.

**P1 — mesentery loses its dedicated identity.** Baseline mesentery optics exist (`laparoscopicScene.ts:101`), but name matching assigns any “mesenter” mesh the small-intestine reference (`variations.ts:1407–1408`). Later synthesis excludes local deformation for mesentery but still uses small-bowel material/color (`1726`, `1918–1925`). Give mesentery a separate fatty/membranous material path with fine vessels; preserve supporting anatomy rather than treating it as bowel wall.

**P1 — authored color remapping masquerades as optical calibration.** `computeOrganTargetLinear` applies arbitrary exponent/multiplier curves (`420–479`); vertex colors then divide by a tile-wide mean (`1185–1186`, `1933`). The curves are not measured absorption coefficients. This is a valid art-direction layer, but tune it under fixed illumination and describe it as authored color. Do not use it to compensate for overbright lighting, then later change lighting without retuning.

**P1 — sheen is not subsurface scattering.** All tissues enable substantial cloth-oriented sheen (`laparoscopicScene.ts:100–115, 498–510`). Reduce or disable it unless justified by a reference. Retain subtle clearcoat for the wet film, separate clearcoat roughness from tissue micro-normal roughness, and avoid high transmission on thick organs. True subsurface scattering requires an additional transport model; do not label a red rim or generic transmission as physically validated SSS.

### Lighting and visual presentation

**P0 — bright studio illumination is inconsistent with a scope image.** The viewport adds hemisphere intensity 1.3, warm directional 2.6, cool directional 1, and a RoomEnvironment (`ImportedViewport.tsx:48–56`). It enables no shadow maps and uses no contact AO. Fixed world-space illumination means highlights do not track the viewer as a scope headlight would. Add a camera-attached spot/point light with scene-scale-aware attenuation, restrained ambient fill, and contact shadows. Keep exposure fixed during comparisons.

**P1 — current camera framing is an atlas overview.** Fit distance uses whole-object bounds with margin, and the default opening direction is orbit-relative (`72–98`). All structures can be seen without enclosing peritoneal context. Preserve this for orientation, but include close, reproducible hepatobiliary and foregut inspection views with scope illumination. Do not pretend an externally viewed complete anatomical assembly is an intraoperative exposure.

### Performance and export

**P1 — CPU generation can block interaction.** Four 512² Worley tables perform nine neighbor queries per pixel (`355–416`). Each fresh material bake allocates multiple 512² scratch arrays and rasterizes all pixels synchronously (`625–845`). Scene processing yields only after an organ (`2031`), unlike the single-object inner batch yield (`1203`). The 24-structure preset uses about 14 material bundles after artery/vein/duct sharing: 42 RGBA textures, approximately 42 MiB at base level or 56 MiB including mipmaps, before geometry and temporary arrays. These are arithmetic estimates, not measurements. Cache immutable seed recipes carefully, generate in a worker or yield by row/batch, and measure initial and subsequent synthesis latency before increasing resolution.

**P1 — original loader resources are not clearly owned.** The parsed source `gltf.scene` geometries/materials are cloned/extracted but not registered with `ImportResources` before losing the reference (`laparoscopicScene.ts:430–440`). The extracted output is owned. Review source disposal and abort-before-output ownership so repeated preset loads do not retain buffers longer than necessary.

**P2 — vessel clipping creates open ends.** Clipping intersects triangles but adds no cap polygon (`laparoscopicScene.ts:384–410`). Double-sided material can hide the problem in one view, while posterior views/export reveal hollow boundaries. Cap cut ends or keep them outside presentation framing; do not silently call the surface watertight.

**P0 for any shader rewrite — preserve displayed/exported equivalence.** Current GLB export carries geometry, UV, vertex color, and standard PBR maps, which is a robust architecture. A triplanar or custom tissue shader needs a real baked export representation and visual parity test. Preserve generated maps' channel/color-space interpretation and export-copy-only DataTexture conversion.

## Primary rendering evidence

1. **NVIDIA GPU Gems 3, Ryan Geiss, Chapter 1, §1.5.** Single planar projection causes severe orientation-dependent stretch; three axis projections blended by geometric normal reduce it. This directly supports changing `tissueUv`; it does not establish anatomical fidelity. [Official chapter](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu).
2. **Three.js MeshPhysicalMaterial documentation.** Clearcoat models a reflective top layer suitable for wet surfaces; sheen targets fabric; physical features add per-pixel cost. This supports a simpler wet-film layer and reviewing sheen, rather than enabling every feature. [Official API documentation](https://threejs.org/docs/pages/MeshPhysicalMaterial.html).
3. **Jensen, Marschner, Levoy, Hanrahan, SIGGRAPH 2001.** Subsurface transport includes nonlocal scattering that a surface BRDF cannot reproduce. Their dipole formulation is evidence that tissue softness is a distinct optical problem, not evidence that the present model already simulates it. [Authors' publication page](https://graphics.stanford.edu/~srm/publications/SG01-subsurf-abstract.html).
4. **Han and Wu, EndoPBR, 2025 preprint / WACV 2026 publication.** Separating lighting from BRDF material estimation and using a surgical spotlight model improves view synthesis with known geometry. The published paper uses a camera-co-located light. This supports correcting the scope light before intensifying texture. Evaluation concerns colonoscopy data; transferring every parameter to laparoscopic abdomen would be an inference. [Authors' arXiv paper](https://arxiv.org/abs/2502.20669), [WACV paper](https://openaccess.thecvf.com/content/WACV2026/papers/Han_EndoPBR_Photorealistic_Synthetic_Data_for_Surgical_3D_Vision_via_Physically-based_WACV_2026_paper.pdf). The arXiv abstract and indexed WACV text were accessible; direct WACV PDF retrieval returned HTTP 403 during this audit.
5. **Dowrick et al., IJCARS 2022.** Their synthetic laparoscopic liver scene includes fat, torso enclosure, a scope spotlight, and independently varied camera/light/material parameters. They report downstream segmentation evaluation rather than equating screenshot attractiveness with clinical validity. The relevant lesson is to assess coherent scenes and useful outputs, not only texture complexity. [Open-access primary article](https://link.springer.com/article/10.1007/s11548-022-02598-z).

## Bounded implementation sequence

### Iteration 1: visible improvement with low architecture risk

- Fix world normal handling, broaden clearance neighbor search, add final scene triangle validity checks, and qualify overstated contact/Jacobian claims.
- Add explicit camera-attached scope lighting and shadow support, with bounded intensity based on scene radius. Disable cloth sheen on smooth capsules and tune wet-film roughness under this light.
- Add a compact phenotype table with separate profile radius/roughness/vascular/color behavior and one shared deterministic surface mask. Use a smaller shape floor for nodular/multicystic patterns, anisotropic tangent-plane mass/cyst support, and broad smooth inflation for diffuse swelling.
- Give mesentery separate fat/membrane coloration. Keep healthy liver smooth; make pancreatic lobulation irregular and bounded.

### Iteration 2: inspect and correct

- Capture the same baseline seed in anterior, hepatobiliary, foregut, and grazing posterior views. Compare silhouette, contact, vascular scale, specular width, color clipping, and texture stretch.
- Compare severe cirrhosis, focal exophytic mass, inflammation, and diffuse enlargement using the same seed and camera. No two should differ merely by tint.
- Correct regular rings, disconnected 3D vessel roots, overbright glints, uniformly noisy capsules, and indistinguishable lesion types before adding detail.

### Iteration 3: robustness and output

- Repeat at two other seeds and mild/severe levels, including rotated/nonuniformly scaled uploads and a close folded-bowel fixture.
- Export/reimport one baseline and one severe disease scene; compare the exact saved cameras and confirm map/vertex-color parity.
- Measure generation duration and interaction responsiveness. Only then choose whether exportable atlas baking/triplanar sampling is justified in this change.

## Meaningful checks

Current tests mostly assert changed positions/colors, texture presence, and pixel color counts. The contact test at `variations.test.ts:301–357` never measures the named contact interface. The vascular test at `382–417` can pass with visually excessive branching/noise. Add tests only for changed, consequential behavior:

- Transform-equivariance: an upload with baked geometry and the same upload with parent rotation/nonuniform scale produce equivalent world-space lesion directions and relief.
- Surface confinement: neighboring disconnected loops do not share a focal lesion; shape and appearance masks peak at the same anchor.
- Final geometry validity: finite positions, minimum triangle area, stable orientation, bounded displacement; no claim that these replace full self-intersection detection.
- Contact distance: explicitly measure selected source contact pairs after scene variation and use a defined tolerance in scene units.
- Determinism and severity: same seed replays byte-equivalent generated arrays; a disease's mild/severe change is monotonic in its intended structural property.
- PBR consistency: all channels use the same spatial field; no orphan texture resources on abort/reset; export/reimport keeps material maps and appearance.

Visual acceptance should require surgeon/anatomist review before describing the output as clinically validated or a surgical digital twin. For this engineering iteration, a defensible deliverable is a substantially improved, coherent procedural anatomical visualization with documented sources and known limits.
