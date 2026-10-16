# Realized disease geometry cohort

`geometry-v1` contains actual sampled disease-design surfaces, not only nine-dimensional control recipes. The default build materializes **200 surfaces: eight for each of 25 supported disease profiles across all 12 organ families**, with 150 training, 25 validation and 25 audit examples. The 11 reference-only profiles remain excluded because the current templates do not contain the internal anatomy needed to depict them responsibly.

The cohort is an **authored surface-design dataset**. It contains zero independent disease patients. Its holdout recipes share reference anatomy lineages with training. Geometric checks establish finite, reproducible surface construction; they do not establish anatomical realism, surgical suitability, biological disease progression or tissue mechanics.

## Rebuild, inspect and replay

From the `viscera` project:

```sh
PYTHONPATH=py python -m viscera_core.atlas_disease_geometry_dataset build \
  --recipes disease-releases/recipes-v2 \
  --templates datasets/atlas/cohort-v2/templates \
  --output disease-releases/geometry-v1 --point-count 2048

PYTHONPATH=py python -m viscera_core.atlas_disease_geometry_dataset verify \
  disease-releases/geometry-v1
```

```python
from viscera_core.atlas_disease_geometry_dataset import read_split, replay_record

root = "disease-releases/geometry-v1"
train = read_split(root, "train")
scene = replay_record(root, str(train["sample_ids"][0]))
# scene is the same full-resolution editor realization, with its bound spec,
# source triangle indexing, geometry digest, normal digest and measurements.
```

The published release directories are frozen. Use a fresh output directory when changing a build recipe or decoder; never overwrite an existing release. In the portable bundle, use `disease-releases/geometry-v1/templates` as the template input for a fresh rebuild.

The release carries its own `templates/` folder, compatible with the editor's atlas loader. All 24 available source templates, their original metadata, license evidence and attribution files are copied once. Template selection cycles deterministically through the available sex/laterality references for each organ. Source geometry is not duplicated for every generated sample. Shared templates plus the bound editor spec and frozen decoder reconstruct every full-resolution surface without remeshing or changing vertex/triangle indexing.

Ordinary atlas shape controls stay at zero in this cohort to isolate disease-design changes. Variation comes from the parent disease recipes and the available reference anatomies. The full editor still supports its separate bounded shape controls; those combinations are not silently added to this dataset.

## Stored tensors

Every split NPZ uses numeric/string arrays without pickle objects. `N` is the number of examples and `P=2048` for the delivered release.

| Key | Shape | Meaning |
|---|---|---|
| `points_mm` | `N × P × 3` | Area-weighted samples of the realized, full-resolution triangles in physical millimetres |
| `point_normals` | `N × P × 3` | Interpolated displayed vertex normals, renormalized |
| `face_normals` | `N × P × 3` | Geometric normals of the sampled realized triangles |
| `rest_points_mm` | `N × P × 3` | Corresponding undeformed template positions, using the same triangle and barycentric weights |
| `colors_srgb` | `N × P × 3` | Editor vertex colors interpolated in linear RGB, encoded as sRGB; authored appearance, not calibrated tissue imagery |
| `surface_face_ids` | `N × P` | Original source triangle indices |
| `barycentric_coordinates` | `N × P × 3` | Exact stored sampling weights for correspondence and replay checks |
| `disease_design_mask` | `N × P` | Compact-support weight of the authored surface modifier; **not a clinical lesion segmentation** |
| `points`, `center_mm`, `scale_mm` | `N × P × 3`, `N × 3`, `N` | Normalized points and their reversible physical frame |
| `features`, `feature_names` | `N × 6`, `6` | Measured XYZ extents, surface area, maximum disease displacement, and applied displacement fraction |
| `recipe_features`, `recipe_feature_names` | `N × 9`, `9` | Unchanged parent recipe conditioning features |
| `sample_ids`, `group_ids`, `parent_sample_ids`, `profile_ids`, `organ_names`, `template_ids` | `N` | Identity and original parent split/lineage bindings |

The normal interpolation can vanish when source vertex normals cancel. Those samples use the geometric face normal; `normal_fallback_count` records the number for every case. Both normal arrays are checked for unit length. Source normals, geometry and features are also bound to full-resolution replay hashes.

The coordinate frame is **atlas display Y-up, centered, in millimetres**. It is not clinical NIfTI RAS. The separate seven-case clinical dataset uses RAS millimetres. Combining these tracks requires an explicit, validated registration; matching units alone is insufficient.

`features` column order is:

1. `extent_x_mm`
2. `extent_y_mm`
3. `extent_z_mm`
4. `surface_area_mm2`
5. `max_displacement_mm`
6. `applied_displacement_fraction`

Surface area includes selected source display triangles and any internal/interface surfaces present in the reference assembly. Organ volume is deliberately omitted: these assemblies are not certified closed organ envelopes. No pressure, stiffness, rupture, perfusion, microstructure or constitutive mechanics targets are fabricated.

## Split and provenance guarantees

Six train, one validation and one audit recipe are selected per supported profile from the **existing parent split**. Every sampled point cloud, full-resolution replay, render or later augmentation inherits that parent group and role. The same parent cannot appear in multiple geometry splits. Source anatomy lineages are shared across splits and this limitation is explicitly recorded; the release does not claim held-out-patient evaluation.

The builder ranks candidate parent recipes deterministically. Any geometry attempt rejected by the editor's finite/face-orientation checks is recorded in `rejections.jsonl`; another candidate from the same original split may be selected. This geometry acceptance filter is an engineering selection bias, not a biological distribution. The displayed displacement can be reduced when the source tessellation requires it; both requested controls and the realized fraction remain in each record.

`manifest.jsonl` and `records/*.json` contain the exact bound `DiseaseAtlasSpec`, original recipe index/group, template identity and rights, source and realized geometry digests, normal digest, full disease field, realized measurements and scoped geometry QA. Anatomical plausibility and mechanical validation remain unreviewed/not run.

`release.json` hashes every tensor, case record, shared template, license file and copied parent recipe artifact. It binds the exact parent recipe release, freezes decoder source snapshots, and records software versions. Verification additionally checks parent-split inheritance, template rights, point units/normalization, sampling correspondence labels, finite measurements and conditioning values. Replay refuses an active decoder whose source hashes differ from the frozen version. This prevents an apparently unchanged recipe from silently producing different anatomy after a code update.

The default sources carry CC BY 4.0 attribution requirements, retained in the shared template metadata. The separate KiTS clinical lane remains noncommercial/share-alike and is not incorporated into these synthetic surface tensors.

## Training interpretation

Use `recipe_features`, profile/template identity and the measured `features` as explicit conditions or engineering evaluation targets. The actual `points_mm`, normals and rest correspondences support point-cloud encoders or deformation-surrogate experiments. Fit preprocessing on the training split only. Keep validation for model selection and audit for frozen evaluation.

The delivered disease CVAE learns the bounded recipe distribution; it does not become a learned clinical shape model merely because this geometry cohort exists. The full-resolution editor decoder supplies the surface. Future geometry models must retain the same split groups, source licenses, physical coordinates and explicit evidence limits. Clinician-reviewed disease geometry, operative appearance and measured mechanics are still needed before claiming realistic surgical simulation.
