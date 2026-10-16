# Final training pipeline audit — 7 October 2026

The final entrypoint is `scripts/final_train.py`. It trains four independent
lanes, freezes each selection, evaluates its held-out split, reloads deployment
artifacts, checks deterministic inference across every supported vocabulary, and
exports `viscera-final-weights.zip`. The optional healthy atlas text-to-spec LoRA
is trained on CUDA in `auto` mode; its failure is explicit and does not discard
completed core weights. `--language on` makes that failure fatal.

## Review scope and changes

The first review read the active shape, material, disease and language trainers,
their training/inference contracts, checkpoint identities, split boundaries,
baseline promotion rules and existing tests. It preserved all frozen generators,
datasets and previous models. The obsolete `language.py` targets the earlier
liver/gallbladder patch schema and depends on unavailable legacy helpers; it is
excluded from the final package and is not the final text adapter.

An independent second reviewer inspected the new coordinator. That review led
to explicit fixes for artifact path aliases and directory-symlink escapes,
disease-catalog JSON source identity, native geometry/material parent validation,
nested attribution preservation, and completed-export manifest anchoring. A
further check isolates material train/validation groups from audit groups.

Integrity and lineage validation may inspect audit structure before training.
Audit metrics and labels never influence training, hyperparameter selection or
promotion; each metric is computed after that lane's model is frozen. Synthetic
splits share source atlas lineages and establish within-generator control
performance, not patient generalization.

## Executed verification

- **48 tests passed**: 36 existing active-trainer tests and 12 coordinator tests.
  Existing tests include a real tiny random Qwen LoRA optimization, exact resume,
  target masking, split isolation, safe loaders and deployment parity. They do
  not download or test the pretrained Qwen base.
- A full local CPU run completed with **1,200 shape steps, 2,000 material steps,
  1,600 disease steps**, and the independent clinical retrieval prior.
- All exported model loaders executed successfully. Repeated seeds matched for
  every shape template, material group and disease profile. ZIP CRC and every
  archived SHA-256 were verified.
- A four-step smoke run exercised the same pipeline. Its archive is explicitly
  marked diagnostic; it must not be activated as a trained Studio release.
- Completed stages retain integrity manifests; interrupted stages remain intact
  and restart in a new attempt directory. Changing inputs requires a new output
  directory. Completed final exports bind their manifest hash and ZIP hash.

## Full CPU result

| Lane | Selected deployed method | Held-out result |
|---|---|---|
| Geometry | Ridge baseline; trained MLP candidate retained | 240 realized audit geometries. Extent MAE x/y/z: 0.1355 / 0.1435 / 0.1428 mm. Surface area MAE: 147.70 mm². |
| Appearance | Ridge baseline; trained MLP candidate retained | 144 audit recipes. Macro actual-field summary NRMSE: 0.08340. |
| Disease recipe | Conditional VAE | 600 audit recipes, 25 supported profiles. Macro mean-feature MAE: 0.04661; minimum 128 distinct vectors among 128 sampled draws per profile. |
| Clinical source | Empirical case retrieval | One training, one validation and one audit pancreatic case. No learned population variance or clinical simulator. |
| Text adapter | Skipped: no local CUDA | Pretrained-base training, GPU memory and Colab execution remain separate checks. The deterministic compiler remains available. |

Geometry volume and compactness had **zero valid observations** and are reported
as unavailable. The geometric and appearance scores concern the synthetic
generator, not agreement with real surgical photographs or material mechanics.

The local full artifact is `artifacts/final-colab/runner-full-v3/`.
The ZIP is 780,750 bytes and its SHA-256 is
`0d57d705c90ac7be35531a0b9132c1d31308962821acdbbbc3ec461b455df7e1`.
Future executions record their own environment, metrics and checksum; ZIP bytes
need not match across systems because provenance records differ.

## Inference boundary

Weights require the exact licensed template dataset and deterministic renderers.
They are compact learned design controls, not a standalone free-form 3D model.
No tissue stiffness, force/contact parameter, calibrated optics, clinical disease
stage or prevalence was learned. The source-case prior remains separate from
synthetic disease recipes. The optional Qwen adapter proposes healthy atlas JSON
only and is not promoted automatically into Studio runtime inference.

The final notebook bootstrap and Studio ZIP-import integration have their own
validation records; this document does not claim that this Mac executed Colab
GPU hardware or a downloaded pretrained foundation model.

The optional imported language adapter now has an explicit Studio enable action.
This may download its pinned Qwen base. Every resulting shape proposal must pass
the exact deterministic compiler guard; disagreement returns no edit. Existing
material and disease recipes are preserved on same-template shape edits. Eleven
serving boundary tests passed with a fake loader (no pretrained-model claim),
and 22 notebook bootstrap/export tests passed in the clean training environment.
