# Liver physics v2: final browser and video assessment

The final corrected continuum solver and AI v2 passed **8 actual browser/API cases in 80.35 seconds**, with no skipped or retried cases. These verify implementation, interaction and numerical integrity. **Measured human-liver physical validation remains NOT_RUN.** The material examples used for acceptance are synthetic calibration histories.

[Watch the final instrument demonstration](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/liver-physics-v2.mp4). [Machine-readable verification](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/verification.json), [raw Playwright results](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/results.json), [video inventory](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/video-analysis/inventory.json), and [independent trajectory audit](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/independent-shape-audit.json) retain provenance and numerical measurements.

## What was exercised

The live suite used the actual API on port 8012 and browser on port 5198, without mocked physics responses. It covered visible grasper closure/lift/release; the visible probe and its actual solver contact center/radius; tool switching, pause and Orbit release; mobile touch; gravity, floor settling and supported pressing; repeated strong interactions; explicit manual material application; and keyboard control. Three varied calibration histories—ramp/hold/release, triangular and cyclic—were imported into AI v2. The accepted modulus/relaxation parameters were checked against the prepared liver and displayed runtime. An elastic-only history was refused as insufficiently identified, rather than applied.

Final source hashes are recorded in [source-hashes.json](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/source-hashes.json). The solver is `8da97ee7…`, the corrected material implementation is `7865b402…`, and the sampling-test change is `3812f7ea…`. Every saved runtime snapshot identifies `material_model: continuum`, fixed step 1/120 s, and four nonlinear sweeps. The live browser case uses the learned HRA female cage with 99 nodes and 324 tetrahedra. Other specimen/material coverage is in the separate mechanics benchmark; these browser results should not be generalized beyond their recorded cases.

## Measured behavior

| Observation | Final result | Interpretation |
|---|---:|---|
| Minimum recorded element Jacobian across 92 serialized snapshots | 0.66785 | Positive sampled element volumes; this is not clinical validation |
| Maximum floor penetration | 0 mm | Floor contact constraint satisfied in saved states |
| Whole-step rejections / limited steps | 0 / 0 | No recorded numerical freeze/fallback |
| Local rejected vertex updates / line-search backtracks | 0 / 0 | Corrected constrained floor solve avoids the earlier non-descent updates |
| Floor-settled volume change | −1.2417% | Small global volume change under this protocol |
| Floor-settled minimum Jacobian | 0.84221 | Local compression differs from total volume change |
| Mean reported step cost at settled snapshot | 1.666 ms | Host-specific measurement, not a general device guarantee |
| Simulated / external wall time during settling | 5.058 / 5.011 s | Approximately 1.0×; 5 Hz diagnostic endpoint jitter explains the 1.009 ratio |
| Dropped / rejected time at settled snapshot | 0 / 0 s | Fixed physical time advanced in this interval |
| Grasp pair-distance-change RMS | 1.3136 mm | Nonrigid change, independent of translation/rotation |
| Supported probe peak pair-distance-change RMS | 1.7371 mm | Visible contact causes actual shape change |
| Visible probe center versus solver center | < 10⁻¹⁴ mm | Visual geometry and contact state agree to floating-point precision |
| Maximum observed compliant probe overlap | 1.8305 mm | Nonzero penetration remains an explicit contact approximation |

Independent Kabsch alignment gives grasp shape RMS **1.3000 mm** while the centroid moves **52.09 mm**. Probe peak aligned RMS is **1.7312 mm**; the centroid eventually moves about **58 mm**. Most gross screen motion is therefore not local tissue strain. Edge strain and pair-distance change are invariant to rigid movement; bounding-box height change also includes rotation. The free liver sliding on the floor is consistent with the requested boundary condition. It does not represent a liver attached to an organ bed, and no invisible anchors were added to imitate that condition.

![Final floor-supported pressing](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/atlas-laparoscopic-tools-v-a512d-ase-on-pause-or-tool-switch/04-probe-pressing.png)

## Transient sampling and preserved failures

The first corrected run passed 7/8 cases. Its punch test observed the pre-impulse diagnostic, then a state about 0.42 simulated seconds later; shape change had fallen to 0.0192 mm, below the unchanged 0.05 mm gate. The application publishes diagnostics at 5 Hz, so a short transient cannot reliably be assessed by sparse polling. This failed run is retained under `development-punch-sampling/`.

The test now triggers the existing Pause button 40 ms after a real pointer-down event and reads the frozen state at the next diagnostic publication. It neither alters the solver nor increases the impulse nor lowers the deformation threshold. Three independently reset observations produced **0.10687, 0.10687 and 0.09465 mm** pair-distance change at measured pause delays **49.2, 46.7 and 43.4 ms**. All three passed. Raw states and actual delays are saved in `punch-early-captures.json`. The temporary listener-propagation failure and the targeted successful confirmation are also retained as development evidence.

An earlier continuum run passed browser gates but accumulated 8,015 rejected vertex updates and 82,314 backtracks at its floor snapshot. Independent review found that clipping the vertical component of a coupled Newton direction could destroy descent. The corrected constrained XZ solve reduced both counts to zero in the final browser floor sequence, without changing tissue parameters. The earlier run remains under `development-before-floor-active-set/`; it is not labeled final evidence. Different interactive timings mean its screenshots are not a controlled stiffness comparison.

## What was actually viewed

The final set contains **8 byte-unique raw videos totaling 82.72 seconds**. All eight contact sheets were visually inspected by AI agents; expert/human review was not performed: **12 uniformly spaced frames per clip, 96 frames total**. Three further 16-frame intervals from the main instrument clip were inspected, for **144 inspected frame samples overall**. This is sampled temporal review, not a claim to have watched or assessed every frame continuously. The MP4 is a convenience transcode of one raw WebM, not an additional experiment. The [earlier public/local evidence review](LIVER_VIDEO_EVIDENCE_2026-10-07.md) has its own inventory cutoff, public-source ledger and coverage counts.

| Dense interval | Visual finding and confound |
|---|---|
| 2.5–5.5 s: grasp and release | The instrument closes and lifts the liver, then releases. The abrupt return around 4.5 s is an explicit Reset action; it must not be called passive recovery. |
| 11.5–14.0 s: probe loading | Probe and floor-supported liver remain visible. Local deformation occurs alongside substantial sliding; this is not a fixed-boundary indentation experiment. |
| 16.5–18.65 s: probe release | Probe disengages near 17.2 s; Orbit hides it and Grab shows the grasper. There is no reset in this interval. Shape changes are subtle; no modulus or relaxation time is inferred from these rendered pixels. |

![Dense probe release samples](../../benchmarks/results/liver-physics-v2-2026-10-07/browser/dense-review/probe-release/contact-sheet.jpg)

The ordinary desktop and mobile gestures keep the relevant body/tool contact visible. **The strong repeated free-body stress case moves the liver partly and then completely above the fixed camera view around 7–11 s.** Positive finite node metrics remain available, but that portion of the video cannot establish visual realism. Mobile recordings include gray padding outside their 390-pixel application viewport because the video canvas stays 1500×1100; this is a recording artifact. A distant handle may lie outside the close-up mobile view.

The 2 Hz optical-flow/contour analysis is reproducible, but its color-derived region is unvalidated. Flow mixes tissue, instrument, camera, lighting and UI motion. Preparation overlays, resets, pauses, Orbit and viewport resizing must be separated from tissue dynamics. The recorded 3D node trajectories supply the calibrated millimeter shape measurements; pixels alone do not supply force, material strain or stiffness ground truth.

## Limits and reproduction

The grasper uses a compliant attachment patch. The probe uses spherical compliant contact with the overlap reported above. Jaws and shafts are rendered geometry without separate collision; this browser protocol does not establish cutting realism. Floor friction, added damping and supports are prescribed assumptions. The small-strain SLS calibration, synthetic uncertainty intervals, coarse cage and finite nonlinear iteration budget all limit inference about real surgery. The final-sweep correction is a solver-progress measure, not an equilibrium residual certificate.

The checked-in commands reproduce the tests and diagnostics from the repository root, with its configured dependencies and live API/UI:

```sh
node node_modules/@playwright/test/cli.js test --config playwright.physics-v2-final.config.ts
python scripts/assess_liver_videos.py --root test-results/physics-v2-final --output /tmp/liver-video-reassessment --sample-hz 2
python scripts/assess_liver_trajectories.py --instruments benchmarks/results/liver-physics-v2-2026-10-07/browser/atlas-laparoscopic-tools-v-a512d-ase-on-pause-or-tool-switch/instrument-metrics.json --output /tmp/liver-shape-audit.json
python scripts/extract_video_interval.py benchmarks/results/liver-physics-v2-2026-10-07/browser/atlas-laparoscopic-tools-v-a512d-ase-on-pause-or-tool-switch/video.webm --start 16.5 --end 18.65 --count 16 --output /tmp/liver-release-review
```

Video tool versions, media SHA256 hashes, exact sample timestamps, agent visual observations, test inputs, source hashes and raw results accompany the artifacts. A new extraction must remain marked pending visual inspection until its images are actually inspected.
