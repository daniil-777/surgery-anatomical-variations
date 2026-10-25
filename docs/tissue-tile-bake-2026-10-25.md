# Selected learned tiles on the 3D liver

A generated appearance remained active when a learned gallery tile was selected. After its asynchronous inference finished, it replaced the selected tile's substrate. The live pre-fix build reproduced pixel-identical liver renders for clean seeds 1 and 2 once inference settled. Capturing immediately after selection initially hid the defect because the selected tile was briefly visible before the override arrived.

Gallery tiles now take precedence for rendering, baking, captions and exported display recipes. Selecting a tile suspends generated appearance inference and invalidates pending model-download activation. The model stays available; explicitly choosing “Use generative models” switches to the corresponding authored organ and generates its appearance. Baking an active generated appearance no longer silently selects the first gallery tile.

Bake invalidation follows the actual source texture identity and version, plus atlas settings and wetness. This covers resolution/condition/weight changes that share a model ID and seed. Disposed bakes clear the export card. The card shows the current source and render diagnostics record the source-map checksum or generated-appearance parameters.

The targeted review compares all eight liver tiles at three deterministic viewpoints, both lit and without illumination. It checks distinct UV atlases, visible foreground differences and exact replay of the first tile. One initial acceptance threshold treated a dark side view as equally bright as the frontal view; that iteration is preserved. The final check uses unlit views to verify full texture differences and separate thresholds for the dim side views. The synthesis/lighting code was not altered to exaggerate the results.

Engineering acceptance does not establish clinical realism. Source RGB remains learned appearance, not calibrated albedo, and atlas anatomy remains approximate. The separate fat pipeline and all source/provenance manifests are unchanged.

Final acceptance: TypeScript, 208 unit checks, 162 Python checks and all 39 tissue browser checks passed. The new native snapshot passed all 21 material audits. Frozen-source review completed 73 rendered cases and seven 4K videos with no browser errors. Interactive 4K RAF intervals measured 16.7 ms median / 33.3 ms p95; live 4K video encoded 29.5–30.0 fps. The separate deterministic walkthrough was encoded offline at 24 fps. These are measured local observations, not sustained frame-rate guarantees.
