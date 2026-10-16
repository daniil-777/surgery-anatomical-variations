# Reproduce the Atlas visual audit

The witness renderer loads every **stored recipe** from a cohort manifest and renders its actual API geometry using the same `AtlasViewport` as Studio. It does not resample a seed or substitute an illustrative asset. Studio opens Atlas by default; the previous procedural editor remains at `?mode=legacy`.

Start the API with the cohort's immutable templates and the Studio Vite server. From `viscera/`, with Node 24 and Playwright's Chromium installed:

```sh
node scripts/reports/render_atlas_witness.mjs \
  --manifest datasets/atlas/cohort-v2/manifest.jsonl \
  --out benchmarks/results/atlas-cohort-visual-v2 \
  --base-url http://127.0.0.1:5174 \
  --expected-count 1536

python scripts/reports/build_atlas_contacts.py \
  --manifest datasets/atlas/cohort-v2/manifest.jsonl \
  --witness-dir benchmarks/results/atlas-cohort-visual-v2

node scripts/reports/render_atlas_heroes.mjs \
  --witness-dir benchmarks/results/atlas-cohort-visual-v2 \
  --base-url http://127.0.0.1:5174
```

The contact builder requires Pillow. `atlas-witness.html` is a standalone development harness, not part of the production Studio entry point. The renderer supports `--limit N` for preflight; a partial run never reports full coverage. Reusing the output directory resumes completed records only after checking their manifest binding, renderer version and PNG hashes. Use a new output directory after changing shading, material policy or rendering code.

Each specimen produces a 768 × 256 PNG: **oblique, back, top**, each 256 pixels square. These are neutral viewer directions in centered Y-up coordinates, not a claim of patient orientation. Camera position, target, projection, fit padding, lighting, tone mapping and color space are recorded for every view.

`witness.jsonl` binds each image to its sample ID, exact recipe, source template, split, geometry hash and appearance. The browser independently hashes the received float64 vertex / int64 triangle arrays and checks them against the frozen cohort. It also checks the actual float32 normal attributes against the API's display-normal hash and records a hash of the sRGB color attributes. The maximum float32 coordinate rounding used by the GPU is measured. Every view must contain opaque geometry and leave a margin at every frame edge.

`summary.json` records completion and failures. `contacts.json` is written only after a second pass verifies complete sample coverage, all geometry bindings, all three views, all image hashes, exact recipes and normal hashes. `contacts/` then contains one labeled 64-specimen contact sheet per template. Original triptychs remain under `images/` for inspection at full resolution.

The hero renderer selects the first stored, completed specimen for each template and replays the exact recipe at 1600 × 1200. It checks geometry, normal and color hashes against the existing witness before writing `heroes/{template_id}.png`. `heroes.json` records the actual cohort sample ID, hashes, camera and lighting for every native-resolution render; these are higher-resolution views of existing specimens, not new dataset samples.

This establishes provenance, rendered coverage and framing. It does not establish clinical anatomy, population distributions, wet-tissue reflectance, self-intersection freedom or mechanical validity. Keep the source-specific limitations visible: shared Allen brain construction, unknown bladder filling state, open kidney display surfaces, and strongly reduced BodyParts3D stomach/gallbladder geometry.
