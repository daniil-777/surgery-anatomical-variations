# DSAD surgical appearance starter library

Six real human laparoscopic photographs and seven organ masks from the **Dresden
Surgical Anatomy Dataset (DSAD)**, by Matthias Carstens, Franziska M. Rinner,
Sebastian Bodenstedt, Alexander C. Jenke, Jürgen Weitz, Marius Distler, Stefanie
Speidel and Fiona R. Kolbinger. Used under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**.

- [Original dataset and licence](https://doi.org/10.6084/m9.figshare.21702600)
- [Dataset paper, Scientific Data 10, 3 (2023)](https://doi.org/10.1038/s41597-022-01719-2)
- [Official NCT Dresden mirror](https://huggingface.co/datasets/nct-tso/dsad)
- Pinned mirror revision: `010f843e7231420408ab2c878eb46c8df70f390d`.

The PNG photographs and binary PNG masks are **unchanged embedded file bytes**
from the official mirror's `multi_organ` parquet files. No recolouring,
resizing, image generation, or new anatomical annotation was applied. These
are final expert-reviewed masks, not model predictions or per-rater drafts.
`provenance.json` records original rows, capture groups, filenames and SHA256
checksums. `catalog.json` adds application identities, target mappings, and
selection bounds/points computed from these masks. Surface classifications are
our visual review of the view, not source-provided health or surface labels.

| Photo | Surgery / frame | Reviewed regions used |
|---|---|---|
| `dsad-25-6.png` | 25 / 6 | Liver, stomach |
| `dsad-12-29.png` | 12 / 29 | Spleen |
| `dsad-22-6.png` | 22 / 6 | Pancreas |
| `dsad-25-47.png` | 25 / 47 | Small intestine |
| `dsad-21-5.png` | 21 / 5 | Colon |
| `dsad-03-2.png` | 03 / 2 | Liver, brighter second capture group |

The reference library covers six organ classes across five surgeries. It does
not supply observed kidney, gallbladder, heart or lung appearance. It also does
not establish that the illustrated tissues are healthy or representative of all
patients. Photographs from one surgery are correlated observations. DSAD masks
can overlap; each supplied region is processed independently.

The photographs show illumination gradients, wet highlights, blood, adjacent fat,
and instruments. The first liver view is strongly shadowed: extraction retains
39.5% of its mask and emits a quality warning. The additional brighter liver view
retains 78.3%. Keep both provenance and the warning when pooling observations.
Pancreas is marked `surface: unknown` because the view is dissected/partially
exposed. Other regions are visually reviewed exterior views; this is not a
clinical certification. Use the provided masks and review the extraction overlay.

All seven regions were processed successfully by the local material-analysis API
on 2026-10-08. Evidence is in
`artifacts/whole-body-colour-2026-10-08/source-review/`, including original-mask
contact sheets and actual extraction overlays. This checks execution and visual
plausibility; it is not an independent segmentation benchmark or optical
calibration. Transfer measured appearance conservatively; these camera RGB values
are not intrinsic albedo, roughness, subsurface-scattering coefficients, or stiffness.

The 13 PNG assets total 8,217,391 bytes. Attribution applies to photographs,
masks, and derived visual review sheets. Dataset authors do not endorse this application.
