# Original anatomy pilot dataset

From `viscera/`:

```sh
uv run python -m viscera_core.dataset --output datasets/original/pilot-v1 --count 128 --resolution medium --sampler-profile adult_design_v1
```

The release contains:

- `geometry/<sample_id>.npz`: fixed-topology organ surfaces, UV coordinates, intrinsic colors, normals, a separate gallbladder inner surface, eight construction controls and five measured conditions.
- `manifest.jsonl`: requested parameters, realized measurements, artifact checksums, landmarks, evidence, one construction lineage, sample split/group and accepted or rejected outcome.
- `train.npz`, `val.npz`, `test.npz`: separate arrays with `parameters`, `conditions`, names, sample IDs and group IDs. All arrays load with `allow_pickle=False`. Training opens only train/validation; final evaluation opens test explicitly.
- `language.jsonl`: captions grounded in actual measured outer-envelope volumes and RAS dimensions, plus bounded synthetic requests with expected parameter changes.
- `rejections.jsonl`, `release.json`, `dataset_card.json`: every attempted/rejected outcome, hashes, capabilities and explicit evidence limits.

`parameters` columns, in order:

1. `liver_width_mm`: RAS x extent.
2. `liver_height_mm`: RAS z extent.
3. `liver_depth_mm`: RAS y extent.
4. `left_lobe_ratio`: authored taper control, not a measured lobar-volume ratio.
5. `inferior_concavity`: authored coupled impression amplitude, not a diagnosis.
6. `fissure_depth_mm`: authored feature displacement control; final regional dimensions require their own measurements.
7. `gallbladder_length_mm`: neck-to-fundus endpoint distance.
8. `gallbladder_radius_mm`: authored body-radius control; curved outer-surface extents are separately measured.

`conditions` are `liver_volume_ml`, `liver_width_mm`, `liver_height_mm`, `gallbladder_enclosed_ml`, `gallbladder_length_mm`. Volume means closed **outer-envelope** volume, including internal lumen space; gallbladder lumen and effective-wall volumes are separate manifest quantities. Dimensions are authoring-frame extents, not clinical ultrasound or radiology measurement protocols.

The split is explicitly **within-generator interpolation**. Every sample's captions and geometry stay in one split; all splits share the same authored construction lineage. Independent-anatomy generalization is unavailable until separately authored or acquired reference designs exist. Count 128 is a debugging/training budget, not evidence of human variation, prevalence or realism.

`adult_design_v1` is the current default interactive and CLI sampling profile. Its dimension proposals have means 235/145/125 mm and pre-truncation standard deviations 18/12/9 mm for width/height/depth, with positively correlated size variation (pairwise correlation 0.49 before truncation). Registry limits reject proposals instead of clamping them. The factory measures the completed liver and rejects outer-envelope volumes outside **1200–2600 mL**, an explicit authoring design band, **not a clinical normal range**. It fills 128 preassigned accepted split slots with at most 384 attempted candidates; every rejected candidate, its measurements, parameters, split slot and failure reason stays in the manifest. The release reports proposed and accepted volume quantiles and the true attempt denominator.

The frozen `pilot-v0` remains available as broad control stress coverage, including much larger designs (median approximately 2849 mL). It is not the default adult design distribution. Replay it explicitly with `--sampler-profile broad_control_v0` into another directory. The Python factory keeps this legacy profile as its backward-compatible default; callers creating new releases must pass `sampler_profile="adult_design_v1"`. Profile identity and its exact sampling assumptions are recorded in each v1 recipe and dataset card. The scene-construction algorithm itself is unchanged between these releases.

CPU geometry, named NumPy PRNG, canonical JSON and fixed ZIP metadata make same-environment reruns reproduce artifact hashes. A directory containing a different recipe refuses overwrite. The default release is `development_preview`, with anatomical review `unreviewed`, physical validation absent, and no hidden clinician or measurement claims.
