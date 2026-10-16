# Real surgical sources for whole-body material transfer

Research and implementation checkpoint: **2026-10-08**.

The practical starter is a small, attributable collection of real surgical RGB
images with published anatomical masks. It supplies explicit observed organ
colours; missing organs retain authored materials or a separately disclosed
appearance prior. A single photograph cannot reveal colours of unobserved organs
or identify their optical properties. Colour evidence and anatomical identity
must remain distinct.

## Selected and integrated: DSAD

The [original Dresden Surgical Anatomy Dataset](https://doi.org/10.6084/m9.figshare.21702600)
contains abdominal laparoscopic images and semantic organ annotations, and
explicitly licenses them CC BY 4.0. The [official NCT Dresden mirror](https://huggingface.co/datasets/nct-tso/dsad)
distinguishes final physician-reviewed masks (`single_organ`, `multi_organ`)
from per-rater/STAPLE masks. We used the final `multi_organ` masks. The
[paper](https://doi.org/10.1038/s41597-022-01719-2) documents acquisition and
annotation; its surgical cohort must not be relabelled a healthy-tissue atlas.

Acquisition used only public byte-range requests against the pinned parquet
revision `010f843e7231420408ab2c878eb46c8df70f390d`. Mask columns were read with
PyArrow 25.0.1. Selected original PNG image cells were extracted from uncompressed
PLAIN parquet pages, avoiding the 19 GB original archive and lossy dataset-viewer
JPEG previews. PNG signatures, decode, dimensions and binary mask values were
checked; every shipped asset has a SHA256 in the provenance manifest. No source
PNG was re-encoded.

The integrated library at `apps/studio/public/body-reference/` contains six
1280×1024 RGB photographs and seven masks, 8.22 MB total:

| Split / row | Surgery / frame | Material identity | Original mask pixels |
|---|---|---|---:|
| train / 581 | 25 / 6 | liver | 603,053 |
| train / 581 | 25 / 6 | stomach | 564,475 |
| train / 200 | 12 / 29 | spleen | 250,196 |
| train / 383 | 22 / 6 | pancreas | 208,465 |
| train / 622 | 25 / 47 | small-intestine | 151,449 |
| validation / 89 | 21 / 5 | large-intestine → scene `colon` | 244,884 |
| validation / 2 | 03 / 2 | liver | 826,640 |

These are six tissue classes and five surgery groups, not seven independent
patients. The second liver observation comes from a different surgery. Catalogue
`capture_group` and the full provenance manifest preserve that distinction.

Visual review confirmed masks align with their source views and avoid most
tools/adjacent tissues. Masks remain the published annotations; we did not claim
clinical re-annotation or perfect boundaries. Images contain specular glare,
shadows, blood/fat and partial occlusion. The exposed pancreas surface is marked
unknown; other selected views are classified as outer surfaces by visual review.
Surface classification is not a source dataset label.

All seven supplied masks passed the actual local API extraction. At the API's
1024-pixel analysis size, retained pixels range from 73,771 to 414,011. Accepted
fractions are 39.5% for the shadowed liver, 64.4% stomach, 75.7% spleen, 70.7%
pancreas, 76.0% small intestine, 72.6% colon and 78.3% for the brighter liver.
The shadow warning is preserved. Recorded local latency was 0.31–0.44 seconds
per region. This is an execution/visual check, not segmentation accuracy,
clinical correctness, or calibrated colour validation. The source already
provides masks; this test does not assess SAM generalisation.

Evidence: `artifacts/whole-body-colour-2026-10-08/source-review/analysis-summary.json`,
`source-masks.jpg`, and `accepted-colour.jpg`.

## Alternatives checked and coverage gaps

- [HeiSurF's primary Synapse listing](https://www.synapse.org/Synapse:syn25101790/files/)
  was located, but a clear exact redistribution licence for its image/mask files
  was not verified in the accessible primary listing. It was not bundled.
- [HeiCo](https://www.nature.com/articles/s41597-021-00882-2) explicitly uses
  CC BY-NC-SA. It is unsuitable for this freely redistributable starter.
- [ATLAS-120k, official repository](https://github.com/TimJaspers0801/ATLAS) and
  [dataset](https://huggingface.co/datasets/TimJaspersTue/ATLAS-120k) offer broader
  surgical anatomy coverage, but carry CC BY-NC-SA 4.0, gated terms, and separate
  video retrieval. They were excluded from the starter.
- [xeno-spectral](https://www.spectralverse-heidelberg.org/xeno-spectral/) is a
  promising future spectral source. Its primary page states CC BY 4.0 and
  distinguishes physiological, malperfused and ICG states with semantic
  annotations. Its pig/rat acquisition and spectral-camera appearance require
  explicit species/state handling; it was not substituted for human camera RGB
  in this delivery. Small example archives are offered for future investigation.

Kidney, gallbladder, heart, lungs, ducts, vessels and other scene structures have
**no directly observed source in this starter**. Do not silently call an inherited
or authored colour measured. Additional calibrated, consented and appropriately
licensed references can fill those gaps later without changing this explicit
organ-to-mask-to-material contract.
