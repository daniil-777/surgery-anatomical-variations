# Cavity and contact validation — 25 October 2026

The release replaces the open posterior support with an enclosing lining, gives the wall a supported local deformation mode, and separates permanent anatomical attachments from nearby independent tissues. It also repairs a Float32-scale attachment sliver and prevents the camera from intersecting the visible instrument shaft or handle.

## Review sequence

1. Inspect the previous release and surgical reference images; record an enclosure/material iteration and sixteen interior/exterior views.
2. Remove excessive crackled wall relief after visual inspection.
3. Exercise actual mesh triangles under push and grasp. Preserve the failing liver attachment case, repair insertion precision, and rerun the strict suite.
4. Record intact-scene contacts, holds, lateral movement, withdrawal and release. Review original video frames in addition to force/finite-state traces.
5. Reject the initial contact matrix as visual acceptance because it contains camera/instrument intersections. Add a full-instrument camera guard and guarded oblique approaches, then rerun the entire matrix and explicitly isolated fixtures.
6. Test repeated inspection/return navigation, run performance measurements serially, smoke-test the public build, deploy, and verify the live workflows and asset hashes.

The final source also preserves the saved inspection light on an ordinary return and invalidates the actual-pose guard cache on each new contact. A dedicated regression checks same-revision re-engagement, and four further oblique grasp sequences exercise the final compiled build. The primary 57-case recordings preceded these two narrow fixes; both compiled bundle manifests are retained.

The source asset is **4,553,248 bytes**, SHA-256 `e0778985a61547fff92d0359adeb17e72ae5f87e2d7d51bb870b72e222c74b2a`. Earlier sixteen-view material captures use the enclosure-only asset; the later precision repair changes attachment coordinates by at most 0.000118312 mm. Final contact recordings and browser captures identify the final asset explicitly.

## Reproduction

Use Node 24, the repository's installed dependencies, and the supplied Playwright configuration. The local review scripts default to a public-copy server at `http://127.0.0.1:5177/` and Chrome with Metal on macOS.

```sh
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
node scripts/build_public_copy.mjs --out public-copy --keep-specimens
node node_modules/@playwright/test/cli.js test --config playwright.virtamed.config.ts
CAVITY_REVIEW_OUTPUT=/tmp/viscera-cavity-review/pass-2 node scripts/review_cavity_shell.mjs
CONTACT_OUTPUT=/tmp/viscera-cavity-contact/final-intact-v2 node scripts/review_virtamed_contact.mjs
node scripts/analyze_virtamed_contact_video.mjs /tmp/viscera-cavity-contact/final-intact-v2
BENCH_OUTPUT=/tmp/viscera-cavity-review/performance-1 node scripts/benchmark_virtamed_browser.mjs
BENCH_OUTPUT=/tmp/viscera-cavity-review/performance-2 node scripts/benchmark_virtamed_browser.mjs
node scripts/smoke_public_copy.mjs public-copy --port 8128 --out /tmp/viscera-cavity-review/smoke
```

The contact script's environment controls and fixture protocol are documented in [the temporal review](./temporal-contact-review.md). Do not run the performance benchmark concurrently with another browser or video decoder. Its previous-release baseline has approximately 60 rendered frames/s under motion, p95 animation intervals of 16.7–16.8 ms, zero idle renders and zero dropped physics time, at 1600 × 1100 with device pixel ratio 1. These are measurements of that Mac/Chrome configuration, not a device-independent performance guarantee.

The focused 189-test suite covers these fifteen files under `apps/studio/src`: `wholeScenePhysics`, `virtaMedScene`, `virtaMedInterfaces`, `sceneTissueResponse`, `sceneSurfaceUpdate`, `wholeSceneTools`, `wholeSceneContact`, `wholeSceneNavigation`, `laparoscopeLighting`, `virtaMedVasculature`, `operativeBloodOptics`, `abdominalCavity`, `virtaMedSurfaceDetail`, `virtaMedContactStress`, and `wholeSceneCameraClearance` (each with suffix `.test.ts`). Invoke the installed Vitest CLI with `run` and these paths. The mesh stress suite checks 384 sampled states across 24 load cases; its detailed exclusions and results are in [anatomical contact](./anatomical-contact.md).

The final local artifact directory is `artifacts/virtamed-cavity-contact-2026-10-25/`. Its `index.html` links unmodified screenshots, original videos, rAF traces, accepted and rejected iterations, test logs, two performance receipts, the deployment run, live asset hashes, and a scoped workspace-sync receipt. `validation-summary.json` supplies final counts rather than treating hidden or obstructed surfaces as successful intact-scene deformations.

## Interpretation

The checks assess rendering consistency, bounded deformation, attachment continuity, recovery and instrument visibility for the recorded paths. They do not validate surgical realism clinically. The remaining major mechanics limits are absent organ-organ collision/friction, cavity pressure, fluid transport and calibrated human properties. The closed shell has no trocar portals, so some approaches legitimately remain blocked. Isolating a concealed structure tests its response but does not prove access through intact overlying tissue.

Wall geometry and optics remain authored. The original source video constrains a visible hepatocystic field, not complete patient anatomy. See [cavity geometry](./abdominal-cavity.md) and [appearance evidence](./cavity-contact.md) for source attribution and visual limitations.

## Final measured result

The final build passes **189 focused tests and 10 browser workflows**, including repeated close-view lighting restoration. The contact review records **61 attempted cases**, **45 active contacts**, and **43 loaded deformations across all twelve parts**. Sixteen occluded approaches and two touch-only contacts remain separately identified. Across 17,825 rAF diagnostic samples there are no numerical/browser failures; the minimum observed full-instrument camera clearance is 17.78 mm. Four original videos contain 538.92 seconds of rendered behavior. These are sampled engineering observations, not continuous collision proofs or biological validation.

Two serial performance runs at the same 1600 × 1100 / DPR 1 configuration retain 59.99–60.03 rendered frames/s under motion, p95 animation intervals of 16.7–16.8 ms, zero idle scene renders and zero dropped physics time. The revision is **not a CPU speedup**: approximately eight-second held-grasp windows use 5.79–5.93 seconds of main-thread time versus 4.59–4.65 previously. Solver work increases from 127–133 ms to 608–609 ms per window; surface-update work increases from 2,525–2,550 ms to 2,664–2,667 ms. Independent attachment fields, an additional deformable wall and full-instrument guards add correctness work. This comparison is not an isolated causal profile of each change. The release preserves the measured desktop frame budget, with less CPU headroom; lower-powered devices need separate measurements.

The visual review accepts the repaired camera occlusion and stable localized response for these recorded paths. Broad anatomical shapes, flat-looking fat and repeated wall mottling still look synthetic. It does not conclude that the scene is photographically equivalent to real surgery.
