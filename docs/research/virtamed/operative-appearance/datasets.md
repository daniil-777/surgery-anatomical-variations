# Laparoscopic appearance dataset audit

Date: 2026-10-25. Scope: primary dataset access, rights, local download, visual examination, and bounded material-learning input. No application source or training code changed by this audit. This is an engineering visual review, not a surgeon's clinical validation.

## Downloaded and inspected

**DSAD:** downloaded 20 new training RGB viewer renditions plus 20 corresponding organ-mask viewer renditions from 10 separated row offsets of the official `nct-tso/dsad` Hugging Face mirror. Exact frame IDs, immutable content hashes, sizes, API URLs and signed source URLs are in `download-manifest-rows.json`. These are additional to the project's previous 03/2, 25/47 and 21/5 references. Downloaded response bytes are unmodified, but **the official viewer delivers JPEG renditions**, including masks; local `.png` suffixes do not indicate encoding. They retain 1280×1024 resolution, but are not the original lossless PNG data. Do not use lossy mask pixels as exact binary ground truth. Compression-aware low-frequency RGB analysis is possible with this limitation explicit. The underlying organ annotations do **not** label spilled blood, fluid, or exposed tissue. The current official card supplies patient-group splits and describes 13,195 images from 32 surgeries. [Official DSAD card](https://huggingface.co/datasets/nct-tso/dsad/blob/main/README.md)

**GynSurg:** downloaded two 3-second bleeding clips (case 505, clips 3 and 5) through documented HTTP byte ranges, transferring 3,963,772 bytes rather than the full 26,107,010,897-byte archive. Local probes confirm **720×480 at 30 fps**, despite the dataset webpage describing higher-resolution original recordings. Exact archive entries and SHA256s are in `gynsurg-download-manifest.json`, with six extracted time samples (0.2, 1.5, 2.8 seconds). Both clips are from the same case and were selected for small download size: illustrative temporal references, not a representative validation set. They remain in `gynsurg-research-only/`, excluded from model fitting, textures and deployment. [Official GynSurg release](https://ftp.itec.aau.at/datasets/GynSurge/)

A failed DSAD filtered-rows API request returned HTTP 500; ordinary paginated official rows worked. The failed empty `download-manifest.json` is retained as diagnostic evidence; **use `download-manifest-rows.json`**. `download_rows.py` and `gynsurg_subset.py` reproduce the successful bounded download methods.

## Rights and suitability

| Source | Verified access / labels | Rights finding and decision |
|---|---|---|
| DSAD | Official HF rows; full Figshare ZIP 20,884,637,683 bytes; expert organ masks and weak labels | Official HF metadata and original Figshare record both explicitly **CC BY 4.0**. Preserve author attribution, source and modification notice. **Discrepancy:** the paper's Usage Notes say “non-commercial” while naming CC-BY. Report this ambiguity; do not claim unrestricted rights without qualification. Source license snapshots are local. |
| CholecSeg8k | Original Kaggle API: 8,080 frames, 13 classes including blood, fat and connective tissue, 854×480; 3.11GB | Original publisher API and description explicitly **CC BY-NC-SA 4.0**. Research comparison only for this production task; no derived texture/model input. Watershed blood label is **0x24 = 36**, although its table class index is 7. |
| GynSurg | Action/bleeding/smoke clip labels; separate anatomy/instrument masks | Official disclaimer restricts use to scientific research. Footer links CC BY-NC 4.0 but mistakenly names ENID. Enforce the restrictive scientific-only wording; no production derivatives. |
| SurgBlood | Official code page links a test set; 5,330 annotated frames, region and source-point labels | Official repository says academic/research only, no commercial use or redistribution of modified derivatives without permission. SharePoint link redirected to institutional sign-in during this audit. Not downloaded. |
| EnCoV bleeding segmentation | Author-hosted 2022 paper links `bleeding_segmentation_v1p0.zip`; 949 labeled images discussed | Dataset license not established. Author download host failed TLS hostname verification locally. No bypass, no downloaded data, no production reuse. |
| HemoSet | Author paper describes 11 videos, 857 labeled frames from porcine robotic thyroidectomy, 640×480 | Dataset/project license not verified; do not infer data rights from paper availability. Useful methodological comparison, not production input. |

Primary evidence: [Figshare metadata API](https://api.figshare.com/v2/articles/21702600), [DSAD paper](https://www.nature.com/articles/s41597-022-01719-2), [original Kaggle metadata API](https://www.kaggle.com/api/v1/datasets/view/newslab/cholecseg8k), [SurgBlood official repository](https://github.com/PJLallen/SurgBlood), [EnCoV author paper](https://encov.ip.uca.fr/publications/pubfiles/2022_Rabbani_etal_MIDL_bleeding.pdf), [HemoSet author paper](https://arxiv.org/html/2403.16286v1).

## Visual observations from the actual downloads

These are direct visual observations, not diagnoses or measured tissue properties:

- `colon-29-15`: pale stretched sheets have thin translucent strands; sparse red smears preserve the pale substrate, with darker local deposits. White glare is fragmented and highly localized. The surgical instrument occupies much of the center; it must never enter texture fitting.
- `pancreas-22-51`: an exposed irregular pink lobular surface abuts smooth orange tissue. The dissection margin has darker red material, tiny gaps and stretched filaments. The entire field is not uniformly red or rough.
- `small_intestine-23-42` (**held out**): richly vascular but intact pale serosa is immediately adjacent to a dark-red irregular operative bed. Gauze has an obvious woven pattern; learning from it would create an artificial mesh imprint on organs.
- `abdominal_wall-04-0`: fat remains orange under a clear moist coat, with isolated short red marks and narrow curved vessels. Pinpoint glare does not imply white diffuse material.
- GynSurg temporal samples: broad red films follow existing smooth tissue; underlying surface structure remains visible. Deep dark-red material collects centrally and in recesses, while moving instruments and viewpoint change the saturated reflection independently of the stain.

These examples support **separate local appearance layers**: clean tissue substrate, translucent red film, sparse darker deposits/pools, and exposed fibrous/lobular structure. Random red speckles across every organ would contradict the observed localization. Smooth film and irregular exposed tissue should not share the same normal amplitude or roughness.

## Reviewed fitting regions

`roi-manifest.json` supplies ten exact original-pixel bounding boxes, source hashes, visual labels, exclusion rules and diagnostic color summaries. `roi-review.html` displays the unmodified source frames and the reviewed boxes.

- Fit surgery IDs: **04, 22, 28, 29**.
- Holdout surgery IDs: **10, 23, 31**. Never fit adjacent frames from these surgeries.
- Six fit ROIs: intact fat, thin red film, small dark-red deposit, exposed fibrous sheet, exposed lobular region, clean liver capsule.
- Four holdout ROIs: intact serosa, thin red film, fibrous tissue, intact fat.

These are human-readable visual ROI annotations by the assistant, **not expert blood segmentation ground truth**. Apply the documented bright/dark pixel exclusion before estimating chromaticity. Raw RGB medians contain camera white balance, illumination, exposure and compression; they are not calibrated albedo or optical absorption coefficients. Use chromaticity/relative contrast distributions with explicit uncertainty, rather than copying the observed illumination into diffuse textures. Several fit regions are small and correlated; no broad generalization claim is justified.

## Label semantics affect the approach

SurgBlood's author paper explicitly excludes pooled blood and inactive sparse stains from its bleeding-region masks. HemoSet's annotator instructions target suctionable blood pools and exclude mere discoloration/stains. Thus, their “blood” masks do not directly supervise the residual films and visual clutter requested here. Use distinct labels for stain, pool, exposed tissue and clean serosa; preserve normal vessels and liver as negative examples. [SurgBlood dataset definition §3](https://arxiv.org/html/2503.22174v2), [HemoSet annotation guidelines](https://arxiv.org/html/2403.16286v1)

The EnCoV paper reports ambiguity between active bleeding, steady blood and normal tissues, including faded boundaries; temporal context helps but does not eliminate annotation subjectivity. This supports keeping static appearance fitting separate from a claim to model or detect active hemorrhage. [EnCoV study](https://encov.ip.uca.fr/publications/pubfiles/2022_Rabbani_etal_MIDL_bleeding.pdf)

## Implementation and review implications

1. Fit a small, versioned appearance model only from reviewed, rights-compatible regions; record all IDs, splits and hashes. Keep assumptions visible and preserve patient-group holdout.
2. Use a surface-attached film field with soft irregular boundaries and variable optical depth, not screen-space decals or baked white highlights. Preserve base tissue detail in thin films and attenuate it in deeper deposits.
3. Localize the operative changes around modeled dissection/contact regions. Maintain a clean-field baseline and adjustable severity; disease variation alone does not imply operative bleeding.
4. Compare clean and changed renders from front/oblique/close views with identical camera exposure. Check coherent reflections, rooted coloration under deformation, avoidance of repetition, and absence of gauze/instrument/text contamination.
5. Report statistical fit and visual improvements separately from physical or clinical validation. No flow solver, measured fluid parameters, or surgeon approval is established by this dataset audit.
