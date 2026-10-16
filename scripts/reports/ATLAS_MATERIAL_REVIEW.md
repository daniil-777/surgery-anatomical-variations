# Reproduce the material review

Start the Atlas API with material v2 and the Studio Vite server. From `viscera/`:

```sh
node scripts/reports/render_atlas_material_review.mjs \
  --base-url http://127.0.0.1:5174 \
  --out ../reports/material-review-2026-10-07

python scripts/reports/build_atlas_material_contacts.py \
  --review-dir ../reports/material-review-2026-10-07

node scripts/reports/verify_atlas_material_shader.mjs \
  --base-url http://127.0.0.1:5174 \
  --fixture benchmarks/results/material-v2/gpu-parity-fixture.json \
  --out ../reports/material-review-2026-10-07/gpu-parity.json
```

The capture script uses the actual `AtlasViewport`, including its versioned fragment shader, camera, lights and color management. It records 48 images at 512 pixels square: twelve organ families and four presets, using the first reference in each family. Shape controls remain zero and the shape and appearance seeds remain 42 within each row. Eight additional 1024-pixel views inspect liver/pancreas fine detail and independent appearance seeds. Every scene's actual vertex, triangle and normal arrays are hash checked by `AtlasWitness`; the contact builder checks image hashes and equal geometry/normals across presets before arranging the original captures.

The GPU verifier reads floating-point render targets from the actual GLSL sampler and compares linear RGB, roughness, height and analytic rest-space height gradients against CPU fixtures. It checks seeds 0 and 4,294,967,295. These are tolerance comparisons, not claims of bitwise CPU/GPU identity. The shader source and metadata live in `apps/studio/src/atlas-material-field.glsl` and `.json`; update both from `material_shader_contract()` when the field implementation changes. Studio rejects a shader source hash mismatch.

V2 uses undeformed template millimetres for deterministic fragment shading. Pigment, roughness and micro-normal detail are independent of mesh vertex density; height never displaces vertices. Source anatomical region labels preserve ligament boundaries. The Surface editor applies only to committed displayed geometry and keeps pending shape edits separate. GLB exports use finite baked maps, so their sampling/filtering can differ from the continuous viewport field.

These authored materials are design-space variation. The captures and numerical checks do not establish measured tissue optics, histology, vessels, fiber architecture, anatomical truth or mechanical validity. Legacy recipes without `material` retain the v1 rendering path.
