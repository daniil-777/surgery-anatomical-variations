# Surface vascular appearance: research and implementation

Research and implementation date: 7 October 2026. Scope: editable organ-surface appearance in VISCERA, carried through sculpture and Unity texture baking. Confidence: high in the numerical attachment and renderer design; moderate in visual plausibility; no clinical anatomical or optical validation.

## Decision

Represent vessels as a connected, tapered network in **template rest millimetres**, with explicit triangle/barycentric attachments and a separate shallow-tissue appearance field. Keep this field attached to the host organ's existing material coordinates during sculpture. Render a softened absorbing core, a wider halo, and restrained relief. Export the same field through the CPU material baker.

The implementation is a **procedural surface design prior**. It does not identify coronary arteries, infer a portal venous tree, generate a closed circulatory system, or solve blood flow. Organ-specific numerical presets are authored appearance choices. There is no defensible claim that a single random branching system is anatomically correct for every organ.

## Questions and evidence

### What gives a vascular pattern coherent structure?

Murray's minimum-work analysis provides the classic radius relation `r_parent³ = Σ r_child³` under its flow assumptions. This is useful as a hierarchy prior: trunks should reflect downstream demand instead of receiving independent random thickness. The law is not a universal measured description of every vascular bed. [Murray, 1926](https://pmc.ncbi.nlm.nih.gov/articles/PMC1084489/)

Constrained constructive optimization (CCO) grows a tree by adding terminal segments, selecting attachment sites, optimizing bifurcations, and rescaling to satisfy pressure/flow constraints. It is a much stronger physiological construction than drawing arbitrary curves. Its original comparison reported agreement with coronary structural and pressure characteristics. Implementing only taper and branching is therefore not equivalent to implementing CCO. [Schreiner and Buxbaum, 1993](https://pubmed.ncbi.nlm.nih.gov/8225337/)

Space colonization grows branches toward distributed attraction points and removes already-served points. Its strength for authoring is local, interpretable control of coverage and branching. Its published application is botanical tree generation, not proof of human vascular anatomy. On a highly concave organ, unconstrained Euclidean growth can cross the interior or jump between nearby folds; a surface application needs intrinsic routing or projection with locality constraints. The last sentence is an engineering inference from the algorithm and the mesh setting. [Runions, Lane and Prusinkiewicz, 2007](https://algorithmicbotany.org/papers/colonization.egwnp2007.pdf)

### What has improved beyond classic CCO?

Jessen and colleagues combine topology and global geometric optimization and explicitly address nonconvex boundaries and multiple nonintersecting trees. Their examples include brain and liver. This is especially relevant for a future true vascular-volume mode: a surface atlas shader should not claim those guarantees merely because its endpoints lie inside or on an organ. Our surface routing avoids interior shortcuts on its initial graph, but it is not their global optimization method. [Jessen et al., 2024 preprint](https://arxiv.org/html/2410.06002v1)

The 2025 Science work by Sexton and colleagues supplies a generation-to-simulation/fabrication workflow for organ-scale synthetic vasculature. The paper points to the authors' `svVascularize` implementation and public supplementary data. It is the more suitable starting point for future volume-filling vessels and CFD-ready watertight networks than extending a fragment shader into an unvalidated flow solver. Its fabrication and flow objectives differ from this interactive surface appearance task. [Sexton et al., Science 2025, author-hosted paper](https://shiwarskilab.com/wp-content/uploads/2025/06/41_science.adj6152.pdf), [author supplementary data](https://zenodo.org/records/15588568)

### Why does a realistic shallow vessel differ from an opaque tube?

Donner and colleagues model layered, spatially heterogeneous absorption and scattering; their examples include vessel-like detail between scattering layers. This establishes why a surface pigment stripe alone misses relevant optical mechanisms. Their model concerns skin, so transplanting its coefficients to liver or kidney without measurement would be unjustified. [Donner et al., 2008](https://gfx.cs.princeton.edu/pubs/Donner_2008_ALH/donner08hskin.pdf)

Zoller and Kienle derive a fast blood-vessel appearance lookup table from Monte Carlo light transport and fit spatial profiles using sums of Gaussians. Vessel depth, diameter, and tissue/blood optical parameters affect appearance. We use this as motivation for depth-softened profiles and reduced contrast, **not** as a claim that our hand-authored two-profile shader reproduces their transport solution. [Zoller and Kienle, 2019](https://www.ilm-ulm.de/fileadmin/files/literatur/zollerFast_and_precise_image_generation_of_blood_vessels_embedded_in_skin.pdf)

### How should anatomy constrain the default appearance?

Human liver capsule measurements show disease-related changes in capsule structure and vascular populations. Those findings argue against assigning one visually dramatic vascular pattern to both a normal and diseased capsule, but do not specify a universal gross-surface shader texture. VISCERA therefore keeps density, visibility, and calibre as independent design controls and does not silently couple vessel density to a disease label. [Glisson's capsule matrix structure and function in cirrhosis](https://pmc.ncbi.nlm.nih.gov/articles/PMC10393548/)

Measured kidney vascular graphs are available from hierarchical phase-contrast tomography. Such data, with its acquisition limitations and license, is a better future basis for anatomical validation than tuning a random tree until it looks convincing. The implementation does not currently ingest this graph. [Mapping the arterial vascular network in an intact human kidney, 2025](https://www.nature.com/articles/s44303-025-00090-2.pdf)

## Implemented method

### Surface topology and attachment

1. Weld coincident rest-space vertices for routing, so duplicated UV seams do not create artificial disconnected vessels.
2. Build the actual triangle-edge adjacency graph. Handle disconnected components separately; ignore tiny fragments that do not support a meaningful network.
3. Sample area-weighted terminal territories with an exclusion distance, then add clustered finer terminal sites within local 7–12 mm neighbourhoods (scaled to organ size). Fine sites carry 0.16 relative demand, so they generate narrower local twigs rather than a uniformly dense web.
4. Grow a rooted tree by connecting each terminal to the current network with weighted surface-graph routing. Grow major territories before fine terminals. A smooth positive spatial cost and a turning penalty produce coherent corridors without Euclidean shortcuts through the organ.
5. Sum downstream terminal demand and derive calibre with exponent three, with a small lengthwise taper and fading terminal endpoints. Palette identity remains stable when density changes.
6. Relax junctions with a local radius-squared weighted geometric-median step, round the initial direction of smaller daughter branches, and add sub-millimetre coherent tortuosity. Project every edited sample onto nearby original triangles. Store each endpoint's triangle and barycentric coordinates.

Root placement is a seeded geometric choice, not an anatomical hilum detector. The routing is a graph approximation to an intrinsic path, not an exact geodesic solver. Local smoothing does not provide a proof of global nonintersection. These are explicit limits of the interactive design layer.

### Appearance field and deformation

For each tapered segment, project the sample point onto its centreline. Let `d` be that distance, `r` the interpolated radius and `z` the authored tissue depth. With screen footprint `f`:

```
w = r + 0.2 z
w²_filtered = w² + 0.2 f²
core = exp(-2 d² / w²_filtered - 0.8 z) × facing × w/sqrt(w²_filtered)
halo_width = 2.3 r + 0.7 z
halo = exp(-2 d² / halo_width² - 0.8 z) × facing
opacity = visibility × (0.62 core + 0.12 halo)
height_mm = visibility × 0.1 r × core
```

The field is cut off after twice its halo width. `facing` is a smooth gate on the dot product of the rest face normal and segment normal; it prevents obvious transfer to an opposite-facing nearby wall. It does not distinguish all same-facing overlapping sheets. Max unions avoid over-dark junction blobs. The two muted palettes are linear RGB constants shared by TypeScript, GLSL, and Python, with artery/vein labels describing palette families rather than diagnostic identity.

Surface position changes leave `atlasRestPosition` unchanged. As the triangle deforms, rest coordinates interpolate with it, so vessels do not slide across tissue or float above it. The normal perturbation pulls the radial rest gradient into the current deformed tangent plane. Calibre therefore deforms with the material; we do not claim incompressible cylindrical blood vessels under arbitrary sculpture.

The shader uses a conservative spatial grid and variable-length candidate lists. All segments whose support can affect a cell are retained. There is no nearest-eight or nearest-sixteen truncation that could abruptly remove vessels at complex junctions. Texture resources are disposed with the material.

### Export contract

`organ.metadata.surface_vessels` stores version `surface-vessels-design-1.0.0`, seed, organ identity, procedural provenance, settings, segments, attachments and statistics. The API request passes `surface_vessels: [{organ_id, network}]`, linking the layer to its host mesh.

The Python evaluator accepts rest points and canonical rest face normals, computes identical compact-support fields with a conservative KD-tree query, and returns linear colour, roughness, relief and radial rest gradient. The baker adds that gradient to the tissue gradient before tangent-space normal encoding. Mirrored UV islands require canonical rest normals from triangle winding, not an uncorrected cross product of UV derivatives.

## Verification and acceptance limits

Automated checks cover determinism, density response, fine terminal generation, triangle attachment reconstruction, rest-space invariance under affine sculpture, nonnegative tapered radii, unit normals, junction cube-law residuals, exact analytic CPU/reference field values, opposite-facing wall suppression, max-union junctions, 300 coincident GPU candidates without truncation, visibility updates, resource disposal and malformed export payloads. Shader checks supplement real WebGL render inspection; text insertion tests alone cannot prove that a GLSL program compiles.

Four visual iterations were reviewed on actual HRA meshes. Iteration 1 had long parallel root spokes; iteration 2 shared trunks but left abrupt T junctions; iteration 3 added junction/tangent relaxation and tortuosity; iteration 4 added clustered fine terminal demand. Final captures use Studio's inspection lights and 0.82 exposure, with density 0.5 and visibility 0.65. Liver front/back, heart and kidney rendered without WebGL compile errors. These captures are visual engineering evidence, not a realism score against surgical photography.

At those settings, the liver network has 1,448 segments, 138 terminal tips (115 fine) and 136 branch junctions. Heart has 1,484 segments and 158 terminal tips; kidney has 784 segments and 98 terminal tips. The maximum relative residual in `r_parent³ = Σ r_child³` across final non-root junctions is below `1.3 × 10⁻¹⁵` for all three. Tapered endpoint radii are rendering supports and should not be interpreted as measured lumen calibres. The forest may have multiple roots because source meshes contain disconnected anatomical components.

A separate cross-language check sampled 192 locations around the final liver tree, including centreline, core edge and outer halo. TypeScript and Python fields agreed within `8.4 × 10⁻¹⁷` for opacity/core, `1.8 × 10⁻¹⁸` mm for relief, and `7 × 10⁻¹⁸` for the radial gradient. This checks evaluator parity, not equality of rasterized WebGL pixels and a baked Unity texture under different lights and antialiasing.

The task's visual goal should be assessed at both full-organ scale and close-up, in front/back/oblique views, with vessels enabled/disabled and after sculpture. Plausibility is not anatomical validation. Remaining work for anatomical fidelity is to add landmarks or measured centreline data, organ-specific territories, vessel-system identities, measured optical calibration, and independent expert review. A separate volumetric/flow representation is necessary for hemodynamics or surgical planning.

## Methodology

Used the `ecc:deep-research` workflow with the available web search tool; Firecrawl and Exa connectors were unavailable. Investigated topology/growth, calibre laws, nonconvex routing, layered optics, organ-specific evidence and export/deformation fidelity. Searched primary publications, author institutional pages and author data repositories. Deep-read the Runions paper, the Donner and Zoller/Kienle PDFs, and the Jessen full-text manuscript; reviewed the other linked primary records. Recent methods are distinguished from foundational work, and implementation choices above are engineering inferences rather than claims of equivalence to those papers.
