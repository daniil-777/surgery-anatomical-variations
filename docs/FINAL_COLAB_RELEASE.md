# VISCERA final training and Studio delivery

This release pairs `viscera-final-dataset-2026-10-07.zip` with
`VISCERA_final_run_all.ipynb`. The notebook pins the complete archive SHA-256,
verifies all files before importing project code, and trains new model outputs.
Keep both files together in **My Drive / VISCERA Final Training 2026-10-07**.

## Train without editing code

1. Open the notebook in Google Colab and choose **Runtime → Run all**.
2. Approve Google's Drive access prompt. Colab requires this interaction to read
   the private dataset and retain outputs in your Drive.
3. Wait for environment setup, training, validation and export. The notebook
   requests a GPU; the core models also run on CPU. The optional Qwen text adapter
   runs automatically only when CUDA is available. Its result is recorded
   explicitly if it is skipped or fails.
4. Download the resulting `viscera-final-weights.zip`. The notebook starts one
   download and also saves the ZIP and checksum receipt under the Drive folder's
   `weights/` directory. Detailed checkpoints, metrics and logs remain in `runs/`.

Completed, verified stages are reused when the notebook runs again. An interrupted
stage starts a new attempt without discarding earlier work. Runtime identity and
source/data hashes prevent silently mixing incompatible runs.

## Use the weights in Studio

Open **Trained models**, select `viscera-final-weights.zip`, and choose
**Validate & activate**. The local server checks file integrity, exact dataset and
decoder compatibility, every model vocabulary and deployment inference before
atomically activating the bundle. Use the learned sampling controls in Shape,
Surface and Disease. Importing does not change the currently displayed organ.
**Restore defaults** provides a reversible return to the configured original
models. See [the full integration guide](COLAB_WEIGHTS_IN_STUDIO.md).

The exact reference templates and datasets must remain installed alongside the
Studio. These compact weights predict controls consumed by the anatomy library;
they do not contain a standalone neural mesh generator.

## Dataset and model scope

| Lane | Included data | Output |
|---|---|---|
| Shape | 1,536 recipes and 24 templates across 12 organs | Seven bounded geometry controls |
| Surface | 768 recipes with procedural material fields | Six appearance controls |
| Disease | 3,600 recipes, 25 supported profiles; 200 realized surfaces for replay | Nine authored visual features |
| Text | 9,216 compiler-derived examples | Optional healthy-shape text-to-spec LoRA |
| Clinical pilot | Three CC BY pancreatic cases, one per split | Observed-case retrieval prior |

Selection compares neural candidates against simpler baselines and deploys the
validated choice. The local full run selected ridge geometry/material models and
a conditional VAE for disease recipes. Clinical retrieval remains separate from
synthetic disease generation. The language adapter is restricted to the current
healthy atlas schema and must pass the deterministic semantic compiler.

These are reproducible prototype datasets and models. Shared source templates
mean synthetic holdouts measure generator behavior, not unseen-patient
generalization. No calibrated tissue mechanics, optical measurements or clinical
disease prevalence is learned. Detailed provenance, retained attribution,
measurements and limitations are in [the data audit](FINAL_DATA_AUDIT.md) and
[the training audit](FINAL_TRAINING_AUDIT.md).

The delivery verification receipt records the exact notebook, archive and local
execution checks. Local CPU execution does not establish hosted Colab GPU or
pretrained Qwen performance. Google controls GPU availability and requires the
Drive authorization described in its [Colab FAQ](https://research.google.com/colaboratory/faq.html).
