# VISCERA Fat Lab

The Fat Lab is a separate procedural adipose appearance generator with an analytical material bench. Open the studio with `?mode=fat`. The whole-scene entry is `?mode=scene&fat=1`; its organ-relative placement is separate from the isolated specimen generator. No new neural training or large dataset download is required.

## Revision 3 (19 October 2026)

The current generator, texture baker and shader identify themselves as `viscera-fat-geometry-v3`, `viscera-fat-texture-v3` and `viscera-fat-triplanar-v3`. Omental thickness and fold depth are independent. The material adds a bounded, thickness-dependent direct-light diffusion approximation, curved footprint-filtered vessels and regional wet-film variation. The mechanics bench supports load-controlled creep/recovery and repeated loading in addition to prescribed-strain relaxation. Exact V2 source and intermediate failures remain preserved.

Use [the V3 implementation guide](../../../../docs/fat-lab-v3.md), [critical review](../../../../docs/fat-quality-v3-review-2026-10-19.md) and [verification](../../../../artifacts/fat-quality-v3-2026-10-19/verification.md) for current behavior, interpretation and measured results. The interactive gallery is `artifacts/fat-quality-v3-2026-10-19/index.html`. Recipes identify the generator revisions; identical seeds across different revisions need not produce identical shapes or pixels.

## Preserved revision 2 visual experiments

Revision 2 introduced the `viscera-fat-geometry-v2`, `viscera-fat-texture-v2` and `viscera-fat-triplanar-v2` algorithms. Its exact source copies/hashes, screenshots and clips are retained under `artifacts/fat-quality-2026-10-19/`; historical prompt-pack evidence is unchanged.

The lab adds four surface studies (lit tissue, unlit base color, neutral relief, neutral geometry) and three lighting conditions (studio, camera light, grazing light). These make geometry, pigment and shading defects independently inspectable. Geometry uses rotated physical coordinates with two scales of smooth compact-support lobules. The material blends planar height gradients before surface perturbation, removing spurious derivatives of triplanar blending weights. Authored height amplitude is **0.8 mm**; finite differences use a minimum 1.5/512 tile footprint to suppress quantized/subpixel slopes. Fixed rest normals determine projection weights. The old additive edge-light approximation is removed; no subsurface transport is claimed. Septal whitening and fine relief are reduced and regionally varied.

See `docs/fat-visual-review-2026-10-19.md` and `artifacts/fat-quality-2026-10-19/index.html` for the critical image/video review and comparison gallery. These experiments improve specific rendering and geometry defects. They do not qualify the generator as photorealistic or mechanically calibrated.

## Components and units

| File | Responsibility |
|---|---|
| `generator.ts` | Seeded closed mesh, lobulation, requested dimensions and geometric measurements. Geometry is in **millimetres**; density is kg/m³; reported mass is grams. Shape and texture randomness are independent. |
| `texture.ts` | Periodic colour, height, roughness and normal-map baker. The bounded base field is at most 512²; additional procedural detail is evaluated at each output texel up to 4096². |
| `texture.worker.ts` | Runs texture work away from the UI thread and transfers buffers. |
| `material.ts` | Rest-space triplanar material, height-derived shading relief, wet highlights and filtered physical-scale height gradients. Colour is sRGB; data maps are linear. |
| `optics.ts` | CPU reference and shared constants for the authored bounded direct-light diffuse response; not a reciprocal volumetric scattering solver. |
| `physics.ts` | Homogeneous displacement-controlled test coupon, nearly incompressible neo-Hookean response and positive Prony relaxation. SI units internally; input coupon dimensions are mm. |
| `mechanicsExperiments.ts` | Load-controlled creep/recovery and repeated nominal-stress cycles, with bounded constitutive inversion and explicit protocol diagnostics. |
| `FatViewport.tsx` | Three.js viewer, affine deformation preview, scale bar, image capture and rest-geometry GLB export in **metres**. |
| `FatReferenceViewport.tsx` | Independently loaded HRA omentum reference, recentered in millimetres and shown in neutral clay with source attribution. Original geometry bytes are unchanged. |
| `sceneLayers.ts` / `sceneLayers.worker.ts` | Organ-aware omental apron and partial perirenal pads with discrete surface checks, computed in a cancellable worker. |
| `sceneLayerView.ts` | Owns optional layer resources, shared atlas warp and interpolated motion. Does not modify atlas source geometry. |
| `FatLab.tsx` | Presets/seeds, sampling, 4K selection, material-test controls, image/map/recipe/CSV downloads and references. |

The default physical texture repeat is 72 mm. A 4096² tile therefore has approximately 17.6 µm per texel along its axes; this is a sampling interval for authored fields, not a measurement resolution. Three RGBA8 4096² maps occupy 192 MiB before GPU mipmaps and temporary image-export allocations. The core supports normal output as well; the interactive shader uses height-derived relief.

The current GLB export contains the generated rest geometry with a constant fallback material. The custom triplanar shader is not portable glTF material data; export the texture PNGs and JSON recipe alongside it. Do not advertise the GLB alone as a complete portable 4K PBR asset.

## Scientific interpretation

The shape presets are authored examples, not population distributions or patient reconstructions. The connected closed specimens (radial visceral pad and height-field thin patches) cannot represent arbitrary omental fenestrations, separate fragments or all fascial topology. A large seed space gives reproducible procedural variety; it does not establish representative anatomical variation. Texture palettes, septal widths, vessels, roughness and wetness are authored controls.

The material bench predicts response for an ideal 40 × 20 × 40 mm coupon. It is **not** a tetrahedral solver for the irregular displayed mesh. The viewport shows the coupon's prescribed or solved axial/lateral stretches as an affine preview. Its geometry does not determine the coupon's force curve. In displacement-controlled mode, negative release reactions correspond to a constrained tensile reaction. Load-controlled mode separately solves creep and recovery at prescribed nominal stress; it still does not solve platen contact or separation.

The material presets deliberately label themselves illustrative. Human measurements support nonlinear, rate-dependent fat behaviour, but dynamic storage modulus is not instantaneous or equilibrium shear modulus. The chosen instantaneous modulus, density 950 kg/m³, Poisson ratio 0.49, fast relaxation time and relaxation fractions are simulation assumptions. The slow 30 s branch is motivated by a separate human calf inverse study, not fitted to the abdominal shear data. The generator's standalone default density is independently configurable; display the density actually used in its statistics.

The model omits anisotropic fibre reinforcement, poroelastic fluid transport, contact/friction, attachments, gravity/inertia, temperature dependence, cutting and damage. Density changes reported mass; it does not change this quasistatic reaction. Stable numerics and attractive renders do not demonstrate surgical accuracy.

## References and asset rights

- [Estève et al., 2019: human lobular architecture](https://pmc.ncbi.nlm.nih.gov/articles/PMC6560121/) supports connected lobules, collagen-rich septa and depot differences. Original article/figures are CC BY 4.0 except any separately credited third-party material.
- [Juliar et al., 2020: human rheometry](https://pmc.ncbi.nlm.nih.gov/articles/PMC7876417/) reports abdominal/omental dynamic shear at 37 °C, 0.1% strain in frozen/thawed bariatric samples. At 1 rad/s, VAT G′/G″ = 6.680/1.296 kPa; SAT = 10.558/2.013 kPa. These observations do not calibrate large-strain compression.
- [Alkhouli et al., 2013: human tension](https://pubmed.ncbi.nlm.nih.gov/24105412/) and [Sommer et al., 2013: multiaxial response](https://pubmed.ncbi.nlm.nih.gov/23811521/) show why depot, loading mode and fibre response must be retained.
- [Human calf inverse poroviscoelastic study, 2021](https://pubmed.ncbi.nlm.nih.gov/33887715/) reports fitted timescales of 27.5–38.5 s under its own compression/impedance protocol.
- [Lazareva et al., 2018: tissue refractive index](https://opg.optica.org/ao/abstract.cfm?uri=ao-57-17-4839) motivates a dielectric IOR around 1.44–1.46, with wavelength/temperature/species qualifications. The renderer is not a calibrated radiative-transfer model.
- [DSAD / NCT Dresden](https://huggingface.co/datasets/nct-tso/dsad) supplies the unchanged surgical reference photos. Its repository states CC BY 4.0, while publication wording includes a noncommercial condition; this rights ambiguity is recorded in the reference catalog and dated research correction. Preserve Carstens et al. attribution. The source masks are organ masks; displayed fat descriptions are visual observations, not source-provided fat labels. No DSAD training dataset was created.
- [HRA reference omentum](https://doi.org/10.48539/HBM636.GWRW.698), Heidi Schlehlein, 2026, CC BY 4.0, is available as `public/fat-lab/reference-omentum.glb`, copied unchanged from the existing repository archive. Its accompanying `reference-omentum.attribution.json` records credit, source, licence, checksum, geometry counts and bounds. It is an **untextured atlas model, not a surgical 3D scan**.

The broader research and source audit is in `docs/fat-research-2026-10-18.md` in the VISCERA workspace, with a copy at `reports/fat-research-2026-10-18.md` at the outer repository root. `reports/fat-reference-review-2026-10-18.html` is a separate three-view source comparison with unchanged DSAD photographs. Serve the repository root over HTTP for its relative/import paths.

DRENDS was also inspected as an actual measured surgical 3D reference using an existing local pilot, without a new download. The reference desk includes three native ToF cloud views beside the unchanged left-camera image from `Seq01_Colon_Med`, frame 0 (ex vivo porcine colon manipulation). Its 117,007 valid workspace points are stored in millimetres; the plot colors represent sensor Z. The source workspace mask retains background and instruments and is **not a fat annotation**. RGB-to-cloud registration was not validated here. The compact PLY, reproducible plot script, and checksummed metrics are at the outer repository's `reports/fat-surgical-3d-reference/`; public plot/RGB provenance is `public/fat-lab/drends-reference.attribution.json`. [DRENDS data](https://doi.org/10.5281/zenodo.17598453) are CC BY 4.0, confirmed by the [publisher's data-availability statement](https://www.nature.com/articles/s41597-026-07775-2). This is a measured scene surface, not a complete fat mesh or human mechanical calibration.

D4D remains a candidate for later paired geometry/appearance evaluation. Neither dataset was used to train this generator, and neither supplies a fitted fat force law for these specimens. The isolated generator does not derive its appearance from HRA, DSAD or DRENDS images; those assets remain separately attributed references.

## Reproducible checks

From `viscera/`, with installed dependencies:

```sh
node node_modules/vitest/vitest.mjs run apps/studio/src/fat
VISCERA_FAT_BENCHMARK=1 node node_modules/vitest/vitest.mjs run apps/studio/src/fat/texture.test.ts
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
```

The checks cover deterministic geometry, 360 geometry seeds across presets, 60 additional thin-depot cases at maximal lobulation, dimension/mass units, volume convergence, 100 texture seeds for periodic edges, chunk consistency, encoded normals, bounded parameters, analytical elastic/Prony limits, signed release reaction, rate dependence, timestep convergence and 72 mechanics parameter/protocol cases. Layer tests additionally load the actual torso atlas.

Browser verification:

```sh
node node_modules/@playwright/test/cli.js test --config playwright.fat.config.ts
# To check a built copy served at a nested path as well:
VISCERA_FAT_PUBLIC_URL=http://127.0.0.1:8817/anatomy node node_modules/@playwright/test/cli.js test --config playwright.fat.config.ts
```

Revision 3's recorded run passes 73 fat unit/integration tests including the optional real-4K and atlas experiments, and 13 browser scenarios including the built public copy. Results are in `artifacts/fat-quality-v3-2026-10-19/verification.md`. They cover three depots, independent seeds, native 4096² PNG dimensions, rest-geometry GLB, recipe/CSV downloads, deformation/recovery, mobile overflow, HRA reference loading, organ-layer visibility, geometry preservation, texture cancellation, relative worker URLs, failed-worker export locking, GPU resource cycling and exactly opposing light/view directions. Preserved final screenshots and exports are in that directory's `final-browser/`. TypeScript and production Vite build passed; the build retains the existing large-bundle size warning.

The layer construction target is 0.8 mm; discrete clearance samples must exceed the exported 0.6 mm acceptance threshold. This is a reference-state surface check, not a continuous-volume collision proof. The sampled minimum is conservative and can include passing samples from later-rejected triangles. Shared atlas motion is not a calibrated adipose contact simulation.

Tests establish checked mathematical/software properties. They do not establish surgeon-rated realism, anatomical representativeness, measured spectral accuracy or clinical performance.

## Roadmap toward measured accuracy

1. Add independently reviewed fat regions to patient-separated surgical images, keeping wet highlights and blood distinct from intrinsic material targets.
2. Compare generated gross anatomy to attributed omental/perirenal/mesenteric reference shapes and measure organ intersections/attachment errors.
3. Collect or license posed multi-view fat images with matching geometry for inverse rendering; compare with [EndoPBR](https://openaccess.thecvf.com/content/WACV2026/html/Han_EndoPBR_Photorealistic_Synthetic_Data_for_Surgical_3D_Vision_via_Physically-based_WACV_2026_paper.html).
4. Fit multi-mode, donor-separated tensile/compressive/shear/relaxation data with documented preparation, temperature, hydration, dimensions and contact boundary conditions.
5. Introduce fibre/poro-viscoelastic volume simulation and organ contact only with numerical verification and held-out experimental errors. Keep simulation parameter provenance in every export.
