# Tissue interfaces in the reconstructed laparoscopic field

Research and implementation review, 25 October 2026. Confidence is high in the rendering principles, moderate in the anatomical classification of the visible attachments, and low in any inferred hidden anatomy or patient-specific appearance. This is an authored reconstruction; a monocular simulator video cannot identify complete anatomy, scale, optical coefficients or mechanical parameters.

## Why the old joins looked separate

The previous material fades interpolated only RGB on the sheet. The host organ retained a different color, roughness, projection frame and highlight normal. A transparent sheet could also reveal a different underlying surface at the root. Shape variation and deformation then made these differences more conspicuous. Separately, the fatty apron had a visibly thick, uniformly opaque edge.

The solution is a typed interface system, not unrestricted nearest-organ color mixing. The same material field should meet at a true insertion, while a free contact should retain two independently moving surfaces.

## Anatomical basis

The gallbladder bed involves a fibroareolar interface with the liver. The cystic plate and surrounding connective layers are operative landmarks, rather than a uniform continuation of gallbladder color across the liver. Operative anatomy work supports constructing a thin connective sheet with distinct insertions. [Tokumitsu et al., surgical anatomy](https://onlinelibrary.wiley.com/doi/10.1002/ags3.12568).

Histological work distinguishes fibrous, vessel-containing and fatty portions of gallbladder subserosal tissue. This motivates a spatially varying interface with small vessels and fine fibers, but does not provide measured optical coefficients for this scene. The study excluded acute inflammation; its normal anatomy should not be treated as a calibrated cholecystitis model. [Primary histological study](https://www.frontiersin.org/journals/surgery/articles/10.3389/fsurg.2024.1487568/full).

Human fascia research also distinguishes investing tissue from thicker or differently organized insertional layers. We therefore keep thin surface detail separate from the shape and thickness of the larger connective sheets. [Stecco et al., visceral fascia anatomy](https://onlinelibrary.wiley.com/doi/full/10.1111/joa.12617).

Mesenteric continuity provides a useful reference for vascularized connective tissue meeting bowel. It does not imply that every visible overlap of bowel and fat is a fused attachment. [Coffey et al., mesenteric anatomy](https://www.nature.com/articles/s42003-021-02496-1). Experimental mesothelial friction work supports preserving a sliding surface interpretation at free contacts; that rat-tissue experiment is not a measurement of these human organ pairs. [Mesothelial friction study](https://pubmed.ncbi.nlm.nih.gov/16214486/).

## Implemented pair treatments

| Pair in this scene | Treatment | Variation and motion |
|---|---|---|
| Liver–cranial sheet | Shared capsule insertion; 13 mm authored visual band | Both materials meet in the same rest field; liver recipe drives sheet optics |
| Liver–hepatocystic membrane | Shared fibrous insertion; 7 mm visual band | Liver and gallbladder recipes jointly condition the membrane and root |
| Gallbladder–hepatocystic membrane | Shared capsule insertion; 7 mm visual band | Gallbladder phenotype reaches the adjoining sheet gradually |
| Gallbladder–cystic duct | Continuous neck ring; 5 mm visual band | Full ring remains registered under the common shape and physics maps |
| Fatty apron over bowel | Thin-cover approximation at supported rim samples | Bowel and fat recipes affect the rim appearance; no host welding |
| Other unregistered or separated pairs | Independent serosal materials and existing scene shadows | No invented adhesion, color transfer across an air gap, or contact constraint |

The millimetre band widths are display choices, not anatomical fascia thicknesses. The legacy internal identifier `hepatoduodenal-ligament` represents the UI's **hepatocystic membrane** in this reconstruction; it is not a claim that the displayed sheet reconstructs the complete hepatoduodenal ligament.

Four attachment pairs use 188 registered root entries, including the repeated closure vertex of the duct ring. These are actual vertices of both meshes, not nearest floating sample points. The internal fatty bridge has another 42 registered coordinates within one material domain. The broader shared deformation map preserves coincident coordinates.

## Rendering method

1. Build a graph from the exported attachment metadata. Reject a missing host or a root that is absent from either surface.
2. Compute distances once on each rest mesh using multi-source Dijkstra over triangle edges, with zero-distance links across coincident UV-seam vertices. The distance cannot jump across a nearby disconnected fold. This is an edge-graph approximation to intrinsic distance, **not** an implementation of the heat method. The latter is a useful future option for higher-quality offline geodesic fields. [Crane et al., heat method](https://www.cs.cmu.edu/~kmcrane/Projects/HeatMethod/).
3. Use a smooth finite band, `w = 1 - smoothstep(0, width, distance)`. Each pair evaluates one common material from both endpoint recipes at the same rest position and projection frame. The host and insertion approach this common material at the root. Overlapping bands use normalized influence weights, with a numerical endpoint tolerance of approximately 1e-5.
4. Blend linear RGB, perceptual roughness, wet-coat amount and roughness, substrate slopes and small-scale height. The dielectric index remains common at 1.37. Linear input blending is a practical real-time approximation, not a physically exact multilayer BSDF. [MaterialX PBR specification](https://materialx.org/assets/MaterialX.v1.38.PBRSpec.pdf), [Filament material parameterization](https://google.github.io/filament/main/filament.html#materialsystem/parameterization/blendingandlayering).
5. Decode normal maps to slopes using `-normal.xy / normal.z`, combine the gradients, then perturb the current deformed tangent frame once. The wet coat receives a weaker version of the same relief. Texture gradients are explicit inside conditional band sampling, avoiding undefined implicit derivatives at branch boundaries. This follows the surface-gradient approach to composing bump detail. [Mikkelsen, surface-gradient bump mapping](https://jcgt.org/published/0009/03/04/paper-lowres.pdf), [Hill, blending normal-map detail](https://blog.selfshadow.com/publications/blending-in-detail/).
6. Keep color textures sRGB and packed normal/roughness data untagged. Three.js performs shading in its linear working space. Three verified learned RGB families occupy one texture array; their derived normals and roughness occupy a second array, avoiding a separate sampler for every adjacent tissue. [Three.js color management](https://threejs.org/manual/pages/color-management.html).
7. Use opaque registered insertions to avoid transparent-root sorting artifacts. Reconcile oriented normals at shared root vertices after geometry updates. Opposing sheet backs keep opposite normals.

The apron edge tapers to 0.12 mm before modulation. A one-sided cover field is generated only where its rest rim has a bowel support within 1.4 mm. Its material approaches the supported bowel appearance as the cover thins. This approximates partial coverage/translucency using opaque PBR blending; it is not volumetric light transport. The host bowel is unchanged. The interior remains fatty tissue and unsupported gaps do not receive a transfer field.

## Joint variations and mechanics

The graph, material fields, microrelief and vascular coordinates live in rest space. The existing shared learned shape controls and authored disease fields move the geometry together, carrying those fields without texture swimming. Each insertion evaluates both endpoint recipes, including disease pigmentation, at the same coordinate. Material signatures include the endpoint recipes and interface version, so a change in either endpoint invalidates the material correctly. The membrane derives its optics from liver and gallbladder recipes instead of inheriting an unrelated fallback recipe.

Band widths have bounded recipe-dependent wetness/detail modulation. Cholecystitis also has an explicitly authored small widening of the applicable insertion band. This is an illustrative phenotype rule, not a learned histological relationship. No new clinical training or measured optical/force fitting was performed in this update.

Current mechanics remain a coupled reduced-order viscoelastic preview. They preserve registered roots but do not resolve organ–organ collision, arbitrary new sliding contact, fluid pressure or volume-preserving continuum mechanics. The cover fields describe the authored rest supports, not a dynamic contact detector. Large motions can therefore expose approximations that a full contact solver would need to resolve.

## Review and evidence

Automated tests cover root registration, disconnected-fold isolation, finite fields, smooth band endpoints, both-parent recipe sensitivity, exact seed replay, cover support gating and invariant rest masks under deformation. The browser review captures healthy tissue and five disease variations from several angles at 1.5× pixel density, then tests guarded push/grasp/release at three views. Captures and receipts are kept separately as review artifacts; a passing test suite does not establish clinical realism.

The visible field is still stylized: vessel trees and optical detail are procedural or learned preview textures; hidden surfaces, absolute scale and anatomy are inferred. The reference supplies a target composition and appearance, not a recoverable ground-truth 3D scene. Surgeon assessment and measured biomechanical data remain necessary before any training-validity claim.

## Method

The research separated anatomy, material blending, normal composition, deformation alignment and validation. Anatomy and rendering were researched independently, then checked against the local renderer, scene generator, exported mesh metadata and the supplied video frames. Primary papers, author publications and official renderer documentation were preferred. Firecrawl/Exa were unavailable in this session, so browser search and direct source reading were used. No third-party surgical images or simulator pixels are redistributed by this change.
