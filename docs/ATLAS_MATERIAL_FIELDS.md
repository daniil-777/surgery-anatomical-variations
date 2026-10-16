# Continuous atlas surface materials

The v2 material engine evaluates authored tissue appearance at arbitrary template-rest coordinates. It is separate from frozen atlas geometry, the first appearance engine, and the shape model. A new material seed or preset changes surface appearance without changing any vertex, face, shape control, or physical simulation parameter.

The practical improvement is detail within triangles. The first appearance engine stored pigment only at mesh vertices. On the coarse stomach and gallbladder that limited visible texture resolution to the source tessellation. The new CPU sampler and WebGL2 shader evaluate the same continuous field per texture texel or fragment. This adds rendering detail; it cannot restore absent anatomical geometry, tissue layers, vessels, or measured optical properties.

## Recipe and presets

`MaterialRecipe` contains `version`, `organ`, `preset`, an independent unsigned 32-bit `seed`, and six bounded controls:

| Control | Range | Meaning |
|---|---:|---|
| `tint` | −1 to 1 | Small cool-to-warm shift around the organ palette |
| `pigment_contrast` | 0 to 1 | Contrast of the multiscale pigment field |
| `mottle_scale_mm` | 2 to 40 mm | Broad pigment-pattern design scale |
| `wetness` | 0 to 1 | Surface roughness and clearcoat art direction |
| `fine_detail` | 0 to 1 | Fine pigment, roughness and shading-height strength |
| `structure_strength` | 0 to 1 | Soft, lobular or directional grain strength |

All twelve organ groups have four compatible presets: balanced, soft, rich pigment, and moist. Presets include distinct organ-relative palettes and default control values. `make_recipe(organ, preset, seed, **overrides)` applies those defaults; constructing `MaterialRecipe` directly uses the explicitly declared field defaults. A preset selector should use `material_catalog()['organ_presets'][organ][preset]['recipe']`, preserving an independently chosen material seed if desired. Merely changing the preset string does not reset existing explicit control values.

The presets aim for restrained, nonpathological visual designs. They are not normal-population samples, expert-approved healthy tissue, or disease classifiers. Pancreas/lung lobular mottling and heart directional grain are artistic fields. The directional field does not represent measured myocardial fibers. No vessels, lesions or vascular ground truth are inferred from noise.

## CPU and shader contract

```python
recipe = make_recipe('liver', 'rich', seed=20261007)
resolved = resolve_material(recipe)
sample = sample_material(recipe, rest_points_mm, region_ids, footprint_mm=0.1)
```

`rest_points_mm` is an N×3 array in the undeformed atlas Y-up, centered millimetre frame. The input may contain any barycentric surface sample, not just original vertices. No coordinate normalization by mesh size is applied. Detail therefore follows the material as shape controls deform the surface.

`MaterialSample` exposes both attributes and mapping-style access:

| Field | Shape | Units and meaning |
|---|---|---|
| `rgb_linear` | N×3 | Linear-sRGB base color for PBR rendering |
| `rgb_srgb` | N×3 | Encoded base color for standard color textures |
| `roughness` | N | Dimensionless perceptual roughness, bounded to [0.16, 0.82] |
| `height_mm` | N | Signed authored shading height in mm; no vertex displacement |
| `height_gradient_drest_mm` | N×3 | Analytic derivative of height mm with respect to rest-position mm |
| `metadata` | object | Complete recipe, uniforms, hashes, units, clearcoat and explicit evidence status |

`material_region_ids(component_ids, components)` returns 1 for named ligament components and 0 otherwise. The sampler accepts interpolated blend weights in [0,1], with a 1e−6 endpoint tolerance for barycentric floating-point arithmetic. Keep source component boundaries distinct instead of deriving region masks from colors. Ligaments retain a separate neutral palette and reduced pigment/height amplitude.

`material_shader_contract()` provides the exact `MATERIAL_GLSL` string, hash, and input/output contract. Resolve uniforms through `resolve_material(recipe)['uniforms']`; do not reimplement the field or infer new random seeds in the frontend. The shader entry point is:

```glsl
AtlasMaterialSample atlasSampleMaterial(vec3 restMm, float region, float footprintMm);
```

Its fields are `colorLinear`, `roughness`, `heightMm`, `heightGradientRest`, `clearcoat`, and `clearcoatRoughness`. `uAtlasSeed` is an unsigned integer uniform, `uAtlasStructureMode` is an integer, and the other uniforms are float/vec3 values. WebGL2, GLSL ES 3 integer operations, and high precision for floats and integers are required. The integer hash uses its top 24 bits; their conversion to a float is exact. Subsequent CPU float64 and GPU float32 field calculations are checked with numeric tolerances, not claimed to be byte-identical.

Use a footprint of `max(length(dFdx(restMm)), length(dFdy(restMm)))` in the preview. A texture baker should use the maximum rest-space derivative per texel. Unresolved bands fade smoothly to avoid high-frequency shimmer. Analytic height gradients assume a locally constant footprint. For surface normals, transform the rest-height gradient through the actual deformed surface parameterization or use screen-space height derivatives with the correct metric. Height is expressed in **millimetres**: a renderer using metres must convert it before differentiating against metre-valued view positions. Do not add the gradient directly to an unrelated world-space normal.

For glTF, encode base color as sRGB, roughness as linear data, and normal maps as linear tangent-space data with the glTF normal convention. Baking must evaluate the CPU field at triangle barycentric rest locations and use the corresponding deformed tangent frame. The field has no UV seams; any UV-chart border filtering is the baker's responsibility. Clearcoat values are provided as resolved scalars; metallic is always zero.

## Evidence and limits

Tests cover recipe rejection, all organ/preset output ranges, independent seed replay, chunk-size independence, color-space round trips, ligament separation, zero-detail behavior, filtering, and analytic gradients against finite differences in every structure mode. A coarse-triangle test confirms field detail exists at interior points despite there being no interior mesh vertices. A shared CPU fixture supports actual GPU float readback parity checks. Additional corner stress evidence is stored under `benchmarks/results/material-v2/`.

No calibrated tissue photograph, tissue roughness measurement, scattering coefficient, patient phenotype, microscopic structure, or physical mechanics has been learned or validated by this engine. Source geometry resolution and atlas ancestry limits remain unchanged. Synthetic material training should preserve each complete recipe and its geometry parent across all point samples, maps and rendered views; any held-out score still measures this authored generator.
