# Whole-body appearance from one or a few surgical images

Research checked 2026-10-08. This extends [the single-region material research](surgical-appearance-2026-10-08.md). The implemented scope is appearance authoring from reviewed, observed RGB colours. It does not identify unseen organs or recover patient-specific reflectance, roughness, subsurface scattering or physiology.

## Decision

Use multiple labelled and reviewed regions, pool observations separately for each explicit atlas target, then apply a perceptual colour adjustment to the existing procedural materials. Preserve authored missing organs by default. Offer narrowly related outer-tissue borrowing and a small whole-body palette shift as separate, labelled inference options. Never equate a whole image histogram with the colour of all tissues.

This is an engineering recommendation from the reviewed evidence and the available inputs, not a claim that a published method has clinically validated this exact pipeline. One photo can provide several measured regions; it cannot measure organs that are not visible. More photographs improve coverage and expose disagreement, but do not by themselves resolve unknown illumination or camera processing.

## Evidence and practical alternatives

| Primary work | Relevant result | Consequence for this feature |
| --- | --- | --- |
| [Cheng, Color Performance Review, 2023](https://library.imaging.org/jist/articles/67/5/050406) | Endoscopes can intentionally transform colour. Evaluating inter-patch contrast and lightness/hue/chroma ordering is distinct from absolute colour fidelity. The paper describes measured targets and acquisition conditions. | A JPEG's tissue RGB is observed display appearance. Preserve tissue distinctions and use colour targets when claiming calibration. A pleasing screenshot is insufficient evidence of fidelity. |
| [Baumann et al., Neural illumination calibration, 2025](https://inrepo02.dkfz.de/record/305208/files/s11548-025-03525-8.pdf) | Spatial white-reference prediction is evaluated with 1,890 hyperspectral cubes. Real white references plus simulated lighting train the model; changing surgical lighting materially affects downstream analysis. | Strong support for explicit illumination calibration. This HSI model is not a drop-in calibrator for arbitrary three-channel uploads, and global white balance does not capture spatially varying light. |
| [Imtiaz and Iakovidis, Cross-dataset harmonization, preprint submitted 2026-10-05](https://arxiv.org/abs/2610.06663) | Global CIELab statistics from a reference dataset drive channel-wise image harmonization; the authors report improved cross-dataset polyp detection. | Very current and simple, but the endpoint is classifier generalization, not organ-specific material recovery. Do not interpret dataset matching as measured tissue albedo or transplant it blindly to a multi-organ body. |
| [PR-ENDO, MICCAI 2025](https://sanoscience.github.io/PR-ENDO/), [paper and author feedback](https://papers.miccai.org/miccai-2025/0714-Paper1025.html) | Physically based Gaussian reconstruction learns material and co-located lighting properties from endoscopic scenes. Authors explicitly describe dependence on depth regularization, SLAM initialization and trainable lighting. Relighting lacks ground-truth variations in C3VD. | Useful future route for a tracked sequence of the same scene. It requires substantially more structure than a few unrelated photographs and does not supply correspondence to our whole-body atlas. Code exists; it is not integrated or licence-audited here. |
| [EndoPBR, WACV 2026](https://openaccess.thecvf.com/content/WACV2026/html/Han_EndoPBR_Photorealistic_Synthetic_Data_for_Surgical_3D_Vision_via_Physically-based_WACV_2026_paper.html) | Surgical inverse rendering models a camera-attached light while using scene geometry and camera poses. | Better matched to surgical light transport than generic object material generation, but requires known scene information absent from arbitrary uploads. See the earlier research note for details. |
| [Xeno-learning, Nature Biomedical Engineering 2026](https://www.nature.com/articles/s41551-025-01585-4) | In 14,013 hyperspectral images from humans, pigs and rats, absolute organ spectral signatures differ across species. Relative physiological changes can be more transferable. Acquisition includes white/dark calibration. | Porcine ex vivo RGB can demonstrate a working tool, not establish human optical ground truth. Our relative palette offsets are an authoring heuristic, not an implementation or validation of physiological xeno-learning. |
| [Burggraaff et al., camera calibration, Optics Express 2019](https://arxiv.org/abs/1906.04155) | Seven tested cameras show device-specific responses; RAW is much more linear than JPEG. The calibration protocol includes flat-field and spectral response. | Camera/session metadata and controlled captures are necessary for quantitative multi-image colour measurement. ICC conversion alone does not recover illumination or undo arbitrary camera rendering. |
| [Ottosson, Oklab](https://bottosson.github.io/posts/oklab/) | An explicitly defined perceptual colour space with public-domain/MIT reference code. | Small dependency-free transforms, separate lightness/chroma handling, and deterministic gamut compression fit the interactive renderer. Oklab distance here is not CIEDE2000 or a clinical tolerance. |

The generic intrinsic/material methods compared in the earlier note can invent plausible unseen details. That is useful for artistic asset completion but cannot establish the true colour of an unseen spleen, for example. Texture synthesis is therefore outside this transfer's evidentiary claims.

## Implemented planner

Code: [wholeBodyColor.ts](../../apps/studio/src/wholeBodyColor.ts), [tests](../../apps/studio/src/wholeBodyColor.test.ts). It is synchronous, deterministic, and operates on analysis results rather than source pixels. [wholeSceneBaselineColor](../../apps/studio/src/wholeSceneMaterials.ts) shares the renderer's actual authored sRGB profile instead of maintaining a second palette.

1. Accept only reviewed rows with an explicit canonical organ, exact scene targets, matching image/mask hashes, valid colours and consistent accepted-pixel counts. Skeleton targets and mismatched organs are rejected. Unreviewed rows have no effect.
2. Deduplicate each target's identical source-image/mask pair using content hashes, independent of uploaded filename. Conflicting copies are rejected. Review preserves the distinction between outer surface, mucosa, cut surface and unknown.
3. Weight each observation with `accepted_fraction * sqrt(min(accepted_pixels,4096)/4096) / (1 + hypot(spread_a,spread_b)/0.05)`. Spread is the extractor's 10th–90th percentile Oklab spread when available. These fixed constants are heuristic authoring choices, not calibrated probabilities; no example-specific tuning is used.
4. Compute componentwise weighted Oklab medians within each source image, then within an optional declared `capture_group`, then across groups. Each image or capture group receives at most the weight of its strongest child. Thirty masks from one photograph, or twenty photographs from one declared surgery, cannot become thirty or twenty independent votes. A missing group falls back to the source-image hash, preserving upload behaviour. Exact duplicates remain deduplicated by image and mask hashes; conflicting group assignments for one image are rejected. A declared group on one row also covers other rows using that same image. Unlabelled near-duplicate video frames still need deliberate source selection: hashes cannot infer acquisition independence or patient identity.
5. Record weighted between-image RMS Oklab disagreement and warn above 0.06. Capture weights cap the contribution, while disagreement among frames inside one capture remains visible. The threshold triggers review, not a diagnosis or confidence score. With one image there is no between-image disagreement estimate; zero does not imply accurate material recovery.
6. Apply the direct pooled colour with configurable strength, default 0.65, and default chroma-only mode. Full-colour mode changes lightness too. Strength zero preserves the baseline exactly.
7. If enabled, infer a related target by pooling **differences from each observed source organ's own authored baseline** and adding that difference to the target's own baseline. Limit chroma displacement to 0.035 Oklab units and preserve target lightness. Only reviewed `outer` observations are eligible. This does not copy one organ's absolute colour onto another.
8. If enabled, harmonize remaining soft structures using the corresponding robust outer-surface residual, capped at 0.020 chroma units. This option is weaker than family borrowing and is always labelled inferred. Bones remain excluded. Unknown/internal surface references do not drive inference.
9. Keep gamut conversion deterministic using chroma compression at fixed lightness. Feed only colour carriers to the material layer: geometry, deformation, authored grain, roughness, clearcoat and physical parameters are not estimated from the photographs.

Each of the 36 soft structures has an assignment: `direct`, `related`, `harmonized` or `authored`. Provenance keeps every counted region's original observed colour, palette, quality, surface, target, source/mask hashes and normalized weight, plus source targets and warnings. Optional `capture_group`, `identity_source` and `source_url` preserve acquisition dependencies and annotation/source attribution; these labels are supplied provenance, not independent verification. Related/global pooling reuses original quality before applying the hierarchy, avoiding a second penalty to already normalized groups. The legacy renderer carrier has only one pair of hashes; these identify a representative input, **not the identity of a pooled measurement**. Export the complete versioned plan with the carriers. Palette swatches in evidence are retained observations, not newly synthesized spatial texture.

## Coverage and authored family choices

The current manifest contains 39 structures: 36 soft and three bones. All soft targets can receive explicit direct observations. Family relationships are limited to the following optional groups; these are authoring choices, not claims of identical tissue colour.

| Group | Exact scene targets |
| --- | --- |
| Renal outer surface | left-kidney, right-kidney |
| Pulmonary outer surface | left-lung, right-lung |
| Intestinal serosa | small-intestine, duodenum, colon |
| Ureteral wall | left-ureter, right-ureter |
| Biliary duct wall | cystic-duct, hepatic-duct |
| Airway cartilage | trachea, bronchi |
| Arterial adventitia | aorta, hepatic-artery, superior-mesenteric-artery, inferior-mesenteric-artery, right-renal-artery, left-renal-artery, splenic-artery, celiac-trunk |
| Venous wall | vena-cava, portal-vein, right-renal-vein, left-renal-vein |
| No family borrowing | liver, gallbladder, stomach, pancreas, spleen, heart, diaphragm, esophagus, urinary-bladder, mesentery, pancreatic-duct |
| Excluded from reference transfer | rib-cage, spine, pelvis |

Mucosal colour from colonoscopy is not automatically an intestinal serosal material. Blood over a surface, exposed fat, cauterization, perfusion changes and stripped capsules also change what a region represents. Region review is therefore part of the model input, not optional cosmetic cleanup. The current surface labels are coarse and do not classify these conditions automatically.

## Validation and remaining limits

The focused planner suite has 19 passing tests, including all 36 direct mappings, no-review behaviour, robust outlier pooling, content deduplication, 30 correlated masks, quality weighting, source disagreement, exact zero strength, fixed-lightness transfer, bounded related inference and a deliberately saturated red source that cannot flatten the missing-organ palette. Twenty distinct image hashes in one capture cannot outvote two independent captures; their total weight stays one third for both direct and harmonized assignments. Other tests cover upload fallback parity, disagreement within a capture, contradictory grouping, optional provenance validation and JSON replay. The full frontend suite passed 211 tests; studio TypeScript checking and the production build pass after the concurrent instrument interface landed. Final browser and visual evidence is linked from [whole-body usage and acceptance](../WHOLE_BODY_COLOUR.md).

Reproduce from `viscera/`:

```sh
node node_modules/vitest/vitest.mjs run apps/studio/src/wholeBodyColor.test.ts
node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json
```

The earlier [48-case extraction benchmark](../../benchmarks/results/reference-material-2026-10-08/benchmark.json) establishes synthetic contaminant robustness under its declared conditions. DRENDS is a real surgical-image smoke test with a reviewed proposal, not real segmentation/albedo ground truth. Whole-body planner tests establish invariants and source handling; they do not establish expert surgical realism or hidden-organ accuracy. Frontend screenshot and multi-organ dataset evidence are separate integration checks, not substituted for these claims.

For a quantitatively stronger next stage, collect multiple exterior views per organ with fixed camera settings and known acquisition sessions, measured colour/neutral targets under the actual illumination, and documented species/surface state. Fit and evaluate session-specific colour correction on held-out target patches; check hue/lightness ordering as well as absolute error. Keep patient/session splits when evaluating organ colour consistency. A clinical colour-fidelity claim additionally needs appropriately qualified annotation and independent review. For tracked same-scene video with useful depth, evaluate a surgical inverse-rendering model against held-out views and controlled relighting before using estimated optical maps. These are future validation requirements, not capabilities claimed by the present RGB transfer.
