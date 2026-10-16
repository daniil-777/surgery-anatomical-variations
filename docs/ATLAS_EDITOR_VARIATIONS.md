# Live parameters and visible variations

The October 7 editor fix addresses controls appearing to do nothing and repeated generation producing nearly identical livers.

Previously, sliders only edited an unsubmitted draft. `Generate variation` realized that same draft without drawing new controls. Changing its seed did not deform explicit controls, and seeded sampling deliberately repeated the same output. The sampler also used only 40% of the available control range. Camera auto-fitting on every response then hid uniform scale changes. Learned sampling locked overall dimensions by default.

## Editor behavior

- Shape sliders, Reset, surface sliders, palettes and valid appearance seeds update automatically after a 240 ms debounce. Controls remain editable while the preview is being prepared.
- Every edit invalidates earlier responses immediately, including during the debounce interval. Shape and surface changes compose into the latest recipe; switching panels does not discard edits. Mobile control panels remain open during live updates.
- `Generate variation` draws a fresh seed and samples all shape controls. `Variation range` offers Subtle (40%), Balanced (70%) and Broad (100% of the existing control envelope), with Broad selected initially. This does not expand the decoder's limits.
- `Sample shape from seed` reproduces a design from the specified seed and range. The seed field alone does not modify shape. Exact realized controls are preserved in export provenance.
- `Learned variation` continues using the entered seed and the trained synthetic design prior. `Keep overall dimensions` is initially off; enable it for dimension-constrained proposals. This finite prior can repeat shapes and is not an independent patient-population model.
- The camera stays fixed across changes to the same template. Initial loading, changing reference and explicit Fit/view actions still fit the current organ. The visual witness retains its original deterministic framing behavior.
- Surface-only edits verify that geometry stayed identical. Invalid or failed requests retain the last valid preview. Export is unavailable while a preview is pending, and otherwise exports the displayed result. A failed reference selection restores the previous selection and its surface controls.

## Verification

The real female liver was exercised through the editor and live API, without mocked meshes. Width changed from **223.6 mm to 273.1 mm**, and opaque rendered area increased from **123,174 to 150,137 pixels**. Increasing all three scale controls increased rendered area by **22.3%** from the reference with the camera unchanged. Three successive Generate clicks produced three distinct seeds and geometry hashes. A following surface change preserved geometry.

The evidence is under [editor-variations-2026-10-07](../benchmarks/results/editor-variations-2026-10-07/). The [real editor record](../benchmarks/results/editor-variations-2026-10-07/real-editor/real-editor-audit.json) contains recipes, hashes, dimensions and silhouette counts. PNGs use the same unaltered camera and canvas dimensions. [Narrow liver](../benchmarks/results/editor-variations-2026-10-07/real-editor/02-width-minus-one.png) and [wide liver](../benchmarks/results/editor-variations-2026-10-07/real-editor/03-width-plus-one.png) show the width effect.

Across 64 diagnostic seeds per liver reference, moving from 40% to 100% of the existing control range increased median vertex RMS displacement from approximately **2 mm to 5 mm**. This is a geometric sensitivity measurement, not a realism or population-coverage score.

Validation: **51 unit tests**, **22 browser regressions**, a real-API liver visual integration check, strict TypeScript and a production build passed. The browser regressions include stale responses arriving while a newer edit is debouncing, failure/export consistency, failed reference recovery, combined shape/surface edits, seed replay, fresh sampling, visible canvas differences and mobile interaction. Additional framing checks verify unchanged camera/target on same-template replacement and explicit refitting behavior.

Run with the API and Studio available:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm exec playwright test --config playwright.atlas.config.ts
pnpm exec playwright test --config playwright.material.config.ts
# Actual reference data/API required; defaults to the verification Studio on 5175.
VISCERA_STUDIO_URL=http://127.0.0.1:5174 pnpm exec playwright test --config playwright.atlas-live.config.ts
```

The frozen shape decoder, reference meshes, training datasets, material shader, models and Colab archives are unchanged. These controls still express bounded scale, bend, twist, taper and asymmetry of a reference mesh. They do not introduce new lobe structure, vascular topology or clinically validated anatomical variability.
