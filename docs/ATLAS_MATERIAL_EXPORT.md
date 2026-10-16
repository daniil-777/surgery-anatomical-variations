# Material export and source shading defects

The optional material-v2 path samples the same continuous rest-millimetre field in the editor and portable PBR maps. It does not add anatomical mesh detail, recover tissue optical measurements, or convert display surfaces into mechanical simulation domains. The original atlas, legacy appearance module, datasets and checkpoints remain unchanged.

## Geometry and units

Export converts millimetres to glTF metres and uses normal glTF float32 attributes. UV chart seams and tangent-handedness seams duplicate vertices only: mapping exported triangle corners back to source indices recovers the exact triangle order and winding. Source coordinates, source faces and original source files are not edited. Texture charts may omit unused *UV vertices* after a seam split; every source triangle remains present.

Base colour is stored as sRGB. Roughness is linear in the G channel, metallic is zero, and the normal texture uses the glTF tangent basis. Explicit `TANGENT` attributes remove dependence on an importer's tangent reconstruction. The same normal texture is bound to `normalTexture` and `KHR_materials_clearcoat.clearcoatNormalTexture`, matching the editor's two normal perturbations. The export camera/lighting is not baked into these maps.

## Invalid source display normals

`atlas_surface_normals.repair_display_normals` is called only by the optional v2 scene adapter. It keeps every valid input normal unchanged. Invalid referenced normals are derived from the area-weighted incident geometric normal. When incident geometry cancels exactly, a deterministic largest-area incident face supplies a shading normal; this is recorded as a source defect and is not a topology repair. A referenced vertex with no positive-area incident face raises an error.

The identity-source audit found 28 affected vertices in each brain reference and 67 in the male heart; the other 21 references preserve their complete normal arrays. Metadata records source/final float32 hashes, repaired vertex IDs, weighted versus largest-face fallback counts and source-defect flags. The final normal hash is included in the v2 specimen binding. Legacy scenes retain their frozen normal policy.

## UV and tangent fallbacks

xatlas can collapse UVs on tiny, positive-area source triangles. Each affected face receives its own chart in an explicit reserved atlas strip; existing UV charts are scaled to remain disjoint. Eight-pixel cells, a three-pixel triangle and a separate eight-pixel strip gap bound the allocation. The main atlas must retain at least 40% of its width or export fails with a request for a higher resolution. The default is 2048 pixels; 128/256 maps cannot accommodate the male-heart fallback.

At 2048 pixels, the male-heart reference needs 683 fallback face charts. Their original areas range from approximately 9.0e-11 to 9.7e-7 mm². The strip occupies 1.17% of the map width; the main atlas retains 98.44% after the gap. The female-pancreas reference needs two fallback charts, leaving 99.22% for the main atlas. The male-bladder reference unwraps without fallback at 1024 and 2048. Exact counts, face IDs, source area bounds and atlas fractions are exported in `material_bake.uv_fallback`.

Opposite `tangent.w` signs inside one triangle have undefined interpolation in glTF. Only affected triangle corners are duplicated so each triangle has constant handedness. A cancelled projected UV tangent receives a deterministic orthogonal basis; the map is encoded in that same exported basis. Both cases have separate counts in metadata.

A source shading normal can lie in its geometric face plane, making the micro-height gradient system singular. Editor and baker share `NORMAL_FRAME_RELATIVE_THRESHOLD = 1e-7` and the coordinate-invariant guard:

```
abs(dot(dPdu, cross(dPdv, normal)))
    <= length(cross(dPdu, dPdv)) * 1e-7
```

At those texels the existing source normal is retained and the undefined micro-normal is omitted. Base colour, roughness and geometry remain present. At 2048 pixels, the audited male-heart export has 20 such texel evaluations on 17 source faces. Their IDs and counts are recorded. This is a stable rendering fallback, not recovered surface detail or repaired anatomy.

## Resource bounds and resolution

Accepted raster texels are evaluated in batches of at most 32,768, and large face bounding boxes are tiled. Unwrap results are cached by exact xatlas float32 rest-coordinate bytes, face indices, resolution and policy; the cache is capped at 96 MiB and four entries. One bake/export owns the work slot per process. Another request waits at most one second before `MaterialBakeBusyError`; the API returns 503 with retry guidance. Multiple API worker processes each own their own slot and cache.

Maps report triangle coverage, including `triangles_without_texel_center`. A fixed texture resolution cannot sample every tiny source triangle or retain arbitrary subpixel detail. Uncovered texels use nearest-surface extension into gutters; mip levels can still mix distant chart content at strong minification. A high texture resolution does not increase the resolution or accuracy of the underlying anatomical source.

## Verification

Regression tests cover mirrored UVs, a skewed nonuniform shape transform, analytic versus independently reconstructed perturbed normals, exact exported UV/TANGENT buffers, clearcoat normal binding, bounded cache/field batches, busy-bake failure, isolated UV fallbacks, tangent-sign seams and the shared singular-frame policy. Every one of the 24 identity references successfully exported at 512 pixels; the three exceptional references were additionally exported at 2048 pixels.

For a deformed gallbladder, actual GLTFLoader imports were compared with the procedural shader under the same Studio camera and lighting in three views. The final interior RGB mean absolute difference was 0.43–0.48 on a 0–255 scale, with the 99th percentile at or below 3; independent renders are retained in `benchmarks/results/material-v2/`. Screen-space versus baked-texel filtering and 8-bit normal quantization prevent a pixel-identity claim. The exceptional male-heart 2048 export was independently imported and rendered in the same three views: interior RGB mean absolute difference was 0.37–0.45 /255 and the 99th percentile was at most 3. No inverted micro-normal detail or visible UV strip seams were observed in either case. These comparisons validate rendering/export agreement, not resemblance to measured human tissue.

Reference: [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), texture coordinate origin, explicit tangent basis and normal texture conventions.
