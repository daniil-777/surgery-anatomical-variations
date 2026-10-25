# Surgical appearance brief for the video-referenced scene

Research date: 2026-10-25. This is an engineering and visual-reference study, not surgical qualification. The supplied video is a simulation, so it is useful for composition and interactions but not a source of measured human reflectance, anatomy, force, or elasticity. The recommendations below are authored implementation choices unless explicitly described as source observations.

## Evidence inspected

I read the existing Viscera operative-view, surgical-appearance, hepatobiliary and abdominal-disease research notes, and inspected `imports/laparoscopicScene.ts`, `imports/tissueDetail.ts`, `imports/variations.ts`, `wholeSceneMaterials.ts`, and `operativeView.ts`. I inspected the supplied video's sampled contact sheet and its early detailed field at `/tmp/viscera-virtamed-research/video-audit/detail-0015.jpg`; the dedicated video audit should be used for frame timing and further geometric measurements.

I directly viewed these real surgical images, rather than relying on captions:

| Source | Images actually inspected | Access and reuse |
|---|---|---|
| [Dresden Surgical Anatomy Dataset (DSAD), original publication](https://pmc.ncbi.nlm.nih.gov/articles/PMC9837071/) and [official NCT Dresden mirror](https://huggingface.co/datasets/nct-tso/dsad) | Existing Viscera references 03/2 (liver), 25/47 (bowel/mesentery), 21/5 (colon), 22/6 (pancreas); newly viewed 04/0 (abdominal-wall field). | The official mirror explicitly records CC BY 4.0. Existing app provenance already tracks its references. New image remains in temporary research storage; no new reference image was added to public assets. |
| [CholecSeg8k original paper](https://arxiv.org/html/2012.12453) | Figure 1 raw example and three raw examples from Figures 5–7; files `ImageEX.png`, `figures/4-1.png`, `figures/2-1.png`, `figures/3-1.png`. | Paper explicitly states CC BY-NC-SA 4.0 for dataset. View-only research here. Do not move these copies into the deployed commercial/professional asset library. |
| [Endoscapes official repository](https://github.com/CAMMA-public/Endoscapes) | Official `endoscapes_examples.png` montage, six views with annotation overlays. Useful for interfaces and surgical exposure; masked pixels are unsuitable for judging actual tissue color. | Official data license is CC BY-NC-SA 4.0. View-only research here. |

The original DSAD article has inconsistent wording in its usage note (mentions non-commercial use while naming CC BY); the explicit current official dataset card and existing project provenance record CC BY 4.0. Preserve provenance and do not infer licenses from third-party reuploads. CholecSeg8k and Endoscapes have stricter explicit terms; no restricted images are shipped by this research task.

## What the actual images show

**DSAD observations:** liver 03/2 has a continuous smooth mauve/brown capsule with faint fine mottling, a rounded edge and isolated highlights. Bowel/mesentery 25/47 has yellow-orange connected fat with red branching vessels, pale stretched membrane and neighboring pink bowel. Colon 21/5 has a coherent glossy pale surface, localized folds, and strong contact/occlusion against fat and instruments. Pancreas 22/6 shows pale lobulated tissue, transparent stretched connective strands and wet glints. Abdominal-wall field 04/0 combines pale membrane, embedded branches, and uneven fat mounds; it is not a uniform pink textured sphere. Camera white balance and exposure are part of these colors; they are not albedo measurements. [DSAD source and original methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC9837071/)

**CholecSeg8k observations:** the overview separates dark red-brown liver, pale blue-grey gallbladder, pink vascularized hollow viscera and yellow fat. The gallbladder fundus can be almost white under the camera light, rather than uniformly green. In other views the exposed wall is cream/yellow with fine red branches, while fatty coverage and connective tissue conceal portions of the organ. Large vessels should not be painted on every hepatic surface. The paper's anatomy categories are broad: the gastrointestinal class combines stomach, small intestine and nearby tissues; it does not establish those identities for every pink region in a frame. [Original paper and figures](https://arxiv.org/html/2012.12453)

**Endoscapes observations:** across the montage, the amount and location of visible duct/artery/plate changes with exposure and traction. Intact liver remains a large smooth occluding surface. White wet highlights occupy compact patches, and the exposed bed has a distinctly rougher, redder appearance than the capsule. Segmentation masks are colored overlays and must never be sampled as tissue color. [Official montage and anatomy definitions](https://github.com/CAMMA-public/Endoscapes)

## Translation to the supplied simulation video

The opening composition shows a broad superior hepatic surface, a pale gallbladder fundus on the left of the displayed surgical image, a pale vertical suspensory sheet, two large pink curved foreground/midground visceral surfaces, and a continuous orange-yellow fat apron. Later views expose the gallbladder neck/interface with traction and dissection. These are screen-space observations, not a recovered 3D anatomical coordinate system. The pink regions' exact organ identities and all unseen posterior geometry require independent anatomical assumptions. Do not use the simulation's highly regular thick vessel drawing as the realism target.

**Reconstruction priorities, in order:**

1. Match the opening view's silhouettes, relative overlap and working distance in the white-material stage. Use a broad hepatic roof with an asymmetric edge, a gallbladder partly attached beneath it, folded thin connective sheets, and connected fat between/over the visceral forms. A collection of isolated ellipsoids will fail even with good textures.
2. Preserve named organ and tissue parts, local rest coordinates, attachment regions, material slots and stable IDs. A scene variant must retain those relationships when switching white/textured/varied/physics modes.
3. Treat the round visible gallbladder fundus as a view of a longer attached shape; do not reconstruct it as a free sphere. Preserve its narrowing toward the attachment region. Keep deeper ducts/vessels covered until the chosen view/exposure actually reveals them.
4. Give fat a continuous sheet or connected lobulated volume with unequal lobule sizes and soft joining saddles. Put the most visible vascular branches in this supporting membrane and fat interfaces. Avoid independent beads around every organ.
5. Use large smooth surfaces first, then folds/attachments, then lobulation/vessels, then fine normal detail. Restrict very fine detail to shading; it should not distort every silhouette.

Monocular renderings do not determine unseen anatomy, metric dimensions, interior topology, or exact surface geometry. The truthful product label is a video-referenced authored reconstruction, not an extracted VirtaMed asset or an exact patient reconstruction. A separate provenance note can convey this without crowding the operation view.

## Materials and lighting: concrete implementation guidance

These are rendering proposals, not measured physiological constants.

| Component | Target appearance | Practical implementation |
|---|---|---|
| Liver | Smooth continuous capsule; low-contrast coarse pigment variation; sparse fine vessels; red-brown/mauve substrate | Keep broad shape and normals smooth. Use `wholeSceneMaterials` solid-capsule profile as baseline, but inspect clearcoat under a moving near-camera light. Avoid a strong cell/Voronoi grid. |
| Gallbladder | Taut pale/grey/cream translucent-looking wall with irregular fine branches and local fatty concealment | Separate substrate pigmentation from wet film. Vary body/fundus fullness while anchoring neck. Do not force the current green `BASELINE_SEROSAL_OPTICS.gallbladder` on every case. |
| Bowel | Pale pink serosa, broad glossy bends, low-amplitude folds, fine vessels | Do not apply mucosal crypts, ulcers or cobblestones to an intact outer surface. Anchor vascular arcades and fat toward the mesenteric side where known. |
| Mesentery/peritoneum | Thin membrane, connective streaks under tension, local opaque fat and vessels | Split opacity/coverage by layer. Uniform whole-sheet opacity makes the entire structure look ghosted. Use a coherent membrane plus fat coverage, with folds and restrained two-sided/transmission treatment. |
| Fat/omentum | Yellow/cream connected lobules with pale septa and recessed red branches | Geometry handles medium-scale lobulation; normal maps handle smaller structure. Preserve wet highlights across connected surfaces, with dark creases between mounds. |
| Vessels | Hierarchical tapering branches with muted red/purple tones and a soft under-surface edge | Keep true major vessel geometry separate from superficial color masks. No neon-blue veins. Texture-level branches should follow deformation and have unequal sizes. |

The optics literature supports explicit camera-linked illumination and separating reflectance from lighting. A primary calibration study found that correct source positioning matters more than unnecessary light-model complexity. A later endoscopic reconstruction study uses distance-dependent lighting and excludes specular regions from color loss; its own limitation is static reconstruction. Accordingly, use one camera-linked source (or the actual documented rig), restrained indirect fill and a bounded exposure response. Inspect highlights as the camera moves rather than baking bright spots into the texture. Do not claim the project's generated color is calibrated albedo. [Light modelling and calibration in laparoscopy](https://pubmed.ncbi.nlm.nih.gov/32347463/), [Qin et al., 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11166432/)

Real in-vivo liver BRDF estimation exists, but it requires a dedicated acquisition/estimation process. Matching a screenshot's apparent hue and shininess is not that process. [A laparoscopy-based method for BRDF estimation from in vivo human liver](https://pubmed.ncbi.nlm.nih.gov/27728873/)

### Specific existing-code opportunities

- `imports/variations.ts` explicitly documents that it samples synthetic learned controls and does **not** contain a learned texture image. Its current PBR generation must not be presented as newly learned photographic texture. A button promising learned textures must actually bind verified library maps, with their manifest provenance and color-space contract.
- `imports/tissueDetail.ts::configureTissueOptics()` resets sheen to zero, uses restrained normals, and reuses base normal for clearcoat. That is a useful stable export path. Review whether the film should have smoother normals than tissue under grazing light; do not crank both amplitudes to make a still look detailed.
- `wholeSceneMaterials.ts` gives the mesentery global opacity `.34` and `depthWrite=false`. This is suitable for an atlas scaffold but risks an unreal translucent slab in the internal scene. Separate surgical membrane/fat coverage from atlas translucency.
- The whole-scene vascular projection is anchored in rest space, which is valuable for coherent deformation. Preserve that anchoring for every learned/procedural map. Do not recompute mapping from world-space deformed positions each frame.
- `operativeView.ts::createOperativeEnvelope()` is an inferred superellipsoid context layer. The video-matched stage needs camera-specific folds/coverage and a usable working cavity, not just a larger surrounding sphere. Keep the enclosure from obscuring the camera entry or turning black through incorrect sidedness.
- `laparoscopicScene.ts` has name-based tubular identification and anatomy-preserving source structures. Keep vessels/ducts out of generic organ displacement unless their attachment field is propagated with the host.
- Fine texture scale must stay tied to scene units. Review near and wide views so the same capsule does not change into visibly giant pores or a repeated tile pattern as the camera approaches.

## Disease and deformation coupling

Reuse the already documented phenotype families with the same local rest-space masks for shape, color, normal and roughness. The existing hepatobiliary/abdominal reports contain the underlying papers and their limits; their old code-audit findings predate the latest improvements and should not all be treated as still-open bugs.

- A taut cyst-like dome should lose fine underlying relief and carry a coherent wet highlight; a fibrotic/retracted scar should not use the same positive bump operator.
- Cirrhotic liver variants should allow irregularity and edge change without forcing equally spaced nodules or a large visible vascular tree.
- Gallbladder inflammation should couple regional redness/distension and surrounding adhesion coverage while preserving the neck. Do not equate a slider with a clinical grade.
- Bowel disease must be localized along the bowel segment and its mesenteric side. Adjacent loops close in Euclidean space must not inherit the same lesion automatically.
- Fat wrapping, adhesions and membrane traction are changes in neighboring geometry, not yellow or white decals alone.

For force interaction, visible attachments must deform together: tool contact creates a local indentation/tent, adjoining membrane stretches, attached fat follows, and remote supported tissue moves less. A video can constrain image trajectories and relative deformation patterns; without force, camera calibration, scale and boundary conditions, it cannot uniquely identify a physical elasticity value. Label any fitted values by their actual evidence source and distinguish authored priors from measured or fitted parameters. The physics audit should determine what existing solver/inference code can genuinely fit.

## Focused visual acceptance sequence

1. **White reconstruction:** the same three fixed camera views before/after texture; silhouette, overlap and cavity clearance checked. Save the supplied-video reference frame ID beside each comparison. Do not use texture to hide shape errors.
2. **Photographic appearance:** capsule, gallbladder, bowel, fat and membrane at wide, medium and grazing views. Require distinct materials, no normal/UV seams, no baked instrument/shadow/highlight from a training image, and readable shadowed recesses.
3. **Texture ablations:** base color only; normal off; wet layer off; complete material. This separates learned color quality from exaggerated relief and specular lighting.
4. **Disease pair:** same seed, same camera and light, normal/mild/stronger phenotype. Check that the intended contour and color changes coincide and nearby organs retain contact rather than intersecting.
5. **Force/release:** same tool location viewed from at least three angles, then a second location and organ. Check contact patch, anchor behavior, attachment continuity, penetration, recovery, volume drift and texture attachment. Save displacement/force units if the solver truly has them; otherwise use normalized controls.
6. **Motion:** inspect a slow internal walkthrough and force/release clip, not only stills. Highlights must move coherently, textures must not swim, and thin sheets must not pop or sort incorrectly.

The tissue module's `AGENTS.md` requires focused contracts, the tissue browser suite, stills plus the 3840×2160 walkthrough, and actual rendering cadence separate from offline capture throughput after changes there. Respect that contract when touching its material generation, binding, optics or viewer.

No blinded surgeon review, calibrated optical experiment, force calibration, or clinical validation was performed in this research task. The evidence supports concrete improvements and a reproducible inspection protocol, not a claim of perfect or industrially qualified simulation.

## Research files

New references are in `/tmp/viscera-virtamed-research/`: `endoscapes_examples.png`, `cholecseg-overview.png`, `cholecseg-gallbladder.png`, `cholecseg-liver.png`, `cholecseg-connective.png`, and `dsad-wall-04-0.jpg`. They are research-only; the first five have restrictive source terms. Existing DSAD files remain under `apps/studio/public/body-reference/` with their established provenance.

Search used current web search, official dataset repositories/cards, original papers and existing project research. Some direct publisher page fetches failed; the available primary full-text HTML, original paper figures and official dataset records were used instead. No third-party reupload supplied license authority or anatomical ground truth.
