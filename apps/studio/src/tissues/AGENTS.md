# Tissue lab acceptance contract

The user’s long-term objective is a surgeon-style camera with a camera-mounted light moving through varied internal anatomy, producing a highly realistic 4K video stream. Preserve this objective and distinguish delivered engineering evidence from clinical/realism qualification.

After changes to tissue generation, geometry, surface binding, optics or the viewer:

1. Run the focused Python and TypeScript contracts and the tissue browser suite.
2. Run `node scripts/tissue_visual_review.mjs` from the VISCERA workspace against the final implementation. Inspect stills AND the resulting 3840×2160 walkthrough video, including moving highlights, transitions and dark regions. Record actual live rendering/encoding cadence separately from deterministic offline capture throughput.
3. Review representative organs, lumen mucosa, normal/albedo/roughness ablations, adjacent seeds, camera motion, UV seams, changed layer coverage and grazing light. Preserve failed iterations and explain corrections.
4. Verify the fat pipeline remains untouched. This module must not import from or change `../fat/`.
5. Retain source/license/provenance manifests. Do not describe procedural outputs, output sampling resolution, or borrowed phantom metrics as recovered patient anatomy, measured tissue optics or clinical qualification.
6. Stage a complete native/preview library with `scripts/stage_tissue_library.py` before production acceptance or archival. Audit that snapshot and serve those verified files for the final production browser/video checks. Do not package duplicate names or abandoned staging files merely because they are present in a mutable export directory.

Run commands and current limitations are documented in `../../../../docs/tissue-lab.md`. A successful screenshot alone is not acceptance of the walkthrough.
