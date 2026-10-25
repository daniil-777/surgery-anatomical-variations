# Operative surface appearance — 25 October 2026

The scene now separates intact tissue, a statistically synthesized residue field,
thickness-dependent blood transport, and the wet optical interface. The film is
attached to rest coordinates, including the existing blended anatomical joins.
`Operative residue` changes appearance without changing geometry or restarting
the physics solver. Zero gives the clean field; white geometry omits the layer.

## Dataset investigation and actual fitting

Downloaded and visually inspected 20 additional DSAD RGB frames and their mask
previews, plus two three-second GynSurg bleeding clips. The latter are local
research references only and are excluded from the model and published assets.
The official DSAD viewer supplies JPEG renditions, including the mask previews;
these were not treated as original lossless images or exact segmentation masks.
See the [dataset audit](operative-appearance/datasets.md) and the local acquisition
manifests archived with the review evidence.

Reviewed ten instrument-free, overlay-free tissue regions. Six fit regions come
from surgeries 04, 22, 28 and 29; four held-out regions come from 10, 23 and 31.
These are assistant visual labels, not expert blood annotations. The deployed
red-film component uses one fitting region and is compared with one held-out film
region. Other tissue classes were analyzed but are not claimed as new trained
scene models.

The executed fit learns six bands of local log-red chromaticity and a 257-quantile
distribution. Nonnegative least squares sets the band variances; empirical
quantile transport produces a new periodic random layout. No source pixel layout,
instrument, text or photographed highlight is pasted onto a mesh. Green and blue
descriptor channels are explicitly authored auxiliary fields. This is **statistical
texture learning, not a newly trained neural model or recovered tissue BRDF**.

The frozen seed-42 texture matches the fitting marginal with W1 0.00137 and band
fractions with L1 0.0999. Against the held-out film, its band-fraction L1 is 0.397,
compared with 0.813 for equal-band synthesis using the same marginal. Directional
error remains substantial (anisotropy error 0.382). These small-sample statistics
do not establish photorealism. The 80th-percentile threshold is a chosen level of
red residual, **not measured blood coverage**. All seven reproducibility checks
passed. [Fit report](operative-appearance/fit-report.json),
[verification](operative-appearance/fit-verification.json),
[model](operative-appearance/model.json),
[reproduction instructions](operative-appearance/fitting.md).

## Optical implementation

The existing Bosschaart-derived blood lookup supplies linear-RGB reflectance R
and transmittance T. The film over substrate s is composed as
`R + T*T*s / (1 - R*s)` before lighting. Empty film is exactly the original
substrate. A shared 512×2 float texture uses explicit interpolation; no per-frame
texture regeneration is required. The oxygenation assumption is 0.75. Thickness,
physical mapping and anatomical placement are authored, not inferred from RGB.
[Blood source](https://pmc.ncbi.nlm.nih.gov/articles/PMC3953607/),
[correction](https://pmc.ncbi.nlm.nih.gov/articles/PMC9172854/).

Wet coverage smooths the specular normal without erasing the diffuse substrate;
film-thickness gradients contribute to the wet normal. The water-air Fresnel
term is 0.02037. The buried water-tissue normal-incidence term approaches
0.0001874 as coverage increases, instead of retaining two strong air interfaces.
This is an approximate layered RGB BRDF with assumed indices, not calibrated
spectral rendering of a surgical camera.

The operative layer is composed after the full neighboring material blend.
Its support value is itself blended at registered joins. It follows deformation
and disease/seed changes in rest coordinates, but does not simulate flow, mass
conservation, clotting, or an incision. Compact operative regions leave most
intact capsule and bowel clean. A full conservative surface-flow implementation
already exists in the separate blood lab; that solver was not silently represented
as integrated into the whole scene. [Methods and code audit](operative-appearance/methods.md).

## Iterations and remaining limits

The first render scattered fine marks too widely. The second confined support to
the operative bed and apron, enlarged and elongated the film field, and separated
wet normal response. The third increased the thin-film contribution and warmed
fat pigmentation. Retained captures show these decisions, including failed checks.
Each appearance pass includes clean, default and maximum residue from three angles.

The scene still has simplified reconstructed organ geometry and inferred hidden
surfaces. The new layer is a bounded improvement, not a claim to match real surgery
or to have passed a surgeon review. Real BRDF learning would require additional
posed/depth-calibrated observations and controlled illumination; unposed RGB
patch statistics cannot identify those quantities.

## Release checks

Studio TypeScript checking and all 110 focused tests passed. Nine browser tests
passed, including image integrity failure, clean/white modes, repeatable seeds,
4096-pixel export, three interior entries and the material-only control path.
The final review records 43 disease/deformation cases plus nine residue ablations
without shader errors. Three appearance iterations and earlier failed checks are
retained in local artifacts.

Two isolated Chrome/Metal measurements at 1600×1100, device pixel ratio 1, held
approximately 60 FPS during breathing, held grasp and recovery. The repeat run's
p95 animation interval was 16.7–16.8 ms, with zero dropped physics time. This is
one machine and viewport, not a cross-device performance guarantee.

## Attribution and source rights

DSAD: Carstens, Rinner, Bodenstedt, Jenke, Weitz, Distler, Speidel and Kolbinger,
*Scientific Data* 10, 3 (2023), [DOI](https://doi.org/10.1038/s41597-022-01719-2).
The [official publisher mirror](https://huggingface.co/datasets/nct-tso/dsad) and
[original Figshare metadata](https://api.figshare.com/v2/articles/21702600) identify
CC BY 4.0; the paper also contains conflicting non-commercial prose. That
discrepancy is preserved in the deployed manifest; commercial legal clearance is
not asserted. The released field contains aggregate statistical synthesis, with
source attribution and modifications recorded. GynSurg, CholecSeg8k and SurgBlood
images or derivatives were not added to the deployment.

The spectral LUT retains the existing Bosschaart/CIE attribution and CC BY-SA 4.0
derived-data notice in `blood-optics-attribution.json`.
