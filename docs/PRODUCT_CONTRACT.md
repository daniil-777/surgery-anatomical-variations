# Product contract

VISCERA exists to create and edit high-resolution anatomical organs with physically plausible behavior, fine geometric control and natural-language control.

The first user journey is: open an original liver/gallbladder scene → inspect its structure and materials → explore coherent variations → change global dimensions or a local feature → compare/undo → describe another change → export the actual geometry. The same supported controls, measurements and versions bind dataset examples and training runs.

Four quality axes are evaluated separately:

- Detail: silhouette, lobes, fissure/fossa features, thin structures, material maps, close-up and changing-light consistency.
- Variation: measurable control sensitivity, fixed-control seed diversity where supported, coherent parameter sampling, locked-feature preservation and honest lineage counts.
- Interaction: bounded deformations, no accepted collapsed faces, volume drift reporting, stable recovery, solver convergence for quantitative mechanics.
- Language: exact dimensions/units, grounded controls, atomic unsupported/ambiguous outcomes and unchanged unrelated fields.

The baseline language compiler is local and deterministic. It uses explicit numeric edits and named synthetic presets; it does not silently infer disease, demographic data or physical parameters. Ambiguous size/volume requests return clarification. Learning a broader language adapter uses a separate dataset and held-out evaluation.

Visual review uses repeatable editor recordings and fixed camera/light configurations. Numerical tests complement what can be seen in video. Review records report the observed defects, edits and resulting images/motion; there is no automated anatomical-expert signature.
