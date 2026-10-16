# Physics parameter learning: research release

As of 7 October 2026. This increment delivers a research review, inspected source observations and a numerical observability diagnostic. It does not deliver a trained or calibrated organ physics model.

- The [17-page illustrated report](../../reports/VISCERA%20Physics%20Parameter%20Learning%20Research%202026-10-07.pdf) compares 12 core papers, 5 supporting works and 16 source families.
- [Primary-paper review](PHYSICS_PARAMETER_PAPERS.md), [data sources](PHYSICS_VIDEO_SOURCES.md) and [Studio integration audit](PHYSICS_STUDIO_INTEGRATION_PLAN.md) provide the detailed evidence and architecture decisions.
- [Paper matrix](../references/physics/paper_matrix.json), CSV, bibliography and audited repository/license snapshots retain research provenance. Downloaded papers are a local reading cache, not training assets.
- [Actual video review](../physics-review/index.html) presents the acquired ex-vivo chicken-skin sequence with force and robot-pose plots. The source data are CC BY 4.0 with attribution. This is a standalone inspection page, not a deformed Atlas simulation.
- [Calibration readiness](../physics-releases/source-pilot/calibration-readiness.json) explicitly prevents material-parameter promotion: force registration, acquisition timing, contact, boundaries, rest geometry and model admissibility remain unresolved.
- [Synthetic diagnostic](../artifacts/physics/research/observability.json) demonstrates stiffness-scale ambiguity in the existing quasistatic displacement-controlled block. It compares full solved coordinates, then fits a same-model noiseless synthetic reaction-force curve. Neither result measures an organ property.

## Run locally

From `viscera/`, using a Python environment with NumPy, SciPy, Matplotlib and the existing project dependencies:

```sh
python scripts/verify_physics_pilot.py physics-releases/source-pilot
python physics-review/verify_package.py
PYTHONPATH=py python scripts/research/verify_stiffness_observability.py
python physics-review/serve.py --port 5191
```

Open <http://127.0.0.1:5191/>. The local-only server supports HTTP byte ranges for reliable video seeking. Source JPEG/record timestamps remain authoritative; the preview preserves all 1,747 left images and documents its bag-time offset. This does not establish hardware synchronization.

Rebuilding extracted data requires `rosbags==0.11.5`; preview encoding requires `ffmpeg`/`ffprobe`. Report generation additionally needs ReportLab and Pillow:

```sh
python scripts/research/build_physics_research_report.py
```

The report builder writes `research-report/`; the delivered report and image assets are also copied into the repository's top-level `reports/`. It uses existing audited artifacts and does not fetch new data.

## Checks actually completed

Pilot integrity: 3,509 files, original bag checksum, finite numeric arrays, source correspondence, quaternion norms, 1,747 preview-frame timestamps and failed calibration gates. The original download is 281.6 MB; decoded/derived release size is larger.

Viewer: playback, arbitrary/chart/keyboard seek, source-sample stepping, playback speed, signal readouts, downloads, three viewport widths, no console/network errors, and automated accessibility checks. These are functional checks; they are not clinical or mechanical validation. No previous visual regression baseline existed; screenshots were inspected directly.

Numerical diagnostic: energy/stress/reaction homogeneity, full/free/surface coordinate comparisons, parity with the original block fixture, and a same-model reaction calibration with held-out depths. Core mechanics, frozen disease datasets/models and Studio behavior are unchanged.

## Next implementation decision

Start with a registered force/displacement/geometry experiment and a small identifiable constitutive family. MULTIS is a useful measured-load/strain source; D4D is a useful abdominal-deformation source. Their tissue types and observations are different, so they must not be fused into fictitious ground truth. Add rate dependence, friction and neural energy models only when independent measurements and withheld interactions support them.
