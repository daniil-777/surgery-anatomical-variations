# Disease variations across all 12 organs

This release connects the disease reference atlas to organ-specific surface
generation, a versioned synthetic dataset, conditional recipe training, serving,
text controls and the Studio. It is an engineering prototype for controllable
anatomical assets. The photographs supply morphological references; they are not
paired 3D supervision, calibrated tissue colors or mechanical measurements.

## Coverage

Every supported profile has a distinct identifier, cited reference, organ check,
bounded controls, deterministic seed, and explicit modeling limits. These are
outer-surface interpretations of the named conditions, not complete pathology.

| Organ | Available surface profiles | Reference only; required anatomy is absent |
|---|---|---|
| Liver | Cirrhosis; hepatocellular carcinoma; metastases | — |
| Gallbladder | Cholecystitis; carcinoma | Gallstones: lumen and intraluminal stones |
| Stomach | Adenocarcinoma; GIST | Ulcer: mucosal surface and wall layers |
| Pancreas | Cancer; pancreatitis; pseudocyst | — |
| Spleen | Infarct; cyst | Rupture: lacerations and changed topology |
| Small intestine | Crohn disease; neuroendocrine tumor | Obstruction: lumen and causal transition point |
| Colon | Cancer; diverticulosis | Ulcerative colitis: mucosa and wall layers |
| Kidney | Cancer; polycystic morphology | Hydronephrosis: collecting system and parenchyma |
| Bladder | Cancer; diverticulum | Stones: lumen and intraluminal stones |
| Heart | Healed infarction surface proxy | Aortic stenosis and endocarditis: valves |
| Lung | Cancer; emphysema surface proxy | Bronchiectasis: airway tree |
| Brain | Meningioma and glioblastoma surface proxies | Aneurysm: cerebral arterial tree |

There are 25 supported profiles and 11 reference-only profiles. In particular,
brain masses lack internal lesion segmentation, infarction lacks transmural scar,
and emphysema lacks alveolar destruction. A convincing exterior cannot establish
these missing structures. Reference-only conditions are disabled in the Studio
and rejected by the generator, text compiler and trained sampler.

## Using the editor

Choose an organ, open **Disease**, and select a profile. Morphology intensity,
region size, spread, irregularity, contrast, feature count, location and seed
update the preview. Intensity is a design control, not a clinical severity grade.
Location uses the normalized source reference axes, not patient directions.

**Generate variation** changes the procedural shape and disease controls while
preserving surface settings. **Learned disease variation** samples the trained
conditional recipe prior while preserving the existing shape and surface
controls. Its request seed and derived spatial seed are recorded separately; the
returned recipe contains the spatial seed needed to replay the mesh. Select
**Baseline** to remove the modifier. Baseline does not certify a healthy source.

The explicit text grammar supports examples such as:

```text
cirrhosis severity 0.65 count 4 and wetter
pancreatic pseudocyst size 0.6 disease seed 42
polycystic kidney severity 0.7 spread 0.8
clear disease
```

The grammar composes with existing shape and material edits. Unsupported stages,
physical units for disease extent, tissue stiffness, negation and conflicting
organs are rejected atomically. It is not unrestricted natural-language medical
reasoning. Text and editor controls use the same serialized disease recipe.

## Geometry, appearance and export

Disease fields act in source coordinates before the existing shape deformation.
Compact, disjoint support regions produce smooth local displacements. The
continuous map has a conservative positive Jacobian bound. Discrete faces are
checked for collapse and reversal against the baseline. When the source mesh
cannot carry the requested displacement, the generator reduces its amplitude,
records the applied fraction, and the Studio reports this limitation. It does
not silently replace topology or discard triangles.

Shading uses the same localized disease field in the live shader, CPU vertex
colors and exported texture bake. Existing tissue roughness and fine optical
detail remain independent controls. Lesion colors are authored design choices;
they have not been calibrated against photographed tissue under known lighting.

Exports verify the bound template and realized geometry before writing a GLB.
Files preserve disease recipes and provenance, use glTF Y-up coordinates and
meters, and retain nonmetallic PBR materials. A stale recipe cannot export the
previous preview under a new label. The field's invertibility does not certify
the source mesh, internal contacts, tissue mechanics or anatomical correctness.

## Datasets and learning

| Release | Contents | Split meaning |
|---|---|---|
| `disease-releases/recipes-v2` | 3,600 authored recipes; 144 per supported profile | 2,400 train / 600 validation / 600 audit; whole recipe groups |
| `disease-releases/geometry-v1` | 200 realized surfaces; 8 per supported profile; sampled points, normals, colors, measured features and exact full-resolution replay | 150 train / 25 validation / 25 audit, inherited from parent recipes |
| `disease-releases/clinical-ccby-v3` | Three licensed pancreatic cancer segmentation cases | One patient in each split |
| `disease-releases/clinical-nc-v3` | The three pancreatic cases plus four KiTS19 kidney tumor cases | Three train / two validation / two audit; noncommercial opt-in |

The geometry cohort stores the shared licensed source templates once, paired
with replay recipes, rather than duplicating every full-resolution mesh. These
synthetic splits share source anatomy and generator rules; they are not
patient-held-out evidence. Kidney source labels include both kidneys and retain
that scope. Clinical cases retain original masks, affine coordinates, measured
features, aligned geometry, licensing and patient groups.

The conditional VAE learns nine synthetic recipe controls across 25 profile
conditions. Its outputs pass through the deterministic anatomical decoder used
by the Studio. It does not learn unconstrained 3D pathology from the reference
photographs. A separate empirical prior retrieves measured clinical cases; the
tiny clinical sample does not support a learned disease population distribution.

See [training and evaluation](DISEASE_TRAINING.md),
[clinical source provenance](DISEASE_SOURCE_DATASET.md), and
[geometry dataset](DISEASE_GEOMETRY_DATASET.md). Models and datasets bind exact
hashes; editing a frozen generator requires a new release and model run.

## Colab and local startup

Open `notebooks/VISCERA_disease_variations_and_training.ipynb` in Colab and upload
`artifacts/colab/viscera-disease-colab.zip` when prompted. The bundle contains the
same source, pinned primary dependencies, CC BY clinical cases, all-organ
synthetic datasets, licensed templates and checked model artifacts. KiTS19 is
excluded from this default package. The separate noncommercial package requires
explicit opt-in. Consult the notebook for the exact execution order and checks.

The API defaults to `artifacts/disease/recipes-run-v2/model.npz` and
`disease-releases/recipes-v2`. Existing atlas templates are resolved through
`VISCERA_ATLAS_TEMPLATES`. Overrides are `VISCERA_DISEASE_MODEL` and
`VISCERA_DISEASE_DATASET`. Run the existing Studio and API startup workflow after
installing the updated code; `disease-data` is only needed for NIfTI ingestion.

## Acceptance scope

Automated checks cover controls, source compatibility, finite geometry, unchanged
indices, zero-intensity identity, seed diversity, field bounds, stale exports,
shader/bake color parity, text rejection, model/dataset binding and patient/split
integrity. Live editor captures inspect organ visibility, control response,
learned sampling and exported geometry. Exact run results accompany the release
in `artifacts/disease` and `disease-qa`.

These checks establish software behavior and measured geometric properties.
They do not establish clinical realism or surgical simulation readiness. Tissue
stiffness, cutting, bleeding, contact mechanics, histology, disease prevalence
and expert anatomical acceptance remain unvalidated.
