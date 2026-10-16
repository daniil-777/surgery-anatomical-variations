# Paired disease source cases

`viscera_core.atlas_disease_dataset` turns the collected clinical annotations into a separate, immutable geometry cohort. It keeps source evidence distinct from the authored disease controls in the editor. Existing healthy atlas and procedural releases are unchanged.

The collected 36 disease photographs and 13 external model viewers do **not** supply 36 paired 3D diseases. They are reference material. The measured cohort contains three pancreatic adenocarcinoma cases under CC BY 4.0, and four optional KiTS19 kidney tumor cases under CC BY-NC-SA 4.0. These seven cases are too few to estimate a disease population, learn realistic prevalence, infer histology from shape, or calibrate mechanical behavior. More generated meshes do not create more independent clinical patients.

## Reproduce and verify

Run from the `viscera` project with its Python environment installed (including `nibabel>=5,<6` for ingestion):

```sh
PYTHONPATH=py python -m viscera_core.atlas_disease_dataset build \
  --gallery ../reports/disease-anatomy-references-2026-10-07 \
  --output disease-releases/clinical-ccby-v3 --point-count 2048

# This separate lane contains noncommercial/share-alike source material.
PYTHONPATH=py python -m viscera_core.atlas_disease_dataset build \
  --gallery ../reports/disease-anatomy-references-2026-10-07 \
  --output disease-releases/clinical-nc-v3 --point-count 2048 --allow-noncommercial

PYTHONPATH=py python -m viscera_core.atlas_disease_dataset verify \
  disease-releases/clinical-ccby-v3
```

The gallery directory must contain its published `catalog.json`, local part meshes, source NIfTI masks and provenance files. Building never fetches assets from an unaudited URL. Checksums must agree with the collected source catalog. A different recipe or altered source file requires a new output directory; an existing release is verified and never regenerated in place. A failed build leaves no partial destination release.

## Source and rights lanes

| Source | Cases | Annotation | License and reuse lane |
|---|---:|---|---|
| [Zenodo 5510650](https://zenodo.org/records/5510650), [source study](https://pubmed.ncbi.nlm.nih.gov/33840636/) | 3 | Aligned pancreas and pancreatic adenocarcinoma masks; head/uncinate, body and tail examples | CC BY 4.0; default attribution lane |
| [KiTS19](https://github.com/neheller/kits19), [data license](https://github.com/neheller/kits19/blob/master/data/LICENSE) | 4 | Label 1 kidney parenchyma, label 2 tumor; clear-cell RCC, angiomyolipoma, oncocytoma | CC BY-NC-SA 4.0; explicit noncommercial/share-alike opt-in |

The KiTS repository's code license is not the annotation/data license. The mixed release is not a commercially unrestricted release. Every record carries `creator`, `license_spdx`, `license_url`, `license_lane` and `source_url`; there is no blanket release license that removes source conditions. Source clinical metadata and original NIfTI annotations accompany each applicable lane. View-only models, unlicensed previews and gross pathology photographs are not copied into training tensors.

## Physical geometry contract

Each `cases/{case_id}` directory contains:

- `geometry.npz`: `organ_vertices_mm`, `organ_faces`, `lesion_vertices_mm`, `lesion_faces`, preserving every vertex and triangle of the collected part meshes. No smoothing, decimation or invented detail is introduced.
- `organ.glb` and `lesion.glb`: exact copied display assets with their original shared display frame and glTF metre units. **Use `geometry.npz` for canonical RAS millimetres.** Pancreatic GLB uses the documented Y-up display rotation; KiTS GLB retains the original NIfTI frame.
- The exact source `.nii.gz` annotation file(s), their SHA-256 digests, label values and full voxel-to-RAS affine.
- `measurements.json`: mask-derived volume, mask centroid, mesh surface area, mesh extents, source spacing/units and QA evidence for each role.
- `points.npz`: reproducible area-weighted surface points and normals for both roles, measured features and one shared physical normalization frame.

The source mesh bounds must agree with the annotation's physical bounds. Mesh vertices must map back onto the source marching-cubes half-voxel grid. These checks detect shifted anatomy, lost transforms, wrong rotation and metre/millimetre errors. Source surfaces must be finite, watertight and positively oriented. Self-intersections, internal vasculature and specialist anatomical acceptability are **not** established by these checks.

KiTS NIfTI headers have an `unknown` spatial-unit field; the recorded millimetre interpretation comes from the dataset's physical-coordinate convention, and that distinction is retained. Pancreas NIfTI headers explicitly specify millimetres. Pancreas source metadata here does not supply age, so the release does not claim confirmed adult age for those three cases.

KiTS label 1 contains **both kidneys**, with the tumor label excluded from parenchyma. Its organ volume, bounding box and relative lesion location are bilateral measurements. They must not be used as affected-kidney proportions without a separately documented component selection. Pancreas and lesion are retained as separate source masks; they are not artificially unioned, dilated or carved to agree.

Volumes in `features` come from annotated voxel count times the absolute determinant of the source affine, expressed in mL. Mesh-derived volumes are separately recorded. Extents come from the unsmoothed source surface. `lesion_center_*_relative` is `(mask lesion centroid - organ bounding-box center) / organ XYZ extent`. It is an engineering coordinate, not a severity grade or clinical anatomical label. No source provides measured wet tissue appearance, elasticity, stiffness, friction or rupture threshold.

## Training interface and split integrity

```python
from viscera_core.atlas_disease_dataset import read_split, load_case, verify_release

release = verify_release("disease-releases/clinical-ccby-v3")
train = read_split("disease-releases/clinical-ccby-v3", "train")
record, geometry = load_case("disease-releases/clinical-ccby-v3", "PDA-C3L-00622")
```

`train.npz`, `val.npz` and `audit.npz` contain:

| Key | Shape / meaning |
|---|---|
| `case_ids`, `group_ids`, `source_ids`, `organ_names`, `disease_codes`, `license_lanes` | `(N,)` strings, no pickle/object arrays |
| `organ_points_mm`, `lesion_points_mm` | `(N, P, 3)`, shared RAS physical millimetres |
| `organ_normals`, `lesion_normals` | `(N, P, 3)`, unit surface normals in the same frame |
| `organ_points`, `lesion_points` | `(N, P, 3)`, both normalized with the same organ frame |
| `center_mm`, `scale_mm` | `(N,3)`, `(N,)`; organ bounding-box center and maximum XYZ extent |
| `features`, `feature_mask`, `feature_names` | `(N,12)`, `(N,12)`, `(12,)`; finite measured descriptors and their names |

Feature order is organ XYZ extents, organ volume, lesion XYZ extents, lesion volume, relative lesion XYZ center and lesion/organ volume ratio. Units are explicit in each feature name. Train-only preprocessing and fitted parameters must remain separate from validation/audit data.

Patients are grouped before any resampling. Each source reserves one validation and one audit patient; remaining patients are training. The default three-case cohort therefore has one patient in each split. Adding the KiTS license lane preserves existing pancreas assignments and yields three training, two validation and two audit patients overall. This is a small holdout engineering check, not a reliable disease-generalization benchmark. Single-patient disease classes have no estimable learned covariance.

Every future crop, view, resampled cloud, texture derivative and synthetic disease edit must inherit its source/patient split. Augmentation seeds and rendered images are not independent patient identities. The reference morphology registry is metadata-only, with `numeric_parameter_ranges=null`, `measured_mechanics=null`, `paired_3d_case=null` and `training_label_eligible=false`. It can guide specialist review and authored controls; it must not be silently converted into measured targets.

`release.json` hashes every artifact, freezes the generator and shared dataset-helper source snapshots, and records Python/NumPy/trimesh/nibabel versions. Verification additionally cross-checks source mask digests, patient identities, recipe splits, rights lanes, measured feature values, tensor metadata, normal lengths and the shared organ/lesion normalization. Tampering, missing files, directory traversal and symlink escapes fail explicitly.
