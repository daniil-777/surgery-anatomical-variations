# Atlas dataset and training iteration protocol

Date: 6 October 2026. Requested outcome: anatomically detailed, controllable organ geometry with a reproducible dataset, usable text controls, improved training and visual inspection across the generated cohort.

## Decision and evidence contract

The next dataset uses the downloaded Human Reference Atlas and BodyParts3D source meshes. It is an attributed derivative release, not wholly original geometry. The previous procedural datasets, checkpoints and geometry decoder remain immutable. The reference PDF is a visual index; original versioned 3D files supply geometry. Published illustrations inform visual review, not a second independent 3D observation.

Users will select an organ and reference template, apply bounded geometric controls or a supported text request, inspect the realized geometry and export that exact result. A learned model may suggest variations or satisfy partial geometric conditions only when it improves measured behavior over simpler baselines. It does not create anatomical knowledge absent from the source collection.

## Measured acceptance

- Source integrity: every admitted template matches the publisher-file checksum and retains attribution, license, source identifiers and exact extraction/transformation history.
- Morphology: identity controls preserve source shape; organ classes and template identities never blend silently. Named anatomical components, source exclusions and boundaries are documented. Fine geometry is retained where present; polygon count does not establish new anatomical detail.
- Deformation: finite vertices, positive transformation Jacobian checks, no new degenerate faces, bounded edge/area distortion and source-relative extent change. Engineering bounds are conservative authoring choices, not population reference intervals. Global self-intersection or simulation readiness is never inferred from these checks.
- Appearance: source colors, neutral clay and authored tissue presentation are separately inspectable. Surface detail and wetness values are design heuristics unless linked to empirical evidence. Rendering style must not hide poor geometry.
- Coverage: record every accepted and rejected candidate and per-template summaries. Every realized instance has a deterministic render entry. Repeated variants and views do not increase the independent source count.
- Training: train-only preprocessing, aligned schema/masks, balanced organ/template sampling, exact artifact binding, seeded reproducibility, resumable checkpoints, explicit baseline comparisons and per-template errors. Select using validation only; reserve the audit split until the configuration is frozen.
- Delivery: a local inspectable atlas mode, original-source recipes, Colab notebook and source package, executable tests, rendered contact sheets and an iteration report. Cloud execution or human anatomical approval is only reported when actually performed.

## Dataset contract

High-resolution template arrays are stored once. Each sample carries a template digest, normalized controls, seed, material specification, realized geometry digest and measured labels. This avoids thousands of duplicated high-resolution meshes while defining reproducible full-resolution 3D objects. Point samples may be cached for training/evaluation with their own seed and derivation record. Reconstructing geometry requires the bound template and generator version.

Controls: `scale_x`, `scale_y`, `scale_z`, `bend`, `twist`, `taper`, `asymmetry`, each in [-1,1]; zero is identity. Coordinates retain the atlas display frame in millimetres with a recorded reversible transform. An unsupported anatomical orientation is not labeled RAS.

Conditions: `extent_x_mm`, `extent_y_mm`, `extent_z_mm`, `surface_area_mm2`, `volume_ml`, `compactness`. Volume and compactness are masked when a trustworthy outer envelope is unavailable; an anatomical capsule's thin-shell volume is not an organ volume. Masked missing values are not imputed as physical measurements.

Each derivative parent and all its views/text/material variants stay together in one split. This release's train/validation/audit track evaluates unseen controls on known source templates. Independent-reference performance is unavailable: too few independent constructions exist per organ, and male/female atlas labels do not by themselves establish independent population sampling. Source group identifiers remain explicit so future independent-source releases can enforce stronger holdouts.

## Iteration sequence

1. Audit and ingest reference geometry; measure the identity baseline and correct component selection/coordinates.
2. Generate a small stress cohort including all control endpoints and opposing combinations; revise transformation bounds in response to geometric failures.
3. Build a versioned cohort with balanced templates; inspect every generated object through reproducible renders and per-organ contact sheets.
4. Compare appearance modes and source silhouettes; revise only traceable geometry/material defects and preserve failed iterations as evidence.
5. Fit statistical and learned baselines; evaluate validation slices and decoded geometric conditions. Select the simplest model that meets the task.
6. Freeze the candidate, run reserved audit once, execute end-to-end studio/export and notebook checks, and publish actual results and remaining gaps.

Revisions get new release directories. No test-set tuning, invented expert approval, automatic physiological certification or source geometry relabeling is allowed.

## Constraints and fallback

Local hardware: 12 CPU cores, Apple MPS available, no local CUDA GPU; approximately14GiB free disk at start. Initial generation and training must fit local resources and remain portable to Colab. The deterministic atlas decoder remains the fallback if learned proposals fail quality checks or a statistical baseline is better. Human-reviewed morphology, living-tissue optical reference coverage and measured organ mechanics remain separate evidence requirements.
