# Original template pipeline

From `viscera/`:

```sh
uv run python -m viscera_core.templates --output assets/templates --resolution high --scene-output apps/studio/public/default-scene.json
```

This produces editable PLY outer surfaces, the separate gallbladder lumen, semantic landmark/region records, construction parameters, a strict pilot request schema, measured metadata and a coarse liver tetrahedral preview. Units are mm in RAS+; the simulation consumer converts to SI.

The liver construction explicitly controls a dominant right dome, tapered left lobe, flatter visceral surface, teres/fissure notch, gallbladder fossa, porta target, IVC groove and bounded impression/caudate features. These feature names describe authoring intent and are **unreviewed**, not independently verified anatomical annotations. No Couinaud territories are inferred from the external shell. The gallbladder has neck, infundibulum, body and fundus targets and is laid along the authored fossa. Its 0.8 mm vertical surface clearance is checked through intersections of projected triangles, including their edge intersections.

The reference package contains one original procedural construction lineage. Parameter changes are descendants of this design. It supplies a useful inspectable baseline, not a population model or expert-approved atlas.

The gallbladder inner surface is an explicit homothetic sealed approximation. `wall_thickness_mm` is the nominal shrink scale; actual correspondence thickness varies and is reported. No constant-thickness histology, open cystic junction, fluid model or pressure behavior is claimed. Separate display tubes are capped visual scaffolds, not flow-ready vascular/biliary lumens.

The 267-node / 528-tetrahedron liver proxy uses a positive-volume star fan around a computed visibility-kernel point. Density and support nodes are authored preview assumptions. It has no tissue layers or converged mechanical validation. Render vertices use tetrahedral barycentrics plus a reference residual transported by the tetrahedron's deformation gradient; this preserves affine motion instead of detaching fine surface detail.

`tests/python/test_geometry.py` covers closed meshes, orientation, volumes, strict inputs, all individual control extremes, independent organ clearance, positive tetrahedra, embedding reconstruction and affine behavior, plus intentional failure fixtures. Actual anatomical review and rigorous general-purpose self-intersection predicates remain outstanding.
