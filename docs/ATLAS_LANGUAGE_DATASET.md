# Atlas language supervision

`datasets/atlas/language-v1` is a separate, synthetic instruction/context dataset derived from the frozen atlas shape cohort. It prepares supervision for a bounded text-to-recipe model. Its labels come from the actual conservative compiler; it does not demonstrate that a learned model already understands anatomy or unrestricted language.

Each shape parent contributes six instructions: a relative width edit, an absolute measured dimension in mm or cm, numeric bend/twist/asymmetry edits, an explicit sex/side reference selection with distinctive controls, a relative shape-control edit, and an unsupported request. Unsupported requests cover pathology, multi-organ assembly, negation, volume, conflicting appearance, and out-of-range controls.

Each pair records the complete context recipe, expected status, and an accepted target recipe or null. Accepted targets have their generated geometry hash, template hash, source ancestry, measured extents and scoped deformation QA. Dimensions refer to the actual source-derived X/Y/Z mesh bounds. They are not population reference intervals.

## Build and verify

From the project root, using the locked Python environment:

```sh
PYTHONPATH=py python -m viscera_core.atlas_language \
  --parent datasets/atlas/cohort-v2 \
  --output datasets/atlas/language-v1

PYTHONPATH=py python -m viscera_core.atlas_language \
  --parent datasets/atlas/cohort-v2 \
  --output datasets/atlas/language-v1 --verify
```

The build compiles every instruction and generates every accepted full-resolution mesh, then independently repeats the entire replay before writing a release. It fails on changed context, changed parent lineage, nonfinite or failed generated geometry, replay differences, cross-split identical target geometry, parent drift, or compiler/generator code drift. The release pins the parent release and source code snapshots. Both the combined `pairs.jsonl` and separate `train.jsonl`, `val.jsonl`, `audit.jsonl` files are hashed. Training should open only the train and validation files; the combined file is for provenance/replay.

## Model output contract

A proposed model output uses exactly:

```json
{"status": "accepted", "spec": {"template_id": "...", "seed": 42, "controls": {}, "appearance": "tissue", "template_sha256": null, "realized_id": null}}
```

The example above abbreviates the controls only to show structure. Actual accepted labels contain all seven finite normalized controls. An unsupported label is `{"status":"unsupported","spec":null}`. Decode JSON, validate the schema, compare against the current compiler result for the same text and context, and only then generate accepted geometry. A model proposal must never bypass the compiler's refusal, reference choices, bounds or mesh QA.

All six rows inherit their shape parent's exact group, ancestry group and split. Reference-switch targets additionally record their own source ancestry. Train, validation and audit still share the small atlas reference library and deterministic phrasing templates. Scores on these splits measure within-generator compiler distillation, not independent anatomy, expert language, unseen phrasing, pathology understanding, or clinical validity. The raw source review and population/mechanics limitations remain applicable.
