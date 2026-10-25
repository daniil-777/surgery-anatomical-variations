# Operative fluid appearance: research and implementation guidance

Research date: 2026-10-25. Scope: surgical surface blood, wet films, stain/exposed-plane appearance, and integration into the current VirtaMed scene. This is an engineering review, not a surgeon assessment or clinical validation. The follow-up implementation is recorded at the end.

## Main recommendation

Add a distinct, anatomy-anchored operative surface layer after the existing organ/interface material blending. Use the repository's spectral blood transport for the color change of thin blood films; use separate wetness and exposed-plane fields for the remaining irregular appearance. This offers a coherent improvement with camera-angle and deformation consistency. Do not obtain operative “mess” by increasing global red noise, and do not label an authored thickness mask as a fluid simulation.

The first implementation should keep three states explicit:

1. Clean/wet intact tissue: the existing substrate plus locally varying transparent-fluid interface.
2. Localized operative residue: attached irregular patches and short drainage-shaped streaks, with thin diffuse stain at their margins and thickness-dependent blood color in their interior.
3. Exposed operative plane: a localized rougher fibrous substrate with discontinuous wet boundaries. This is an authored appearance cue unless geometry actually represents a cut. It must not be described as a simulated incision.

## Primary literature and what it supports

**Neyret, Heiss and Sénégas (2002)** explicitly separate organ skin texture, evolving instrument-reaction effects, and specular reflections. The reaction layer includes blood drops, cauterization and pressure-related whitening; it is updated independently of the underlying texture. The useful architectural lesson is that operative changes belong to a persistent surface layer rather than baked camera images. This research did not claim full blood hydrodynamics. I verified the abstract and indexed author-PDF excerpts; the complete author-PDF download timed out, so detailed equations were not independently read. [Author paper](https://evasion.imag.fr/Publications/2002/NHS02/vcomp.pdf), [DOI](https://doi.org/10.1007/s003710100118).

**Borgeat et al. (MICCAI 2011)** combine surface fluid simulation with multilayer depth peeling to accommodate complex, changing surgical geometry. Their stated use case is brain-tumor resection, including aspiration and cautery. This is a real simulation architecture for propagation and accumulation, not a texture randomizer. The publisher abstract is accessible; full equations are paywalled in the source accessed here. Do not imply we implemented their solver from the abstract. [Publisher](https://link.springer.com/chapter/10.1007/978-3-642-23623-5_41), [PubMed](https://pubmed.ncbi.nlm.nih.gov/22003633/).

**Kerwin, Shen and Stredney (2009)** combine interactive fluids with wet-surface shading in temporal-bone simulation. They preserve fine diffuse detail while smoothing the specular normal; they also approximate refraction and contact menisci. The critical transferable observation is that fluid smooths its optical boundary without erasing all substrate detail. Their height-field assumption relies on an overhead surgical view, which does not transfer directly to the freely viewed laparoscopic cavity. Their small surgeon evaluation also criticized bleeding from arbitrary removed voxels rather than anatomically discrete sources. This strongly argues for localized operative regions in Viscera. [Full paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC2748262/).

**ElHelw et al. (MICCAI 2005)** study mucous-covered tissue appearance, including irregular specular shapes and their role in conveying orientation and deformation. It supports structured, spatially varying highlight response, not a uniformly glossy plastic surface. Their image-based approach predates our physically based pipeline, so transplant the separation of effects rather than its exact reflection-map implementation. [Author PDF](https://www.cs.sfu.ca/~stella/papers/2005/miccai.pdf).

**Bosschaart et al. (2014, corrected)** provide wavelength-dependent whole-blood absorption and scattering data and discuss hematocrit and oxygenation dependence. Viscera already uses this source. A blood film must change color with optical path length: a thin film over bright tissue is not the same material color as a thick opaque pool. The paper is not a calibrated laparoscopic camera-response model. [Article](https://pmc.ncbi.nlm.nih.gov/articles/PMC3953607/), [correction](https://pmc.ncbi.nlm.nih.gov/articles/PMC9172854/).

**EndoPBR (Han and Wu, 2025 preprint; 2026 WACV title)** separates material and moving endoscopic illumination using posed images and known geometry. Its model learns spatial BRDF parameters and a camera-linked spotlight; its C3VD experiments use camera/depth information. The relevant constraint for AI fitting is that photographed white highlights must not become white albedo. Learning a histogram or texture from unposed surgical RGB is a more limited operation than inverse-rendering a BRDF. The accessible preprint is the specific version reviewed here. [Methods](https://arxiv.org/html/2502.20669v1), [WACV accepted-paper listing](https://wacv.thecvf.com/Conferences/2026/AcceptedPapers).

## Existing Viscera implementation inspected

All paths below are relative to `/tmp/viscera-operative-release`.

- `scripts/generate_blood_appearance_optics.py`: constructs a 512-thickness by 65-oxygenation LUT with six float32 values per entry, spectral interpolation before transport, D65/CIE 1931 integration, and a passivity-preserving RGB projection. Thickness spans 0–50 mm using a 1 µm logarithmic scale. The script checks off-node interpolation against fresh spectral solutions.
- `scripts/generate_blood_appearance_oracle.py`: separately loads coefficients and evaluates a matrix exponential plus repeated layer doubling. It does not import the closed-form LUT generator. This is a numerical check of the declared two-stream model, not experimental validation of the full radiative-transfer equation.
- `apps/studio/src/blood/experiments/bloodAppearanceOptics.ts`: `bloodAppearanceTransport(h, oxygenation)` returns passive linear-RGB reflectance and transmittance. It rejects invalid inputs and has an exact empty-film identity. It is directly reusable without a new data fit.
- `apps/studio/src/blood/optics.ts`: `composeDiffuseSubstrate` correctly accounts for a top-lit substrate and repeated diffuse interreflection. Avoid replacing it by `R + T*s` or transparent red alpha blending.
- `apps/studio/src/blood/liver/renderer.ts`: already exposes a compact two-row transport texture, a per-fragment optical-layer function, and a thickness-linked leveling/roughness closure. Do not import this entire renderer into the main scene just to reuse a helper: it pulls in unrelated liver-lab dependencies. Extract a small pure optics module or implement a small adapter against the existing transport API, with identity/oracle tests.
- `apps/studio/src/blood/liver/surfaceFlow.ts`: an actual conservative creeping-film model on barycentric dual cells. It tracks per-vertex volume, gravity/hydrostatic/capillary energy, optional Carreau–Yasuda rheology and contact pinning, equal-and-opposite edge flux, rollback, drainage ledgers and nonnegative states. It is materially more than an appearance function, but is tied to a dedicated liver representation and source/cut protocol. Whole-scene coupling is a separate integration project.
- `apps/studio/src/virtaMedMaterials.ts`: current material already performs rest-space triplanar sampling and explicit interface blending, then computes final color/slope/roughness/coat. Its existing “film” is a procedural wetness field; it does not represent blood thickness or mass.

The clone contains generated runtime LUTs but does not contain the raw `blood/optics/` validation directory. That directory exists in the original user workspace. Before re-running existing optics tests/generators, copy the exact required data/evidence with hashes from the original workspace; do not regenerate spectral coefficients from guessed values. I inspected the source but did not execute these numerical tests in this research task.

## Bounded WebGL2 implementation

### Optical layer

For substrate linear reflectance `s`, film thickness `h` in metres, and a declared oxygenation value, sample `R(h)` and `T(h)`. Compose channel-wise:

`C = R + T*T*s / (1 - R*s)`

This is the existing symmetric diffuse-slab approximation. Shade `C` once under the actual scene lights. Preserve independent dielectric Fresnel reflection; do not attenuate the specular boundary by the film's diffuse alpha. At `h = 0`, return the substrate exactly. A 512×2 RGBA float texture for one oxygenation slice costs 16 KiB. Explicit nearest-node interpolation avoids requiring float-linear filtering. Use a shared texture per scene, dispose it with the scene, and never regenerate it per frame.

For partial spatial coverage `a`, mix dry and wet *material states* only across the physical footprint/antialias band; `a` is not a substitute for absorption. Use thin margins and thicker centers to create the observed optical distinction without painting hard red boundaries.

Use separate transparent-fluid wetness `w` and blood thickness `h`. An illustrative interface-leveling closure already present in the repository is `l = h/(h+r0)`, where `r0` is an authored substrate-relief scale. Damp high-frequency substrate slopes for the wet specular interface as `1-l`, while retaining substrate diffuse detail. A bounded fourth-power roughness blend is already implemented. Both this closure and `r0` are authored approximations, not measured laparoscopic parameters.

### Surface attachment and interfaces

Store the operative field in material/rest coordinates. Apply its optical composition **after** neighboring substrate materials have been blended, so an attachment does not split the film at the color transition. Shared rest positions give exact coordinate agreement at registered interfaces. Do not separately resample a different seed on the two sides of one connected film.

Three-dimensional fields alone can leak through nearby but disconnected surfaces. Restrict each patch by organ/operative-region membership and a connected-surface/geodesic support field. Treat genuinely open air gaps as gaps. A crease may retain an authored stain; it must not grow an unsupported membrane of blood joining unrelated organs.

For shape variation, the field follows the deformation by the existing rest-space mapping. This preserves attachment but is **not volume-conserving fluid mechanics**. If physical fluid is later enabled, track mass on material control cells, recompute current area, and derive thickness `h_i = V_i/A_i`. Exchange flux only over valid current surface edges or an explicit contact-transfer protocol. Do not assume a shared world-space noise field conserves volume.

### Spatial organization

Use a few coherent localized patches near the operative plane/attachment bed, irregular connected margins, short anatomically supported streaks and some clean regions. Fine multiscale modulation should alter a patch boundary or thickness, not independently put blood on every voxel. Distinguish thin translucently tinted residue, thicker low-reflectance centers, and transparent wet regions. A uniformly distributed collection of red spots will read as a skin disease or decoration.

Gravity-shaped streaks can be authored from a field projected into the tangent plane, `g_t = g - n*dot(n,g)`, and constrained by host-surface connectivity. If this is sampled as a static texture rather than integrated as flux, describe it as drainage-shaped appearance. A stationary phase field should not animate during camera rotation.

## AI/data fitting that can be claimed honestly

For the bounded release, fit a compact conditional appearance model from reviewed dataset patches: distribution of region size, connectedness, color ratios after light normalization, wet-highlight coverage and multiscale texture energy. Preserve source IDs, crop/mask coordinates, split membership and uncertainty. Hold out entire videos/patients, not adjacent frames, to avoid temporal leakage.

Red tissue, liver and shadows are not blood labels. Use supplied segmentation where available, inspect candidate blood/residue patches manually, and do not infer a precise hemorrhage diagnosis from color. Saturated highlights are censored observations of radiance and should be excluded from diffuse albedo fitting. Separate light falloff from local texture by coarse illumination normalization before measuring residual appearance.

If only unsupervised clustering, statistical fitting or nearest-reference matching is done, name it that way. Do not report a newly trained generative model, measured film thickness, learned disease biomechanics or learned BRDF. The raw imagery does not by itself provide those targets. A later inverse-rendering stage needs camera poses, geometry/depth and a light model, with held-out-view evaluation.

## Acceptance tests and visual review

- Mathematical: exact dry identity; finite bounded values; `R+T<=1`; lookup agrees with independent numerical evidence; thick-film limit approaches intrinsic slab reflectance; no energy increase over a white substrate; no mm/metre conversion error.
- Attachment: mask and optical signature are identical at shared interface coordinates; independent surfaces remain clean when the patch belongs to another organ; repeat seed gives identical results; camera rotation does not move the pattern.
- Deformation: stretch/grasp the stained region and both sides of an attachment. Verify no swimming, tearing or discontinuous film edge. Do not mark this as mass conservation unless volume/area evolution is actually checked.
- GPU: use the production material path, all selected disease variants, white mode, no learned-tile fallback and loaded-tile mode; fail on shader/WebGL errors; keep texture/sampler counts bounded.
- Visual: clean versus operative layer, front/left/right/grazing/near views, fixed exposure, with and without glare/shadows. Check wet edge highlights, dark thick centers, retained thin-margin substrate detail, and absence of repeated circular stamps or huge uniform red patches.
- Performance: compare fixed-scene baseline and operative layer under the same resolution and motion. Report CPU/GPU frame costs separately if measurable; reject per-frame texture rebuilding or big hidden transient allocations.

These gates demonstrate implementation consistency and visible behavior. They do not establish surgeon-rated realism, training effectiveness, physical parameter identification or clinical accuracy.

## Follow-up implementation completed

At the coordinating agent's request, added `apps/studio/src/operativeBloodOptics.ts` and `.test.ts`, plus `operativeSceneAppearance` adaptation/attribution metadata in the existing public attribution JSON. The final GPU API is:

```ts
import { operativeBloodTexture, OPERATIVE_BLOOD_GLSL } from "./operativeBloodOptics";
shader.uniforms.uOperativeBlood = { value: operativeBloodTexture(sceneTextureOwner) };
// Add OPERATIVE_BLOOD_GLSL to the common shader section.
// In the material code: operativeBloodColor(linearSubstrate, thicknessMm)
```

The helper shares the 16 KiB float texture by owner and disposes it on the owner's dispose event. CPU equivalence is `operativeBloodComposite(thicknessMm, substrateLinearRGB, oxygenationFraction = .75)`. Public provenance is `OPERATIVE_BLOOD_PROVENANCE`. Seven tests passed: attributed data integrity, dry identity/unit conversion, passive material composition, off-node packed-LUT equivalence, texture requirements, owner lifetime and invalid-input rejection. Final Studio typecheck passed. No scene material, UI, blood-subtree, shader integration, or deployment files were changed by this agent.
