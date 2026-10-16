# Atlas geometry, provenance and remaining source limits — 2026-10-06

The frozen v2 release preserves substantially more anatomical structure than the previous procedural blobs, but remains a collection of authored display surfaces and bounded synthetic morphology. It is not a measured population of organ variation, a photographic appearance dataset or a validated volumetric mechanics dataset.

## Frozen source release and numerical evidence

- Release: `atlas-display-1.1.0`, folder `datasets/atlas/templates-v2`.
- Frozen lock SHA256: `c0f520cae40edb61d78ca0ea5003978425773a5b1c30c0aa291f3257f3520c56`.
- 24 templates, 12 organ groups, 805,715 vertices and 1,441,865 triangles.
- Every selected source geometry hash matches the original v1 selection exactly before cleanup. Original downloaded source bytes were never modified.
- Explicit cleanup removed 820 zero-area triangles from the male heart, removed eight from the female pancreas, and reversed one inconsistently wound male-heart face. No vertex moved; no smoothing, subdivision, reconstruction or decimation was applied. Each NPZ includes original faces, source-to-clean and clean-to-source face maps, and per-face reversal flags.
- All 24 cleaned templates pass finite/zero-area/winding ingestion checks. This does not imply watertightness, freedom from self-intersections or a valid simulation domain.
- 3,840 generated high-resolution geometry checks passed: all 128 seven-control box corners, identity, and 31 random controls for every template. Minimum continuous-map Jacobian determinant: 0.65988995; minimum source-to-deformed face-normal dot: 0.92971694. Maximum round-trip inverse error for the sampled inverse check: 8.53e-14 mm. Runtime 64.24 seconds on the recorded local device. See `benchmarks/results/atlas-geometry-2026-10-06.json`.
- The seven controls are conservative design heuristics. Their bounds are not normal-population reference intervals. Positive continuous Jacobians do not certify discrete triangle collisions or source anatomy.

## What the selected surfaces contain

| Group | Display selection | Explicit exclusions and limits |
|---|---|---|
| Liver | Capsule and named ligaments | Overlapping lobe/segment/diaphragmatic semantic overlays excluded. Capsule can include inner and outer layers. It is not an organ-volume envelope. Gallbladder, ducts and hepatic vessels are separate assets and are not included in this isolated liver. |
| Kidney | Capsule and hilum | Cortex, pyramids, collecting system and papillae excluded from the external display. Hilum openings/internal surfaces remain source-derived. |
| Heart | Four atrial/ventricular components | Septum, valves and papillary muscles excluded from the external display; no circulation or wall mechanics claim. |
| Lung | Bronchopulmonary region surfaces and lobar hilum patches | Internal bronchi/cartilage and duplicate whole-hilum overlay excluded. Region boundaries may produce shading seams; true fissures must not be smoothed away. |
| Brain | Cortical/cerebellar and selected exposed brainstem components | Internal nuclei/white matter overlays excluded. Both sex-labelled templates derive from a common mirrored Allen reference and resizing, not two independent brain observations. |
| Spleen | Named external surface patches and hilum | The only selected HRA group with source UVs; procedural appearance does not use these as photographic texture evidence. |
| Pancreas | Source head, neck, body, tail and uncinate components | Component boundaries preserved; no ductal or histological details inferred. |
| Small intestine | Source bowel components | Papilla/sphincter internal elements excluded. No guarantee of population-representative total bowel length or new loop topology. |
| Large intestine | Source bowel components | Internal ileocecal-valve overlay excluded. Female model is explicitly authored to follow the general Visible Human Female path rather than direct imaging. Male model is mainly SBU colonoscopy-derived and aligned to Visible Human Male anatomy. |
| Urinary bladder | Fundus/base/dome and neck | Trigone/orifice interior overlays excluded; no filling-pressure or stress-free-state claim. |
| Stomach / gallbladder | Official BodyParts3D release 4.0 reduced meshes | Low source resolution; missing fine detail cannot be recovered by subdivision or procedural noise. Physical source units are explicitly assumed millimetres, pending stronger source-unit documentation. |

HRA linear geometry units follow glTF metres, explicitly converted to mm. BodyParts3D native Z-up is rotated -90 degrees around X to display Y-up. The exact matrix and reversible centering are recorded. Patient RAS axes are not inferred. A suspected stomach axis mismatch during visual review was checked against the original OBJ and disproved: native extent `[134.4756,112.8901,117.0100]` correctly becomes `[134.4756,117.0100,112.8901]` in Y-up.

## Exact credits and lineage

Every one of the 22 HRA source objects now has its exact versioned JSON-LD metadata pinned locally, including creators/ORCIDs, source DOI, official citation, license statement and derivation description. The creators are primarily Kristen Browne and Heidi Schlehlein; the female liver credits Kristen Browne alone. The two BodyParts3D sources include the required DBCLS attribution and an unchanged copy/hash of the official current license page. See `templates-v2/ATTRIBUTIONS.md` and `templates-v2/attribution/`.

The four conservative source-group identifiers are ancestry groupings, **not four independently observed human donors**. Their use prevents false independent-anatomy evaluation claims. HRA's female colon is not directly imaged; the male colon has mixed SBU/Visible Human provenance; both brain sex labels share an Allen construction. The exact official derivation text is retained per object.

## Higher-detail stomach and gallbladder: verified but quarantined

The official [release 3.0 documentation](https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/README_e.html) offers a 95% reduction archive and states that it contains five times more triangles than its 99% reduction counterpart. Its listed download is 521 MB; the actual archive is 547,270,545 bytes. HTTP byte-range extraction downloaded only 509,102 bytes to inspect the two organ files.

Archive: `https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/BodyParts3D_3.0_obj_95.zip`

| Candidate | Current v2 vertices / faces | Candidate vertices / faces | Candidate source file SHA256 |
|---|---:|---:|---|
| Stomach, FMA7148 | 914 / 1,810 | 4,694 / 9,384 | `91e3ae25e870d0a6754bc58d410d441b31f94948f9df8483dc9cdcb9bda7276b` |
| Gallbladder, FMA7202 | 1,202 / 2,396 | 6,970 / 13,846 | `412fb458d1859d56348a3277db722928a466910eb6c1e79c9d342918b3cd0c8e` |

Exact ZIP member names are `BodyParts3D_3.0_obj_95\FMA7148.obj` and `BodyParts3D_3.0_obj_95\FMA7202.obj`. Python's ZIP reader checked member CRCs; per-file SHA256 hashes above are recorded. A full archive SHA256 was not calculated because the full archive was not downloaded.

The stomach candidate is watertight and winding-consistent; the gallbladder candidate has an open boundary despite consistent winding. Their source bounds differ from release 4.0, so they are different source constructions, not interchangeable subdivision levels. They require a new template stratum and anatomical comparison before use.

**Licensing prevents promotion into the current commercial track:** the historical release 3.0 page explicitly specifies CC BY-SA 2.1 Japan. The [current database license](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html) was updated to CC BY 4.0, but its applicability to these exact historical files has not been established here. The master context excludes SA material from the commercial track without documented review. Do not transfer the newer license claim silently to these historical assets. Candidate files and their manifest are kept separately at `/tmp/viscera-atlas-highres-candidates`; none were added to frozen v2 or its training dataset.

This is a real source-resolution opportunity for future rights review, not fabricated detail from smoothing or subdivision.

## Independent visual review

Inspected the all-24-template Studio contact sheet and individual actual renders of both liver references, stomach and male lung. The liver silhouettes and ligament separation preserve clear source-specific differences. The first material/light rig was too pale and glossy; the revised contact sheet uses reduced lighting. The displayed stomach view emphasizes an ovoid fundus/body; additional views are needed to judge cardia, pylorus and lesser-curvature visibility. Lung regional seams/fissures remain visible; normal interpolation across coincident patch boundaries can improve lighting, while geometric smoothing would risk hiding real anatomical boundaries.

The similar male/female brain silhouettes agree with their shared Allen construction; they must not be counted as independent brain anatomy. The flattened urinary bladders have an undocumented filling state, so this review does not classify them as pathological or expand them to an assumed full state. Different kidney views expose source capsule/hilum recesses rather than a filled parenchymal solid. No further gross omission of the selected external components was identified in this engineering review. These observations are not independent anatomical expert sign-off or proof of physical plausibility.
