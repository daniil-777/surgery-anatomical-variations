# Wording v3 — training and delivery status

**Final result, verified 8 October 2026: training completed; held-out evaluation FAILED. No production bundle was exported or activated.** The A100 completed **576/576 steps**, seeing all **18,432 training examples**. Exact-plan accuracy was **45.51% on 512 fresh audit cases** and **25.00% on 96 fresh challenge cases** before runtime guards. Low training loss did not translate into sufficient held-out instruction accuracy. [Cloud run and final status](../artifacts/wording-v3-2026-10-08/cloud-launch-status.json).

| Evaluation | Exact-plan accuracy | False accepts of nonaccepted requests |
|---|---:|---:|
| Raw audit, 512 cases | 45.51% | 0 |
| Raw challenge, 96 cases | 25.00% | 24 |
| Guarded runtime audit, 512 cases | 45.51% | 0 |
| Guarded runtime challenge, 96 cases | 50.00% | 0 |

Runtime guards removed the observed challenge false accepts but did not repair the accuracy failure. All original promotion gates remain unchanged. Batched and sequential generation matched exactly on **16/16 pre-audit validation cases**, so batching was used as declared. [Original evaluation report](../artifacts/wording-v3-2026-10-08/evaluation/evaluation.json) and [completed training report](../artifacts/wording-v3-2026-10-08/evaluation/training_report.json) are preserved.

V2 and v3 used different held-out test sets. These percentages do **not** establish a direct regression or improvement between the models.

[Failure analysis](../artifacts/wording-v3-2026-10-08/evaluation/FAILURE_ANALYSIS.md) identified a concrete label defect: eight v3 families authored default qualitative dimension changes as ±10%, while the frozen editor policy uses ±5%. It also found missing cross-domain composition examples and relative grain/tint targets. The shape defect could directly affect at most 41 selected audit cases and therefore does not explain the full failure. All 48 supported challenge compositions were incorrect.

The independent post-run review also found a dataset defect: 3,072 training and 768 validation rows teach a 10% qualitative shape change, whereas the frozen editor contract defines 5%, or 3% for gentle qualifiers. The earlier gold checks verified plan validity but missed this semantic inconsistency. At most 41 of the 512 audit cases are directly affected. The training data also lacks cross-domain compound edits, and all 48 supported compound challenge cases failed. These findings are preserved in the [failure analysis](../artifacts/wording-v3-2026-10-08/evaluation/FAILURE_ANALYSIS.md); the frozen v3 data and scores have not been rewritten.

## Corrected training release

The failed v2 candidate exposed missing qualitative/default requests, including instructions that omit explicit percentages. V3 adds those cases while retaining numeric edits, preservation constraints and unsupported requests. It starts a separate LoRA run from the pinned public Qwen2.5-0.5B-Instruct base; the failed checkpoint is not relabelled as a successful model. Original models, source contracts, datasets and run directories remain preserved.

| Partition | Rows | Role |
|---|---:|---|
| Training | 18,432 | One full epoch of optimizer updates |
| Validation | 4,608 | Fixed 32-case baseline/final diagnostic; separate 16-case generation parity check |
| Fresh audit | 576 | Fixed stratified selection of 512 for final evaluation |
| Fresh challenge | 96 | Complete independently authored challenge for final evaluation |

The fresh held-out files were authored and frozen before v3 training. Partition identities, phrase families, prompt overlap and gold-plan compatibility were checked. The inspected v2 audit/challenge are retained separately as exposed regression evidence. These are synthetic authored language tests, not clinician evaluation or evidence of unrestricted natural-language understanding. [Frozen dataset card](../datasets/atlas/wording-v3-coverage-2026-10-08/DATASET_CARD.md).

Training uses rank-16 LoRA, learning rate **3e-5**, microbatch **16**, accumulation **2**, and **one complete epoch**. The first actual optimizer step was checkpointed and resumed with identical configuration before continuing. The prepared configuration requires an A100 40 GB or larger. The isolated environment runs Torch **2.8.0+cu126**; it does not replace the Colab notebook kernel's packages.

Final evaluation retains all original raw-plan and guarded-runtime thresholds. Batched greedy generation is used only after exact output parity on 16 fixed validation cases. Any parity mismatch selects the original sequential generator before audit prompts are opened. Evaluation execution and helper identity are recorded. A failure produces diagnostics and **no promoted weights**. Low training loss does not bypass these gates.

## Run-all notebook and files

- [Open the V3 run-all notebook in Colab](https://colab.research.google.com/drive/1pJQuBB-DkBYXDfmCbfBTZ0O5y6lmKJAX)
- [Drive folder: dataset ZIP, notebook and run](https://drive.google.com/drive/u/0/folders/1Uu4zcG5CEXBUSE2Qs7JHV-orNqBDaB_r)
- [Local copy of the V3 notebook](../notebooks/VISCERA_wording_v3_coverage_run_all.ipynb)
- [Prepared dataset and frozen source ZIP](../artifacts/wording-v3-2026-10-08/delivery/viscera-wording-training-v3.zip)
- [Delivery checksums and preflight](../artifacts/wording-v3-2026-10-08/delivery/delivery.json)

These links preserve the reproducible failed run and its dataset. **Rerunning this same notebook is not a fix:** it reuses completed training, preserves the failed final evaluation and refuses production export. It does not repeat the audit or silently lower thresholds. A revised training approach needs a separate release and a newly frozen independent evaluation; the inspected v3 audit is now exposed evidence.

For inspection or recovery, the notebook is available directly in Colab or through **File → Upload notebook** using the local copy. Its prepared configuration requires an **A100 GPU**. The Drive mount locates `MyDrive/VISCERA Wording Coverage V3 2026-10-08`; no source paths, folder IDs or model tokens need editing.

The Drive folder and standalone Colab notebook links were verified through the authenticated browser. The standalone notebook was not executed. The actual background run completed training and failed evaluation in the older connected notebook linked below. Checkpoints and reports remain available.

Drive run directory:

```text
MyDrive/VISCERA Wording Coverage V3 2026-10-08/run-v3-7e93065b7dd7
```

`training.log`, `progress.json`, `training_report.json`, `evaluation.json` and `pipeline_status.json` retain the result. The pipeline status is **`evaluation_failed`**, and the adapter manifest remains **`promoted: false`**. No production `viscera-wording-weights.zip` was exported. The downloaded evaluation-evidence ZIP contains reports, not deployable weights.

The actual trained adapter is separately retained as [viscera-wording-v3-research-adapter.zip](../artifacts/wording-v3-2026-10-08/delivery/viscera-wording-v3-research-adapter.zip), also in the Drive delivery folder. It has an explicit research-only manifest, retains the failed evaluation, and is not a production import bundle. Its ten adapter/tokenizer files and report binding were [checksum-verified locally](../artifacts/wording-v3-2026-10-08/research-download-verification.json). Keeping these weights does not activate them.

This cloud run was launched in a clearly added recovery cell of the existing [connected Colab notebook](https://colab.research.google.com/drive/1Rjsheugj4XjcLIi65mN1L-24x2Sl8hYK). The linked local v3 notebook is the standalone reproducible delivery; the older notebook's title does not identify the new worker's model.

## Studio scope and activation

The trained candidate is a wording adapter intended to propose bounded shape, material and disease-control edits. It failed acceptance and is not serving Studio requests. The preserved joint model and renderer still generate the mesh and appearance. This release does not train a new mesh decoder, establish realistic tissue mechanics, infer patient disease, or support arbitrary topology changes.

Studio retains its previous models and supported built-in text editing. A functioning **Anatomy with words** box does not mean the failed v3 weights are active. **Trained models** distinguishes the existing joint model from the separate wording lane. Any future activation requires a passing archive and actual local neural inference verification.

## Separate v4 correction draft — not trained or promotable

The [v4 draft builder](../scripts/build_wording_v4_shape_draft.py) preserves the immutable v3 release and corrects only its 3,072 affected training labels and 768 affected validation labels. It obtains default magnitudes from canonical probes of the frozen parser. Regression tests also verify ±3% for “slightly” and “a little,” preserve explicit numeric percentages, and check preservation constraints. This is agreement with an authored editor policy, not a physiological measurement.

An additional 384 authored examples per split cover shape/material combinations, shape/disease combinations, contradictory preservation requests and relative grain/tint edits. In each split, 48 examples contain actual shape+material edits, 24 contain actual shape+disease edits, 96 refuse conflicting preservation, and 192 exercise relative grain/tint changes. The remaining 24 shape/disease requests concern healthy baselines and correctly apply only shape edits. Supplemental prompts do not exactly reuse the exposed evaluation text.

The draft has 18,816 training rows and 4,992 validation rows. **No v4 model was trained, no independent v4 audit exists, and promotion remains disabled.** These additions address known construction gaps; they do not establish improved language generalization. A new independent evaluation and broader reviewed instruction coverage remain necessary.

[Draft dataset card](../datasets/atlas/wording-v4-shape-contract-draft-2026-10-08/DATASET_CARD.md) and [verification evidence](../artifacts/wording-v4-draft-2026-10-08/verification.json) record 54 passing regression checks, exact correction counts, untouched inherited prompts/contexts, unchanged unrelated labels and preserved v3 source/artifact hashes. The frozen v3 notebook and original failure reports were not rewritten.

Frozen release SHA-256: `7e93065b7dd7133f1890857665a6e65e24f2171ff2e6983488d85b973e5dcb2f`.

Training ZIP SHA-256: `063b1a215e95f17f00feb2435fcdc13b10fc1a6bd3222e03e5ccf411c4841eeb`.

Notebook SHA-256: `eb693ad37cff0d091ae704f4cb211d1e842c1b5b1f59df153ec299c7612366f4`.

## Separate correction draft

The [v4 draft builder](../scripts/build_wording_v4_shape_draft.py) preserves the frozen v3 release, corrects the 3,072 training and 768 validation shape-default labels, and adds 384 authored examples per split covering compound edits, preservation conflicts, grain and tint. The resulting untrained draft contains 18,816 training and 4,992 validation examples. All 54 regression checks and Ruff passed; [verification evidence](../artifacts/wording-v4-draft-2026-10-08/verification.json) also confirms that original trainer, v3 data and notebook hashes remain unchanged.

This draft is explicitly not eligible for promotion. It has no new independent audit and has not been trained. The corrections address demonstrated data defects and coverage gaps; they do not establish improved model accuracy. For the current deadline, the [verified Studio demonstration](WORDING_DEMO_2026-10-08.md) uses the preserved joint model and built-in text compiler.
