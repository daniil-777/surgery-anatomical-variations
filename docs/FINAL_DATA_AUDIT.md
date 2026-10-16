# Final Colab dataset audit — 7 October 2026

The final archive consolidates six immutable releases for the existing controllable anatomy prototype. It is a reproducible training release, not a claim of clinically validated anatomy or learned tissue mechanics. The companion notebook trains new outputs; the data archive contains no pretrained weights.

| Lane | Training | Validation | Audit | What is supervised |
|---|---:|---:|---:|---|
| Atlas shape | 1,056 | 240 | 240 | Seven authored deformation controls, geometric measurements and sampled surfaces |
| Material | 480 | 144 | 144 | Six authored appearance controls and eight procedural surface fields |
| Language | 6,336 | 1,440 | 1,440 | Text-to-spec examples; 7,680 accepted and 1,536 unsupported overall |
| Disease recipe | 2,400 | 600 | 600 | Nine visual design features across 25 supported profiles |
| Disease geometry | 150 | 25 | 25 | Realized surface samples for 25 profiles, with frozen parent recipes |
| Clinical pilot | 1 | 1 | 1 | Three independently grouped pancreatic tumor cases and source segmentations |

The atlas contains 24 display templates spanning brain, gallbladder, heart, kidney, large intestine, liver, lung, pancreas, small intestine, spleen, stomach and urinary bladder. These are source references, not 24 independent patients. Eleven disease profiles remain reference-only and must not silently become supported training targets. The geometry lane is supplied for replay, quality checks and future geometry supervision; the current disease recipe model predicts authored controls.

## Verification performed

`scripts/package_final_colab.py --audit-only` invokes the native verifier for every release. This checks immutable release identity, member SHA-256 hashes, generator/source dependencies where required, template hashes, clinical rights and frozen geometry decoder compatibility. An additional independent pass checks all sample identities and recipe/patient groups for cross-split overlap, verifies material/language links to the exact shape parent, checks disease geometry against the exact recipe parent and shared atlas templates, and checks that every language derivative retains its parent shape split.

The final packaging command repeats the audit, constructs a deterministic ZIP, checks CRC and SHA-256 for every entry, extracts into a new empty temporary directory and repeats all six release and split checks there. Entries must be ordinary files under `viscera/`; traversal paths, aliases, duplicate members, symlinks and unmanifested entries are rejected. The JSON receipt records the archive hash, byte size, member verification and extracted-data verification. The independently distributed notebook pins the final archive hash before importing any bundled code.

Two complete copies of some atlas templates and the disease parent snapshot are intentional. Their exact bytes are retained as ordinary files because independent frozen release verifiers reject symlinks. The manifest records duplicate content. This small download overhead avoids release changes or implicit dependency reconstruction in Colab.

## Provenance and rights

The selected third-party anatomical templates carry CC BY 4.0 source notices. Exact author attribution, source URLs and retained license evidence are included in `datasets/atlas/cohort-v2/templates/ATTRIBUTIONS.md`, the template metadata and `templates/attribution/`. The clinical lane is `disease-releases/clinical-ccby-v3`, with CC BY attribution conditions and retained Zenodo provenance, source masks, case metadata and patient split assignments. No KiTS19 noncommercial data is packaged. The frozen clinical dataset card contains a generic KiTS-related limitation inherited from the broader importer; there are no KiTS cases in this selected release.

No blanket license is assigned to project code or third-party content. Source notices must remain with redistributed data and derivatives. Reference-image registry metadata remains provenance context; reference photographs, external viewer models, research papers and surgical videos are not included as training labels.

## Interpretation limits

- Synthetic recipes and all their descendants stay together, but source anatomical templates are shared across training, validation and audit. These holdouts measure authored-generator generalization, not unseen-patient generalization.
- The clinical lane has only one training patient. Its fitted output is a source-case retrieval/statistics pilot, not a learned population distribution. Patient age is not established by the retained source metadata.
- Material colors, roughness and visual disease strength are authored targets; no measured optical coefficients, elasticity, viscosity, force or clinical severity labels are supplied.
- Display surfaces can contain open boundaries and internal faces. They are not automatically valid tetrahedral simulation domains. BodyParts3D millimetre scaling remains an explicit source-unit assumption.
- Exact CPU geometry replay is tied to the frozen generator and recorded numerical stack; cross-runtime bitwise geometry identity is not assumed.

The archive inventory and `bundle-data-audit.json` provide the exact release identifiers, hashes, split counts and constraints. The Run-all notebook is distributed separately to avoid a self-referential archive checksum.

The bundle includes the active `atlas_*` training modules and the Studio source snapshot. The obsolete `pipelines/train/viscera_train/language.py` entry point is deliberately excluded: it targets an earlier two-organ patch schema and depends on a missing legacy shape module. The final runner uses `atlas_language.py` and the current compiler-pair contract instead.
