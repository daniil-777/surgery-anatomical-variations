# Operative camera and tissue context review

The Whole Scene and Import 3D workspaces now share three regional scope entries: under the liver, stomach/spleen and the edge of the bowel/mesentery. Entries are independent viewpoints, not a simulated trocar trajectory. The camera stays outside the first atlas surface on the entry ray. Subsequent movement sweeps a 2 mm sphere against visible atlas geometry, generated adipose layers and an illustrative peritoneal enclosure. These checks do not infer closed organ volumes or lumens.

The operative view suppresses exterior studio illumination and uses a near-coaxial camera spotlight with distance-dependent intensity. The enclosure supplies a continuous tissue background. Existing organ-aware omental and perirenal layers supply surrounding fat. Import 3D owns these as disposable preview layers, separate from the exportable organ scene; shape/texture regeneration closes the scope view before rebuilding its geometry. Whole Scene retains the existing dissection, endless variation, recording and physics features; variation and physics pause on regional entry.

Whole Scene's old sinusoidal vascular outlines have been replaced by tapered branching texture trees blended across three rest-space projections. Capsule vessel visibility, color saturation and relief are reduced. Mesenteric membrane detail no longer reuses pancreatic polygonal lobulation. Coarse abdominal organs receive one bounded PN refinement and mild fairing. Original atlas coordinate frames remain shared; refined vertex locations are not identical to the source mesh. These are authored appearance fields, not reconstructed patient vessels.

## Reference inspection

The existing credited DSAD photographs were inspected at their native resolution: `dsad-25-6.png` (liver over stomach, fine branching serosal vessels and narrow wet highlights), `dsad-21-5.png` (colonic surface surrounded by lobulated yellow fat) and `dsad-25-47.png` (bowel/mesenteric folds, vessels and occluded recesses). The [dataset publication](https://www.nature.com/articles/s41597-022-01719-2), [official NCT mirror](https://huggingface.co/datasets/nct-tso/dsad) and bundled `body-reference/README.md` document the source and CC BY 4.0 attribution. Endoscapes and the gallbladder research from the earlier review were also consulted. No new reference photograph was incorporated into the rendered tissue.

Visual comparison goals were framing/occlusion, scale of vascular detail, separation of capsule and adipose appearance, localized specular highlights and darkness in recessed spaces. Photographs are uncalibrated surgical observations; they do not establish RGB/PBR constants or clinical validity.

## Iterations and checks

1. First internal views revealed bright looping vessel contours and overly rough surfaces in Whole Scene. Replaced the vascular field, restrained pigmentation and refined coarse geometry.
2. Reviewed all three regions from the entry and a dragged oblique camera angle in both workspaces. The central bowel entry mostly showed omentum; moved it laterally and increased working distance to reveal adjacent bowel. Reduced artificial mesenteric cell borders.
3. Production captures exposed a capture-timing issue: a screenshot could precede the newly selected camera frame. Entry now draws immediately and the review waits for animation frames before capture. The final review uses the built static app, avoiding development HMR resets.

Local evidence is in `artifacts/operative-2026-10-24/`: `pass-3`, `production-review`, `final-review`, `navigation-production.json` and `export-browser`. Earlier partial/failed runs are retained as diagnostics, not successful evidence.

- 105 focused unit tests passed in the isolated release checkout, covering imported geometry/materials, disease support, scene variation, camera sweeps and regional entry/enclosure.
- Studio TypeScript check passed. The release also fixes an existing optional-prop type mismatch in AtlasStudio and includes missing small software test fixtures so clean checkouts can run the tests.
- Production public build passed: 1,175 files, approximately 280.44 MiB. Existing large-chunk warnings remain.
- Browser movement check passed for both workspaces: retreat changes position; repeated forward steps stop at tissue; Escape restores the overview; no page errors.
- Browser GLB export/reimport test passed, retaining decoded generated tissue maps.
- Full public smoke test covers atlas sampling, physics calibration, operative entry with generated fat, return to orbit, the procedural studio and texture lab. Its output directory is now created explicitly when `--out` is supplied.

The release uses the existing standalone Viscera GitHub Pages workflow. The portfolio mirror reported Pages disabled; it is not the release target.

## Limits

The peritoneal enclosure is inferred from abdominal bounds, not segmented abdominal-wall anatomy. Omental shape and optical scattering remain approximations; no live retraction, adhesiolysis, tissue contact solve or reconstructed organ lumen is provided. Arteries/veins from the atlas remain incomplete at some endpoints. Texture projections can still blend or repeat, and a spotlight does not reproduce a calibrated endoscope response. The result needs expert anatomical review and controlled image comparisons before any surgical-training or conference-grade realism claim.
