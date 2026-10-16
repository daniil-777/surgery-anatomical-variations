# Ground truth for a joint anatomy, colour and disease VAE

Research and local source audit: 7 October 2026.

The available data supports a useful, controllable **synthetic joint model**. It does not yet support claiming a learned distribution of realistic diseased human shape and colour. I did not verify an openly reusable dataset spanning all requested organs with paired whole-organ meshes, photographed surface colour, disease annotations and independent human specimens. Increasing synthetic sample count does not close that evidence gap.

## What the current project actually measures

The existing dataset cards and retained attributions were inspected directly. `datasets/atlas/cohort-v2` contains 24 authored display templates across 12 organ groups, derived from HRA and BodyParts3D; these are not 24 independent patients. `datasets/atlas/material-v1` has 768 authored appearance samples, no optical measurements. The disease recipe release contains authored visual controls, and the clinical CC BY release contains three pancreatic tumor cases, one per split. Its CT masks provide organ and lesion geometry, no wet surface photographs. Existing 36 pathology references and 13 external viewers are review references, not paired mesh/colour training labels.

Keep exact source licenses and attributions with every derivative. Existing project documentation provides the detailed lineage: [final data audit](FINAL_DATA_AUDIT.md), [clinical data contract](DISEASE_SOURCE_DATASET.md), [atlas geometry audit](ATLAS_GEOMETRY_SOURCE_REVIEW_2026-10-06.md).

## Verified external candidates

| Source | Actual observations | Verified reuse evidence | Use and limitation |
|---|---|---|---|
| [DRENDS v1](https://zenodo.org/records/17598453), [authors' project](https://l0za007.github.io/DRENDS/) | Stereo RGB, ToF point clouds, calibration, capture timestamps; manipulated ex-vivo porcine tissues and human-shaped phantoms | Zenodo API and retained HDF5/README say CC BY 4.0; processing code MIT | New measured partial geometry/appearance benchmark. Porcine colon/intestine/stomach/pancreas; no ex-vivo liver or disease annotations. RGB contains illumination, tools and background; it is not diffuse albedo. |
| [TotalSegmentator v2.0.0](https://zenodo.org/records/8367088) | 1,228 CT images with 117 structure masks | Exact version API says CC BY 4.0; pinned metadata retained | Strong shape-only expansion candidate; broad clinical cases, not a per-organ disease taxonomy or photographic colour source. 23.6 GB archive not downloaded. Newer versions exist; this audit pins this exact release. |
| [Pancreatic CT segmentations](https://zenodo.org/records/5510650) | Paired pancreas and tumor masks | Exact Zenodo API says CC BY 4.0 | Already ingested three cases; no new independent cases are created by resampling. No appearance or mechanics observations. |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) | Human cryosection colour plus CT/MRI from one male and one female cadaver | NLM describes a public-domain library; no access license required since 2019; retain NLM acknowledgement/terms | Useful internal anatomical colour reference. Frozen cut surfaces are not living, wet external-organ reflectance. Two donors do not establish a disease population. Not downloaded here. |
| [Human Organ Atlas](https://human-organ-atlas.esrf.fr/), [source publication](https://pmc.ncbi.nlm.nih.gov/articles/PMC12978218/) | Ex-vivo hierarchical phase-contrast tomography, donor and acquisition metadata | Portal advertises dataset-specific DOI and CC BY 4.0 | Excellent internal structure candidate; X-ray intensity is not RGB, albedo or roughness. Review each donor and segment structures before use. Not downloaded here. |
| [Medical Segmentation Decathlon](https://medicaldecathlon.com/), [authors' publication](https://doi.org/10.1038/s41467-022-30695-9) | CT/MR organ and tumor masks in ten tasks | Dataset CC BY-SA 4.0; article CC BY 4.0 is a different license | Valuable disease geometry expansion; keep separate share-alike lane. No photographed surfaces; tumor masks do not imply histological subtype. Not downloaded or mixed into the current attribution-only release. |
| [BraDiPho download](https://bradipho.eu/6-download.html) | Textured brain dissection models registered to radiology | Authors specify CC BY-NC-SA 4.0 | A real textured anatomical reference, outside adult abdominal scope and incompatible with treating the default release as unrestricted commercial data. Not downloaded. |
| [3D Path Labs](https://www.3dpathlabs.com/about) | Detailed educational pathology illustrations | Site states copyright and prohibits commercial reproduction | Visual review only; authors describe sculpted/stylized constructions, not unaltered specimen digitizations. No automatic asset extraction or training use. |

This is a targeted source review, not a claim that no other usable dataset exists. A paper being open access, a model appearing in a browser, and a downloadable mesh having explicit redistribution/training rights are separate facts.

## Acquired DRENDS pilot and careful ingestion

`artifacts/ground-truth/drends-pilot/` contains the original five members of `Seq01_Colon_Med`, source calibration, workspace mask, source README, and provenance. One capture sequence is one group; its frames cannot become independent train/validation patients. All selected ZIP member CRCs were checked, and retained members have SHA-256 hashes. The full 3.8 GB archive was not downloaded or hashed; the manifest distinguishes its publisher MD5 from verified member checksums.

Direct inspection found material ingestion hazards:

- HDF5 `xyz` is `(50, 480, 640, 3)` float16. Its file and dataset attributes specify **millimetres**. The source README's metre claim conflicts with these attributes; the pinned official processing code also divides raw coordinates by 1,000. Raw values are preserved and derived metre arrays are explicitly named.
- Each video decodes to 51 frames. Frame 50 is an exact duplicate of frame 49 in left, right and intensity videos; the source code documents duplicate-tail handling. Derived data retains the 50 capture identities matching HDF5 and CSV.
- Recorded capture intervals are 0.97–94.21 seconds over 505.65 seconds. The video is encoded at 10 fps; playback time is not physical capture time. Maximum stereo-to-ToF timestamp difference is 66.46 ms. Do not fit motion speeds or tissue viscosity from the encoded frame rate.
- Native clouds cover tissue, instruments and background, with outliers. The retained workspace mask is a acquisition-region mask, not a tissue segmentation. No tissue or tool masks, forces, disease classes, albedo or material properties are invented.

The six-frame `review/` set preserves RGB and XYZ with capture timestamps. It includes a contact sheet, native depth diagnostics and **candidate** projection arrays following upstream calibration/compensation conventions. Their metric registration and visibility have not been validated. They are not promoted to texture-ground-truth labels. Sensor-valid and in-view masks describe numerical/field-of-view gates only. The source author's research-purpose accuracy warning remains in the unmodified README.

[Open the contact sheet](../artifacts/ground-truth/drends-pilot/review/contact-sheet.png). [Machine-readable frame QA](../artifacts/ground-truth/drends-pilot/review/review-qa.json). [Source inventory](../artifacts/ground-truth/source-inventory.json).

## Consequences for training and evaluation

1. **Keep three supervision lanes.** Authored joint shape/colour/disease examples can train the current VAE; measured CT organ/lesion geometry can supervise a geometry-only branch; paired optical/depth observations can support a separate appearance/reconstruction benchmark after registration and segmentation review. Do not fill unobserved modalities with “ground truth” from another donor.
2. **Mask missing evidence.** Carry source/case identity, species, acquisition domain, units, observation masks and licenses per record. Apply geometry, colour and disease losses only where their target has a justified meaning. Missing disease metadata is unknown, not healthy. Photographic RGB is observation under illumination, not calibrated albedo.
3. **Split before augmentation.** Views, shape deformations, textures, lesions and captions inherit parent specimen/source groups. Leave entire sources out when claiming source generalization. Current atlas-template sharing permits generator evaluation, not independent-patient validation.
4. **Evaluate what is observable.** Joint control reconstruction, mesh validity, bounded variation, conditional disease separation, same-seed replay and inter-seed diversity are engineering gates. Use paired geometry errors only in common physical coordinates; image comparisons need matched views and lighting. Surface colour distance alone cannot establish disease or realism.
5. **Acquire actual paired disease specimens for the next scientific claim.** Collect registered multiview RGB or scans of whole specimens with disease diagnosis, scales, acquisition state, capture calibration and independent expert annotations. Record illumination separately; photograph fresh and preserved specimens as different domains. CT disease geometry, pathology photographs and synthetic textures should not be silently combined as if they belonged to the same specimen.

## Reproduce the supplementary review

From the VISCERA project root, in an isolated Python 3.12 environment (the retained dependency versions match the review run):

```sh
python -m venv /tmp/viscera-groundtruth-review
/tmp/viscera-groundtruth-review/bin/pip install -r artifacts/ground-truth/review-requirements.txt
/tmp/viscera-groundtruth-review/bin/python artifacts/ground-truth/fetch_drends_pilot.py
/tmp/viscera-groundtruth-review/bin/python artifacts/ground-truth/build_drends_review.py
```

The fetcher requests exact HTTP ranges and fails if a server ignores them. It checks each original member length and CRC before writing. Existing retained files are verified rather than silently replaced. Review dependencies are separate from the Colab VAE environment. The machine-readable inventory marks this supplemental human-disease training eligibility as false.
