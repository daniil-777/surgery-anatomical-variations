Independent tissue appearance baseline
=====================================

This module generates tileable, deterministic organ surface appearance maps. It
does not depend on the separate fat-generation implementation. The adipose layer
here is an optional **appearance mask**, not adipose geometry or mechanics.

```python
from viscera_core.tissue_materials import TissueRecipe, export_material

recipe = TissueRecipe(
    organ="small_bowel",
    transition_organ="mesentery",
    seed=42,
    tile_size_mm=80,
    vessel_opacity=0.7,
    fascia_opacity=0.12,
    adipose_opacity=0.25,
    wetness=0.8,
)
manifest = export_material(recipe, "output/bowel-mesentery", resolution=4096)
```

`sample_tissue(recipe, u, v, footprint_mm=...)` accepts broadcastable arrays or
scalar UV coordinates. It returns substrate and composite **linear** RGB,
roughness, millimeter height, a millimeter thickness proxy, a transition mask,
and four independent straight-alpha **sRGB** layers. Color composition order is
substrate → vessels → adipose → fascia. The wet-film layer provides clearcoat
coverage; its white RGB must not be composited into diffuse color. Opacity is
coverage control, not measured physical transmission.

`export_material` streams PNG rows in bounded stripes and supplies hashes, code
hashes, software versions, uint64 seed decimal text, physical scale, color spaces,
decode ranges, and explicit limits in `manifest.json`. All 19 surface families,
including three distinct mucosa families, are listed in `ORGAN_PROFILES`.
The CLI is `viscera/scripts/generate_tissue_materials.py`.

Each export directory contains `substrate.png`, `base_color.png`, `normal.png`,
`roughness.png`, `height.png`, `thickness.png`, `transition.png`, and
`overlays/{vessels,adipose,fascia,wet_film}.png`. Version 0.2 also exports
`substrate_normal.png` and `layer_relief.png` for editable relief, plus
`substrate_roughness.png` for a dry baseline. A native 4K export evaluates the
field at 4096×4096; it is not a resized preview. Studio's library builder places
these under `<organ>/native/`, with separate `<organ>/preview/` assets.

Run the focused invariants from `viscera/`:

```sh
.venv/bin/python -m pytest tests/python/test_tissue_materials.py -q
```

The tests cover invalid controls, uint64 seeds, all organ families, periodic
boundaries, linear composition, overlay independence, wet-film separation,
millimeter quantization, image hashes, physical normal orientation, stripe
invariance, exporter ownership, and complete-manifest publication order.

Normals use OpenGL +Y, with +Y pointing toward the top of the image. The sampled
height array has rows increasing downward, so the encoded vector is
`normalize(-dh/dx, +dh/drow, 1)`. Standard Three.js `TextureLoader` with `flipY=true`
uses this convention. Adapt UV orientation consistently for other importers.
Height and thickness are 16-bit unsigned PNGs; decode millimeter values using
the manifest ranges. Color maps are sRGB; normals, roughness and scalar maps are
linear. Adjacent edge pixels are different pixel centers; the continuous field
is periodic across integer UVs, rather than duplicated first/last pixel rows.

All layer PNG alpha values exclude the global recipe opacity, allowing editable
coverage. `layer_relief.png` is linear RGB8: R=vessels, G=adipose, B=fascia.
Decode each channel into millimeters with scales `[0.035, 0.45, 0.035]` and zero
offset. Each channel includes its intrinsic coverage, but excludes recipe opacity.
To update relief interactively, take physical central differences of the decoded
layer heights, multiply by current layer opacity, then add those slopes to the
slopes decoded from `substrate_normal.png` before normalizing. Do not apply this
to `normal.png`, which already includes recipe-weighted layer relief. The combined
height, normal and roughness maps remain available for interchange. To edit
roughness, use the independent dry `substrate_roughness.png` and compute
`clamp((dry + .10 * fascia_alpha * fascia_opacity) *
(1 - .57 * wet_alpha * wetness), .075, .85)` exactly once. This avoids applying
wetness again to an already-wet exported roughness map.
A material tile's physical
scale only holds when the renderer maps one UV repetition to that millimeter size.

This is an authored procedural research baseline. Colors, morphology, vessel
graphs and thickness are uncalibrated priors. No image fitting, model training or
trained weights were used. The revision was informed by qualitative observation
of licensed HeiPor and HyperKvasir photographs, with source member provenance
retained in the research artifacts. Photographs were not used as albedo. Pattern
scales are approximate; the separate 2048-square vessel raster does
not gain new vessel detail from a 4096 export. Analytic microstructure is evaluated
at output resolution, with footprint attenuation for previews. A 4K image is not
evidence of photorealism. The module supplies no patient-specific reconstruction,
spectral light transport, anatomical topology, pathology, mechanics, cutting,
perfusion or clinical/surgical training validation. Large mucosal folds and villi
must come from separate geometry and measured references.

`appearance.py` separates warm, pale and cool chromatic fields from geometric
microstructure. `vascular.py` provides smooth parent trunks, tangent-matched
lateral branches, variable-radius taper and authored depth-dependent softening.
The field compositor combines their periodic outputs without introducing baked
lighting. The vessel graph is an illustrative patch rather than an anatomical
arterial/venous network; its depth bins are not measured optical depths. In
particular, artery/vein crossings, capillary beds, regional pathology and
patient-specific adjacency remain unresolved.

Revision 0.2.1 replaces only the intestinal villi nearest-site relief with a sum
of compact-support C2 kernels. For each periodic jittered site, the contribution
is `max(1 - distance_squared, 0)^3` within a one-cell support radius. A smooth
bounded sum avoids hard clipping. Unlike the former nearest-site exponential,
the height gradient does not jump across Voronoi bisectors or when the local
neighbor stencil changes. This corrects polygonal specular facets without
changing other surface profiles or lowering the viewer's normal gains. The
tufts remain authored appearance primitives, not recovered villi geometry or
measured histology.

Technical conventions are based on the [glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
and [PBRT's discussion of subsurface transport](https://pbr-book.org/4ed/Radiometry%2C_Spectra%2C_and_Color/Surface_Reflection).
These sources establish rendering semantics; they do not validate the authored
appearance priors as tissue measurements.
