# VISCERA Studio

A local React 19 / Three.js anatomy workspace for the original procedural pilot.
The first screen is the working editor, not a landing page.

From the `viscera/` workspace, `pnpm dev` starts the local services. The Studio
uses `http://127.0.0.1:5174` and proxies `/api` to port 8000. A checked-in
`public/default-scene.json` allows the core editor to open without the API.

## Working capabilities

- RAS+ millimetre geometry displayed through an explicit `[X, Z, -Y]` view transform.
- Orbit, pan, zoom, camera presets, fit, wireframe, section plane and object visibility.
- Organ selection and locks; width/depth/height, local grab/inflate/twist/smooth,
  curvature and volume-scale edits; local triangle checks before acceptance.
- Explicit procedural morphology controls for lobe proportion, concavity, fissure
  depth, gallbladder length and radius. Changes rebuild through the API.
- Undo/redo, project JSON import/export and GLB export in metres.
- Tissue-color, roughness and wet-coat controls with seeded procedural normal
  detail. These are design materials, not measured optical tissue properties.
- Typed language interpretation, review and atomic server-side edits; unsupported
  requests leave the scene unchanged. Realized local snapshots are uploaded before
  editing so unchanged geometry can be preserved.
- Procedural variation and an explicitly experimental learned-parameter sampler.
  The latter requires an actual local trained checkpoint; unavailable/rejected
  samples report their reason instead of falling back silently.
- An unedited, reference-matched liver can run the CPU tetrahedral XPBD displacement
  preview. Fixed simulation steps, a bounded frame accumulator, positive-tet
  rejection, affine residual embedding and retained test telemetry are used.
  Reports include peak displacement, terminal recovery residual, minimum Jacobian,
  maximum volume drift and rejected steps. The terminal pose is retained until
  an explicit reset; resetting is not counted as recovery.

## Implementation boundaries

WebGL2 is the implemented renderer. WebGPU is not advertised as implemented.
The browser geometric tools check finite coordinates and local triangle collapse
or reversal. They do not certify global intersection freedom, valid internal
anatomy, organ relationships or human biomechanics. Edited geometry invalidates
its simulation proxy. The proxy is also checked by reconstructing the current
reference surface before use, including imported projects.

The XPBD preview is a spring/volume model with positional interaction, not the
planned SNH VBD solver, a force-calibrated sphere-contact test or a tissue material
identification method. No force measurement is invented. Cage/handle deformation,
advanced cutting, clinical pathology controls and a WebGPU solver are not part of
this browser slice.

The source assets are procedural and unreviewed. A learned parameter distribution
trained on that generator does not add independent human anatomy evidence.

## Verification

- `pnpm typecheck` checks the strict TypeScript application.
- `pnpm build` produces the Vite application.
- `pnpm test` includes the geometry fixtures for physical volume scaling, bounded
  brush support, immutable inputs, collapsed/nonfinite surfaces and reflections.
- Workspace Playwright tests cover geometry changes, locks, undo, JSON round trip,
  typed text edits, variation, real GLB downloads, compact layouts and retained
  tetrahedral-preview reports.

Keyboard shortcuts: V navigate; G grab; I inflate; T twist; S smooth; P probe;
F fit; Cmd/Ctrl-Z undo; Cmd/Ctrl-Shift-Z redo; Cmd/Ctrl-S save; Escape navigate;
`?` open the workspace guide. Reduced motion is respected.
