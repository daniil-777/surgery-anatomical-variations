# VISCERA v2: measured source evidence and its actual use

Verified 7 October 2026. This evidence release contains **40 visual assets, 20 newly acquired CT segmentation cases, and three previously acquired pancreatic cancer cases**. Fourteen explicit tissue ROIs were measured on 12 photographs. Eleven of those photographs map to supported v2 profiles; the gallbladder-stone mucosal ROI remains reference only. The renderer blends the selected photographic ROI colours into eleven authored profile palettes, which contribute to the dataset's rendered colour targets.

The CT cases document measured physical scale and lesion burden for review. **They are not consumed by this release's sampler, geometry targets or deformation bounds.** The sources do **not** form a paired human shape–colour–disease dataset. Every photo/mesh correspondence is absent; every acquired clinical severity label is unknown. Generated joint targets remain synthetic renderer observations. The implemented source use is recorded in `artifacts/joint-v2/evidence_usage_receipt.json` and the evidence ZIP's `post-freeze/` directory.

## Included material

| Lane | Actual material | Rights | Permitted use in this release |
|---|---|---|---|
| Gross / diagnostic references | 40 assets across 12 organ groups; 33 gross specimen photographs, seven contextual images | Exact per-file CC0, public-domain, CC BY or CC BY-SA metadata retained | Review all; only visually checked attribution/public-domain tissue ROIs inform authored palette design |
| New measured geometry | Six liver, six pancreas, four lung-tumour and four colon-tumour label volumes | CC BY-SA 4.0 | Separate share-alike source/mesh reference; not consumed by this training release |
| Prior measured geometry | Three aligned pancreas/PDA cases, source masks and meshes | CC BY 4.0 | Physical reference, retaining original patient group and train/validation/audit split |
| Measured shape + photographed colour pairs | **0** | — | No cross-modal supervision is asserted |
| Clinical stage, tissue albedo, roughness or mechanics measurements | **0** | — | No measured loss targets are created |

The [official Medical Segmentation Decathlon registry](https://registry.opendata.aws/msd/) identifies the license and author-controlled AWS distribution. Task `dataset.json` files and the official `license.txt` accompany all retained labels. The [primary benchmark paper](https://doi.org/10.1038/s41467-022-30695-9) describes the source tasks. Pancreas class two is retained as a mass/cancer segmentation label with unspecified subtype; it is not relabeled as confirmed PDA, pseudocyst or severity. Lung and colon cases contain tumour masks only, so an organ-relative volume fraction is unavailable.

Prior pancreatic sources come from [Suman et al., Zenodo 5510650](https://zenodo.org/records/5510650). Their source case identity, mask hashes, physical transforms, attribution and original split remain in `prior_clinical_manifest.json`. The separate photographs have no patient linkage to these cases.

## Shape evidence

Every NIfTI was fully decoded, its SHA256 checked, and its header millimetre unit verified. Surface extraction uses a padded tight crop, marching cubes at 0.5 and the full voxel-to-RAS affine. No smoothing, mesh decimation or connected-component removal changes the retained surfaces. PLY coordinates remain RAS millimetres. The gallery GLBs preserve topology and use a documented centered transformation to metres.

| Source subset | Cases | Aggregate lesion volume, mL | Lesion / organ-envelope fraction |
|---|---:|---:|---:|
| large-intestine | 4 | 7.095–203.902 | unavailable: tumour mask only |
| liver | 6 | 0.521–12.913 | 0.000599–0.006797 |
| lung | 4 | 0.832–370.384 | unavailable: tumour mask only |
| pancreas | 6 | 3.472–14.122 | 0.049244–0.134432 |

These are the first requested ordinary label members in the official TAR order: a **small convenience subset**, not a population sample. Liver aggregate lesions can have several connected components. Aggregate tumour volume is therefore not a single focal radius. These measurements could support a future, separately validated control calibration; this release does not apply them to its design bounds. They cannot directly set external displacement, predict histology or establish clinical stage. Native slice spacing reaches 5 mm in several cases. Smooth high-frequency capsular detail is not measured by these masks.

`review/geometry-gallery.html` offers 20 actual downloadable GLB cases. `review/geometry-contact-01.jpg` through `05.jpg` show three orthographic surface-vertex projections per case. Cyan and coral are diagnostic display colours. The lesion is deliberately visible through the organ in projections / transparent gallery meshes; this is not an operative external view. Projection striping exposes anisotropic sampling rather than fabricating intermediate measurement detail.

## Photo curation and observed colour

All 36 prior report images were reused only after their retained SHA256 matched the old catalog. Four additional originals were acquired from Commons and checked against the API SHA1. Current source metadata, author, license, original description, URLs and exact retained-file SHA256 are retained. Where the prior gallery stored a thumbnail, its own retained-byte hash is used; an original-file SHA1 is never claimed to verify thumbnail bytes.

Visual inspection corrected misleading titles: `Fatty liver.jpg` is histology, the Wellcome cirrhosis asset is a monochrome illustration, and the new asset initially named `liver-cirrhosis-external` is a preserved **cut specimen in a jar**. None contributes an external palette target. CT, angiographic renders and isolated stones also remain contextual references. The micronodular cirrhosis photo is a true external capsular reference, but retains its CC BY-SA review lane.

Each ROI is a manually placed polygon inside visible tissue. Masks, normalized coordinates, source hash, untrimmed RGB quantiles and a separately reported white-highlight-trimmed median are reproducible. These are **stored RGB observations**, affected by illumination, camera processing, fixation, blood and view. They are not calibrated albedo or a measured shader material. No clinician has adjudicated these masks. Patient age is not uniformly verified, so the reference images do not establish an adult-only clinical cohort.

| ROI reference | Observed stored RGB median (0–255) | Compartment / use |
|---|---|---|
| liver-cirrhosis--tan_cut_parenchyma | 187, 111, 63 | cut opened or mucosal |
| liver-metastases--pale_cut_deposit | 201, 158, 111 | cut opened or mucosal |
| liver-metastases--red_cut_parenchyma | 138, 53, 32 | cut opened or mucosal |
| stomach-gist--pale_cut_mass | 215, 153, 101 | cut opened or mucosal |
| spleen-infarct--red_cut_parenchyma | 139, 47, 44 | cut opened or mucosal |
| spleen-infarct--pale_cut_scar | 197, 169, 143 | cut opened or mucosal |
| kidney-polycystic--mixed_external_cyst_surface | 117, 91, 82 | external or surgically exposed |
| colon-diverticulosis--pink_opened_mucosa | 156, 109, 84 | cut opened or mucosal |
| heart-infarction--dark_red_cut_myocardium | 99, 40, 31 | cut opened or mucosal |
| lung-emphysema--mixed_cut_parenchyma | 100, 68, 74 | cut opened or mucosal |
| gallbladder-stones--dark_opened_mucosa | 43, 37, 20 | cut opened or mucosal |
| gallbladder-carcinoma--pale_mucosal_nodule | 209, 178, 95 | cut opened or mucosal |
| kidney-cancer--orange_pale_cut_mass | 243, 166, 115 | cut opened or mucosal |
| brain-meningioma--red_dural_attached_nodule | 205, 84, 77 | external or surgically exposed |

The external polycystic kidney patch directly informs the appearance family for the corresponding external surface design. Most other ROIs are cut or mucosal surfaces; transferring their relative contrast to an external model is an **authored surface proxy**, recorded per mapping. The meningioma patch is an exposed dural-attached nodule, not cortex. The fixed HCC specimen is not used for ROI calibration: its original source explicitly reports formalin fixation and alcohol immersion. A pale lesion against a darker surrounding patch can guide relative rendering contrast without treating either patch as calibrated native tissue colour.

`profile_evidence_guidance.json` maps each accepted ROI to exact v2 profile IDs and contains the observations consumed by profile authoring. The frozen acquisition `source_manifest.json` retains intended `usage_status` values including `training_shape_guidance`; those values are not proof of implemented training use. The post-freeze actual-use receipt explicitly supersedes that intended role for the CT sources, retaining their original evidence hashes.

## License exclusion that affects source selection

[CirrMRI600+](https://osf.io/cuk24/) is promising because the [primary publication](https://doi.org/10.1038/s41597-025-05201-7) describes cirrhotic liver MRI with stage information. However, the **current authoritative OSF dataset LICENSE.txt is CC BY-NC 4.0**. The OSF API points to an “Other” license directing readers to that file. Older paper text mentioning BY-SA and the repository's MIT code license do not override the dataset file. The release retains metadata and license evidence only, and excludes those scans from unrestricted product training. This prevents an incorrect open-data claim while leaving a documented future noncommercial research option.

## Review and reproducibility

All four photo contact sheets, three ROI overlay sheets and five geometry contact sheets were visually inspected. Automated checks independently recompute ROI medians/counts and file hashes, verify finite closed mesh topology, decode gallery GLBs and reject invented cross-modal / clinical-stage supervision. See `evidence_verification.json` for actual check results.

The acquisition and derivation scripts are included. `acquire_msd_masks.py` reads exact HTTP ranges from uncompressed official TAR archives and verifies TAR header checksums, response ranges and stable ETag/version identity. Each retained member records its original archive byte range and SHA256. The entire multi-gigabyte TAR is not downloaded or claimed to have a verified full-file SHA256. `acquire_photos.py` reuses known hashes and records Commons metadata. Network rate limits are respected; an unnecessary additional fatty-liver candidate was not acquired after rate limiting.

The v1 DRENDS porcine RGB/XYZ specimen lane remains separately documented in `JOINT_VAE_GROUND_TRUTH.md`; it is not relabeled as human disease evidence or counted in the numbers above. No mechanical parameter target was inferred from still photographs or CT.

## Per-file attribution and review role

The following table is a navigation aid. The machine-readable manifest retains the complete source creator text and description.

| Asset | License | Modality | Use | Original source |
|---|---|---|---|---|
| liver-cirrhosis | CC0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Gross_pathology_of_alcoholic_liver_cirrhosis.jpg) |
| liver-hcc | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Hepatocellular_carcinoma_1.jpg) |
| liver-metastases | Public domain | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Secondary_tumor_deposits_in_the_liver_from_a_primary_cancer_of_the_pancreas.jpg) |
| gallbladder-stones | CC0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Gross_pathology_of_a_trabeculated_gallbladder.jpg) |
| gallbladder-cholecystitis | CC BY-SA 3.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Chronic_calculous_cholecystitis.jpg) |
| gallbladder-carcinoma | CC BY 4.0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Gross_pathology_of_gallbladder_carcinoma.jpg) |
| stomach-adenocarcinoma | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Adenocarcinoma_of_the_stomach.jpg) |
| stomach-ulcer | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Benign_gastric_ulcer_1.jpg) |
| stomach-gist | Public domain | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Gastrointestinal_Stromal_Tumor_(GIST)_of_Stomach.jpg) |
| pancreas-cancer | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Macroscopic_image_of_pancreas_adenocarcinoma_removed_by_Whipple_procedure.jpg) |
| pancreas-pancreatitis | CC BY-SA 4.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Pancr%C3%A9as_Pancr%C3%A9atite_55-o.apatho-650t-pancreas.jpg) |
| pancreas-pseudocyst | CC BY-SA 4.0 | CT | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Large_Pancreatic_Pseudocyst.PNG) |
| spleen-infarct | CC0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Healed_splenic_infarcts.jpg) |
| spleen-rupture | CC BY-SA 3.0 de | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Milzruptur_THWZ.JPG) |
| spleen-cyst | CC BY-SA 4.0 | CT | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Pseudozyste_der_Milz_mit_Randverkalkungen_83W_-_CT_KM_pv_-_001.jpg) |
| small-intestine-crohn | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Crohn_Jejunum.PNG) |
| small-intestine-net | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Multiple_Carcinoid_Tumors_of_the_Small_Bowel_2.jpg) |
| small-intestine-obstruction | CC BY-SA 3.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Intestinal_Obstruction.JPG) |
| colon-cancer | CC BY 2.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Adenocarcinoma_of_the_Sigmoid_Colon_(longitudinal_section).jpg) |
| colon-ulcerative-colitis-detail | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Chronic_Ulcerative_Colitis_1.jpg) |
| colon-diverticulosis | CC0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Gross_pathology_of_diverticulosis.jpg) |
| kidney-cancer | CC BY 3.0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Kidney_cancer.jpg) |
| kidney-polycystic | CC0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Polycystic_kidney.jpg) |
| kidney-hydronephrosis | CC BY-SA 3.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Hydronephrosis_of_kidney_with_Calculi.JPG) |
| bladder-cancer | CC BY-SA 3.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Carcinoma_of_the_urinary_bladder.jpg) |
| bladder-stones | CC BY-SA 4.0 | stone_photo_no_organ | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Urinary_Bladder_stones.jpg) |
| bladder-diverticulum | CC BY-SA 3.0 | CT | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Bladderdiverticulum.png) |
| heart-infarction | CC0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Gross_pathology_of_old_myocardial_infarction.jpg) |
| heart-aortic-stenosis | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Aortic_stenosis_rheumatic,_gross_pathology_20G0014_lores.jpg) |
| heart-endocarditis | Public domain | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Haemophilus_parainfluenzae_Endocarditis_PHIL_851_lores.jpg) |
| lung-cancer | CC BY 3.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Lung_cancer.jpg) |
| lung-emphysema | Public domain | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Centrilobular_emphysema_865_lores.jpg) |
| lung-bronchiectasis | CC BY-SA 2.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Bronchiectasis_.jpg) |
| brain-meningioma | CC0 | gross_specimen_photo | unpaired_palette_guidance | [Source](https://commons.wikimedia.org/wiki/File:Meningioma_seen_at_autopsy.jpg) |
| brain-glioblastoma | CC BY-SA 4.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Glioblastoma_macro.jpg) |
| brain-aneurysm | CC BY-SA 3.0 | angiographic_3d_render | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Cerebral_aneurysm.png) |
| liver-cirrhosis-external | CC BY-SA 3.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Cirrhosis_of_liver.jpg) |
| liver-cirrhosis-wellcome | CC BY 4.0 | historical_illustration | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Cirrhosis_of_the_liver_Wellcome_L0061301.jpg) |
| liver-micronodular | CC BY-SA 4.0 | gross_specimen_photo | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Cirrosi_micronodular.1427.jpg) |
| liver-steatosis | CC BY-SA 4.0 | histology | reference_only | [Source](https://commons.wikimedia.org/wiki/File:Fatty_liver.jpg) |
