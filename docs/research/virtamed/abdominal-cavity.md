# Abdominal cavity enclosure — 25 October 2026

The previous video-field wall was an open posterior bowl: it had no anterior, lateral-return or superior enclosure around the scope. The replacement is a closed inward-facing parietal lining. Its anterior dome surrounds the operative camera, while its posterior surface remains behind the reconstructed organs. It is an authored upper-abdominal context surface, not a patient reconstruction.

## Evidence and interpretation

An in-vivo motion-analysis study reports the abdominal wall changing from a cylindrical form to a dome during insufflation, with different transverse and sagittal stiffness. This supports an asymmetric anterior dome instead of a uniformly scaled sphere. Its reported material values are not directly assigned to this mesh: neither the patient's geometry nor pressure is known. [Song et al., *Mechanical properties of the human abdominal wall measured in vivo during insufflation for laparoscopic surgery*, 2006](https://pubmed.ncbi.nlm.nih.gov/16738998/).

A patient-specific pneumoperitoneum study used segmented abdominal wall, viscera and gas-space structures, optimizing its simulation against inflated porcine CT and checking feasibility with human surface measurements. This is evidence that patient geometry and calibration matter; a monocular simulator reference does not provide those measurements. The current shell therefore has an explicit authored-evidence label. [Dawda et al., *Patient-Specific Simulation of Pneumoperitoneum for Laparoscopic Surgical Planning*, 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6736924/).

## Implementation

- Closed welded topology with inward winding and normals; no pole degeneracies or duplicated meridian seam.
- A 255 mm transverse radius and 215 mm superior–inferior radius surround the visible upper-abdominal field. These are assumed scene units, not anatomical measurements.
- Posterior depth is approximately −124 mm and the anterior dome extends to 320 mm. The standard scope at `(−4, −32, 247)` has room inside the dome.
- Broad posterior support and shallow bilateral reflection ridges replace repeated spherical corrugations. Serosal microdetail belongs in the material.
- Front-side rendering with inward normals shows the lining from inside. External inspection sees a cutaway because the near shell is back-face culled.

## Verification

Focused tests check closed two-manifold topology, consistent inward winding, unit normals, deterministic output, the scope's working-space clearance, obstruction of outward camera motion, and sampled vertices across all eleven reconstructed organs remaining enclosed. The asset integrity test compares the generated GLB with the same source geometry.

These checks establish geometric consistency, not clinical fidelity. The camera, instrument contact response and material appearance require separate rendered and temporal inspection. A pressure-calibrated wall, complete lower abdomen and patient-specific folds remain outside this reconstruction's evidence.

## Subsequent attachment precision repair

The first enclosure iteration preserved all eleven existing organ position arrays exactly. Later extreme-contact testing exposed a pre-existing liver attachment sliver whose altitude was smaller than Float32 coordinate precision. The final asset supersedes that byte-identity statement: attachment insertion now snaps to a vertex or edge using a physical tolerance derived from storage precision and splits all incident faces, including duplicated UV-seam edges. It does not delete anatomical surface coverage or loosen force/strain checks.

Relative to the enclosure-only asset `b9df1d654067fe54becbe04fbe3cf0675da3bc0ef89b2fd7f5ce48d6322db2c3`, the final asset has these measured differences:

| Part | Quantified repair |
| --- | --- |
| Liver | One previously inserted point is reused at an existing vertex: 24,323 → 24,322 vertices and 48,641 → 48,639 triangles. Two old unique coordinate keys are replaced by one new key. Maximum measured source-hit to stored attachment displacement is 0.000118312 mm; the largest snap tolerance is 0.000122070 mm. |
| Hepatocystic membrane | 84 unique coordinates follow the corrected root/interpolation; maximum nearest-coordinate change is 0.000115489 mm. |
| Connected fat | 36 unique coordinates change by at most 0.000007630 mm after exact edge reprojection and dependent bridge interpolation. |
| Other nine parts, including the cavity | Position arrays remain unchanged from the enclosure-only asset. |

The new GLB is 4,553,248 bytes, SHA-256 `e0778985a61547fff92d0359adeb17e72ae5f87e2d7d51bb870b72e222c74b2a`, retaining scene version `viscera.video-field/3`. Registration statistics are embedded as deterministic host metadata. The detailed comparison and earlier asset are preserved in the local `precision-repair` review evidence.

Five precision-regression tests cover near-edge and near-vertex insertion at translated coordinate scales, all incident triangles, UV seams, and retained interior area. Interface tests preserve exact shared attachment coordinates. The separate 24-case mesh stress run subsequently passed without weakening its orientation thresholds; see [contact methods and results](./anatomical-contact.md).
