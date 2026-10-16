# Liver physics: video and dataset evidence review — 2026-10-07

The saved simulations demonstrate manipulation, shape change, contact, release and numerical regressions. They do **not** establish agreement with measured human liver mechanics. Public surgical videos help select realistic observation and contact protocols; none of the downloaded previews supplies a complete, calibrated liver force–deformation experiment.

This review concerns the recorded FEM and original browser edge/volume solver versions saved on October 7. It does not validate the later continuum candidate or AI v2 merely because those files now exist.

## Coverage and reproducibility

The full `benchmarks` video search found **17 liver physics files** across the recorded-physics, playground and laparoscopic-tool evidence families, plus two unrelated editor-probe recordings excluded from this review. All 17 were hashed, decoded, sampled and visually inspected. There are no byte-identical duplicates, but three MP4s are transcodes of saved WebMs: **14 distinct local recording runs**. Keeping encodings separate must not inflate experimental replication.

Eight small public clips were acquired: seven D4D previews covering four sessions, and one STIR demo from the official LiteTracker repository. One previously acquired chicken-skin pilot was also reviewed. Altogether: **26 byte-unique files, 545.62 seconds including alternative encodings/views, 20 distinct recording/session groups**. D4D's three rotating reconstructions and their stereo composites depict the same respective sessions; they are not independent experiments.

For every file, **12 uniform temporal frames were actually viewed**: 312 representative frames. Another 48 frames were inspected across three denser contact/release intervals: 360 viewed samples total. The [dense interval evidence](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/dense-review) records exact timestamps and observations. This is sampled temporal review, **not a claim to have watched every frame continuously**, and it can miss brief events. No claim is made to cover every internet video. The [complete per-file visual index](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/VIDEO_INDEX.md), [hash inventory](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/analysis/inventory.json) and [source/license ledger](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/reference-ledger.json) make the scope auditable.

## Findings in our recordings

![Independent trajectory measurements](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/trajectory-audit.png)

The historical sparse-node indentation model lost contact during continuing tool advance: simulated reaction fell from **0.213 N at 2.5 mm travel to 0.00199 N at 5 mm**. The corresponding corrected surface-quadrature run retained **0.535 N at 6 mm**. A soft-looking animation or a positive Jacobian would have missed this defect. These are different saved model versions, not measured force validation. The force curve is not required to be monotonic for every real tissue experiment; here its collapse exposed independently diagnosed sparse contact.

The historical female floor-drop run advanced only **0.1625 s of an intended 6 s**, with **1,401 rejected steps** and minimum Jacobian 0.0800007. Its late static image is a numerical hold, established from the clock and rejection log, not from optical flow alone. The subsequent saved fix advanced 6 s with zero rejections; the male and female final minimum Jacobians were 0.4165 and 0.8024. Numerical minimum-volume projections remained active. These figures describe the saved legacy solver, not the new candidate.

The laparoscopic grasp contains **3.200 mm rigid-aligned node RMS deformation**, with **55.63 mm centroid translation**. The sustained 12 mm probe reaches **2.015 mm aligned deformation / 1.778 mm all-pair distance-change RMS**, while the organ eventually slides **63.10 mm**. Camera position stays exactly fixed in those samples; visible probe center matches the solver center within floating-point error (1.01×10⁻¹⁴ mm). Thus shape change is present, and it is much smaller than whole-body movement.

Free-body motion on a floor is an explicitly requested boundary condition. Sliding is not intrinsically a defect and must not be “fixed” with invisible anchors. It does mean this recording cannot be compared directly with a liver supported by surrounding anatomy, ligaments, another instrument or an experimental plate. A surgical support protocol must specify its supports and friction separately. Height change also includes rotation; rigid-aligned position and pair distances avoid that particular confound.

In the strong-interaction videos, tissue partly or entirely leaves the viewport. This limits visual assessment even when numerical state stays finite. Mobile captures contain substantial padding and a small tissue image. The recorded predefined-seam cut visibly changes to a coarse, faceted domain: it demonstrates severed seam connectivity, not realistic free-form cutting, capsule tearing or blade/shaft/jaw collision.

Independent tetrahedron determinants reproduce the saved final FEM minimum Jacobians (indent/grasp/cut: **0.8287 / 0.9635 / 0.9812**) and maximum absolute total-volume changes (**0.0862% / 0.1113% / 0.0484%**). The grasp hold end/start reaction ratio is 0.8929; the indentation ratio is 0.3690. These include structural/contact response and are not direct estimates of a constitutive relaxation fraction. End-of-record residual/max displacement ratios are 0.1017 and 0.3956 respectively; they are neither fitted recovery times nor independent accuracy scores. The [trajectory audit](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/trajectory-audit.json) retains signed reported-force work, force-magnitude impulse and every computed frame.

## What the public clips show

![D4D stereo manipulation composite](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/analysis/94f75c8d415c/contact-sheet.jpg)

D4D provides porcine-cadaver stereo scenes and structured-light geometry. In the downloaded stereo composites, jaw approach progresses into local tissue tenting and creasing; the manipulated region becomes partly hidden behind the instrument. The exact contacted organ in these previews has not been established from specimen metadata, so they are **abdominal manipulation examples, not verified liver-parenchyma tests**. Three other previews are rotating rendered point clouds with holes: their silhouette changes mostly reflect viewpoint and reconstruction coverage. The fourth stereo session explicitly repositions the camera. The full dataset's curated start/end structured-light captures are more useful for geometry validation than treating a displayed stereo-derived depth map as truth. Force sensing is not documented. [D4D project](https://reubendocea.github.io/d4d/), [dataset paper](https://www.nature.com/articles/s41597-026-08289-7), [data repository](https://doi.org/10.25532/OPARA-1033).

![STIR manipulation sequence](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/analysis/9ba7f248fcc5/contact-sheet.jpg)

The STIR demo shows two jaws tensioning and lifting a small tissue/membrane region, followed by jaw opening around 19.56 s and retreat around 19.95 s in the denser review. Gauze, specular highlights and jaw occlusion make image tracking harder. Exact clip species/tissue mapping remains unverified. The underlying STIR data use infrared tattoos and calibrated stereo to evaluate tracking; original labels emphasize endpoints. This is an appropriate tracker test, not force or stiffness ground truth. LiteTracker is a practical online-tracking candidate to evaluate, not a network that was run or validated in this audit. [STIR paper](https://arxiv.org/html/2309.16782v2), [official LiteTracker code/demo](https://github.com/ImFusionGmbH/lite-tracker).

The existing force-video pilot depicts **ex-vivo chicken skin, not liver**. It shows local tenting, creases and release against a support. Its prior readiness assessment records missing camera/hand-eye calibration, force-frame calibration, unverified synchronization, and unknown contact/boundary/thickness information. It remains a data-pipeline comparator, not a source of liver elastic constants. [Author dataset](https://zenodo.org/records/21041361), [paper](https://doi.org/10.1142/S2424905X24400087).

### Supplementary explicitly identified liver example

After the initial inventory, the authors’ [Learning to See Forces animation](https://raw.githubusercontent.com/gaocong13/Learning-to-See-Forces/master/imgs/force_pred.gif) was inspected at 12 overview and 16 denser loading/release frames. Its scene matches the paper’s Figure 1 liver-study screenshots and Figure 2E/F, explicitly identifying a fresh **ex-vivo pig liver**. It shows local indentation and rebound on a support plate, with a large specular hotspot. The plot is a presentation of force prediction, not downloaded sensor data. Its time axis spans about 200 labelled seconds during a 31.5-second GIF: **playback time cannot measure relaxation**. No explicit media reuse license was found; the original GIF remains temporary, with attributed [derived review sheets and provenance](../../benchmarks/results/liver-physics-v2-2026-10-07/video-review/supplemental-pig-liver) retained. This supplements the 26-file archive: **27 media files inspected, 388 sampled frames overall**. [Paper and identity captions](https://arxiv.org/html/1808.00057v1).

## Dataset selection and mechanical identification

| Source | Useful role | What prevents direct liver material calibration here |
|---|---|---|
| [StereoMIS](https://zenodo.org/records/8154924) and [tracking subset](https://zenodo.org/records/10867949) | In-vivo porcine stereo tracking, breathing/tool motion, camera poses, manually tracked points in subset | No measured forces; pose/segmentation uncertainty; subset CC BY metadata differs from upstream noncommercial share-alike terms. Archives were not downloaded. |
| [SurgT](https://arxiv.org/html/2302.03022v3) | Independent clinical soft-tissue tracking benchmark with case-wise evaluation | Tracking is not constitutive validation. Data endpoint was unavailable here; code license is not data permission. |
| [Lister et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC3160273/) | Strong experimental template: in-vivo porcine indentation, force, probe displacement and stereo surface markers with documented supports | One animal; gravity/prestress/supports matter. Raw open videos/data were not located. |
| [Porcine indentation with 3D ultrasound](https://pmc.ncbi.nlm.nih.gov/articles/PMC2702784/) | Joint force and internal deformation observations | Perfused porcine preparation differs from human surgery; raw calibrated release not acquired. |
| [Learning to See Forces](https://arxiv.org/html/1808.00057v1) | Force/video learning example using pig liver RGB-D | One specimen; specimen-base normal force, severe loads up to 190 N, random frame splits and centered temporal windows limit transfer and causal deployment. Author animation reviewed separately; no licensed full dataset acquired. |
| [P2I-LReg / Self-P2IR](https://github.com/junzastar/Self-P2IR) | Human liver images and preoperative geometry for registration | Sparse keyframes and no force labels; dataset terms not established here. |
| [SuPer](https://ucsdarclab.com/projects/surgical-perception/) | Surgical tool/tissue tracking and robot interaction | Exact tissue and measurement contract must be checked per sequence; not assumed to be liver or force labelled. |

For a defensible next calibration dataset, require the same specimen's geometry and units, force-sensor frame/offset/calibration, synchronized tool pose, contact geometry, visible landmark tracks with uncertainty, support configuration, loading/hold/release timing, hydration/temperature and specimen provenance. Fit multiple loading rates, depths and locations, then evaluate held-out **specimens and protocols**. Hold out entire subjects/sessions rather than adjacent video frames. Use stereo/structured-light geometry to reduce camera ambiguity, force to constrain stiffness, and loading/relaxation/recovery to distinguish elastic, viscous and boundary effects. A video without calibrated loading can constrain motion; it cannot uniquely identify elastic modulus.

## Metrics and limits

The reproducible image audit uses Farneback flow at 2 Hz and a declared 480 px image width, with forward/backward consistency checks. Browser ROI is a heuristic largest pink/red component; public clips use non-dark pixels. Consecutive color-component IoU and area are **unvalidated image diagnostics**, not annotated tissue silhouette accuracy. Flow combines tissue, camera, instrument, lighting and reconstruction motion. The full-frame/composite metrics must not be compared as a tissue-realism leaderboard. A low-motion fraction cannot separate rest, pause, loading screens and frozen simulation. Calibrated strain, stiffness and physical-validation fields therefore remain **NOT_RUN/null** for video-only records.

For future paired measurements, report landmark RMSE/p95 in mm and visibility coverage; calibrated silhouette overlap where actual masks exist; force NRMSE with explicit denominator; impulse/work error with sign and units; protocol-aligned relaxation/recovery; contact penetration and lost-contact intervals; volume/Jacobian, residuals, rejected/projection steps and simulation-time/wall-time ratio separately. Align by measured timestamps on the common overlap. Do not use time warping to conceal incorrect dynamics. Appearance synthesis can improve rendering without improving mechanical truth.

## Running the audit

Dependencies used: Python 3.11.16, NumPy 2.4.6, OpenCV 4.13.0, Pillow 11.3.0, ffmpeg/ffprobe; Matplotlib 3.11.2 for the plot. Raw public clips, license snapshots and hashes are retained only as research evidence. The STIR repository has noncommercial terms; these clips were not imported into the application or used to train a material network. Dataset provenance and license lineage must travel with any later training manifest.

```sh
python scripts/assess_liver_videos.py \
  --root benchmarks/results/liver-physics-2026-10-07/browser \
  --root benchmarks/results/liver-playground-2026-10-07 \
  --root benchmarks/results/liver-laparoscopic-tools-2026-10-07/browser \
  --root benchmarks/results/liver-physics-v2-2026-10-07/video-review/external \
  --output /tmp/liver-video-audit --sample-hz 2
python -m unittest discover -s scripts -p test_liver_video_assessment.py
```

Four independent checks pass: identical/known translated images, unobservable ROI and invalid time/shape, rigid-motion invariance of 3D shape metrics, and tetrahedron orientation/inversion. `assess_liver_trajectories.py` accepts saved experiments and instrument snapshots; `plot_liver_video_audit.py` regenerates the figure. `extract_video_interval.py` reproduces the explicitly timed dense manual-review intervals. The scripts neither change original evidence nor infer material parameters from appearance.
