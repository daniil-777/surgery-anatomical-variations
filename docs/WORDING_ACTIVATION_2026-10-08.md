# Wording model recovery — 8 October 2026

## What the supplied ZIP contains

`viscera-joint-v2-weights_wording.zip` is a valid Joint Flow V2 bundle. Every payload file is byte-identical to `viscera-joint-v2-weights_new.zip`. Its filename does not identify its architecture: the archive contains bounded shape/material/disease control weights, no text adapter. The existing A100 joint model remains selected and all four retained joint models pass integrity checks. [Archive audit](../artifacts/wording-integration-2026-10-08/archive-audit.json).

The Colab disease notebook visibly reported the same archive checksum and reused completed joint training. The separate wording notebook trains a pinned Qwen2.5-0.5B-Instruct rank-16 LoRA. Its Drive checkpoint continued advancing from 9,900 to 10,000 steps during recovery; the full language run was not lost.

## Code recovery

The local API and frontend had no active listeners. Studio was restarted using current workspace source and the preserved model store. Contextual disease/material edits now work even when the legacy shape-only text option is enabled. Unsupported compound edits remain atomic. Import messages distinguish geometry weights from wording weights. Frozen original trainer and semantic source files were preserved.

TypeScript checking, production build, focused API tests, real text-to-mesh requests and two-seed joint inference passed. [Studio evidence and restart commands](../artifacts/wording-integration-2026-10-08/STUDIO_RECOVERY.md).

## Trained checkpoint candidate

To address the one-hour deadline, a separate snapshot was frozen at **10,100 of 12,000 planned optimizer steps**, with **323,200 examples seen** from **192,000 training rows**. It is an early-stopped candidate; the original full run continues independently. The parent checkpoint SHA-256 is `5a3d1b2b403f7d2f211e3308a6e5d5763438c0115f7db7e62e0dc9fe70a68a1d`.

A distinct snapshot format records actual and planned work. It does not rewrite the original checkpoint identity or claim completed training. Safetensors conversion is verified, including a separate exact tensor conversion test. Activation still requires all original raw-model and guarded-runtime accuracy thresholds, 512 stratified audit prompts and the complete 81-prompt challenge. Source, data, checkpoint, adapter and evaluation hashes are retained.

**Current state: evaluation failed; the candidate was not exported or activated.** Raw exact-plan accuracy was 68.16% on 512 audit cases and 34.57% on 81 challenge cases. After runtime guards, accuracy was 73.44% and 39.51%; one unsupported challenge request still received an edit. The 83.20% audit validity figure measures valid plans, not merely JSON syntax. All original quality thresholds remain unchanged. [Live recovery record](../artifacts/wording-integration-2026-10-08/colab-recovery-status.json).

This model translates contextual instructions into supported visual-authoring plans. It does not learn a new anatomical mesh decoder, clinical diagnosis or tissue mechanics. Geometry/appearance generation remains a separate model and renderer.

## Notebooks and editor

- [V3 run-all Colab notebook](https://colab.research.google.com/drive/1pJQuBB-DkBYXDfmCbfBTZ0O5y6lmKJAX) and [preserved Drive delivery](https://drive.google.com/drive/u/0/folders/1Uu4zcG5CEXBUSE2Qs7JHV-orNqBDaB_r). The separate A100 run completed training but failed evaluation; no v3 weights were exported or activated. Rerunning the same notebook preserves that failure and refuses export. [Final V3 result](WORDING_V3_TRAINING_2026-10-08.md).
- [Original full wording training in Colab](https://colab.research.google.com/drive/1TO5xXDAlFkdm5cEzZtwU2SZsITLNVH9o) trains or resumes the separate `run-v2` language adapter.
- [Recover the evaluated snapshot](../artifacts/wording-integration-2026-10-08/VISCERA_recover_trained_wording_2026-10-08.ipynb) verifies this exact candidate and downloads its weights after a passing recorded evaluation. It does not start training or repeat the audit.
- [Local Studio](http://127.0.0.1:5174/?template=hra-liver-female) uses an activated wording adapter automatically in **Anatomy with words**. The **Trained models** panel distinguishes the wording and joint generation models.

For an existing disease profile, contextual instructions such as “make it healthier” adjust authored visual controls. Relative shape and surface instructions can be combined where supported. Actual neural application and latency will be recorded separately from unit-test results.

## Failure diagnosis and next training run

Training used 75 phrase families repeated over many recipe contexts. The disease-relative families required an explicit percentage; qualitative/default-magnitude requests were missing. The model often confused reducing disease appearance with clearing the disease. No broken loss mask or archive corruption has been established. See the [saved failure analysis](../artifacts/wording-integration-2026-10-08/failed-evaluation/FAILURE_ANALYSIS.md).

A separate v3 coverage correction completed all 576 steps on the Colab A100. It contains 18,432 training rows and 4,608 validation rows, plus newly authored held-out audit/challenge partitions frozen before training. Its final evaluation also failed: raw exact-plan accuracy was 45.51% on 512 fresh audit cases and 25.00% on the 96-case fresh challenge. Runtime guards raised challenge accuracy to 50.00% and eliminated its observed false accepts, but the unchanged accuracy gate still failed. No v3 production ZIP was exported or activated. The v2 and v3 held-out sets differ; these percentages are not a direct comparison. [V3 reports, notebook, Drive delivery and limits](WORDING_V3_TRAINING_2026-10-08.md). Both inspected evaluations are now exposed evidence for any subsequent revision.

Fresh live checks confirm that all previous model pointers/history are unchanged, and the built-in compiler still handles supported healthier, width and wetness edits. [Failed-activation and service evidence](../artifacts/wording-integration-2026-10-08/failed-wording-activation-evidence.json).
