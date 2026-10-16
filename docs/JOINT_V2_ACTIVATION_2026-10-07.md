# VISCERA joint v2 activation · 7 October 2026

The expanded model is active in [Studio](http://localhost:5174). The completed local weights are `viscera-joint-v2-weights.zip`; the same format is produced by the delivered Colab notebook.

## Generate a variation

1. Open Studio, choose an organ, then choose a supported **Disease profile**. Choose **Baseline** for an anatomy without disease.
2. Set **Disease design range** to All ranges, Mild appearance, Moderate appearance or Severe appearance.
3. Press **Joint flow variation**. Use **New joint variation** for a new seed and another shape, colour and disease-pattern combination. The generated recipe remains editable.
4. To import newly trained weights, open **Trained models**, select the ZIP under **Colab weight archive**, then press **Validate & activate**. Earlier bundles remain under **Preserved joint models → Use selected version**.

## Run the Colab notebook

- [Open the Run All notebook](https://colab.research.google.com/drive/1Rjsheugj4XjcLIi65mN1L-24x2Sl8hYK)
- [Open the private dataset folder](https://drive.google.com/drive/folders/1v6eyPZZ-kmL6wkOuJaio-mBYXpCQr5oa)

Keep the baseline, disease and runtime ZIPs in **My Drive / VISCERA Expanded Disease Training RC2 2026-10-07**. The evidence ZIP is a separate reference supplement. No code edits or API keys are needed.

In Colab, choose **Runtime → Change runtime type → A100 GPU** if available, save, then choose **Runtime → Run all**. Approve Google's Drive authorization for the account holding that folder. The notebook prints the device actually allocated; other CUDA GPUs and CPU are supported. A100 allocation depends on Google.

Wait for all four code cells, including the full-mesh audit. The final cell verifies and downloads **viscera-joint-v2-weights.zip**. Weights, logs, reports and resumable checkpoints also remain in the folder's `runs/` directory. A failed quality check does not produce a successful export. Browser automation could not complete an actual A100 Colab run; the delivered notebook is ready, and its complete local CPU path was tested.

## Completed checks

All four unmodified delivered notebook code cells passed on CPU in **18.28 minutes**, including 4,000 flow steps, 600 field-surrogate steps, quality gates, full-mesh audit and archive verification. Validation selected **step 100**; later checkpoints overfit and were not exported.

The improvement in synthetic control-density fit is modest: validation NLL per active dimension was **0.696017** versus **0.700516** for the uniform baseline; independent audit NLL was **0.696435**. Lower is better. This is not a clinical realism score or improvement in every individual condition. All **144 conditions / 1,152 sampled meshes** passed the final renderer checks, including exact replay from the saved recipe.

The canonical Studio browser integration check passed in **35.9 seconds**, including switching to the original T4-trained v1 bundle and back to v2. At activation, API process **25534** uses the durable cache at `~/Library/Application Support/VISCERA/joint-v2-2026-10-07`. All five previous/current bundles are retained there, the original model store is untouched, and the existing language adapter is enabled from its offline cache.

`python scripts/run_joint_v2_local.py --check` checks the saved local runtime configuration. After stopping the API yourself, run the same command without `--check` to restart it. The launcher leaves any existing listener untouched and restores the text adapter offline. It requires the existing runtime checkout and Python environment; the durable model cache alone is not a standalone application. Studio's development server is separate.

| Artifact | SHA-256 |
| --- | --- |
| `viscera-joint-v2-weights.zip` | `a72cbbc19b6d9c7a8833108e8d1c01e3669bcf0ebe1dc837fbe232d09155466c` |
| Deployed `model.npz` | `36c361b0d7e51c774a1888ba7f6ea51062d3162b043cc6d82ee3fca2f4499dd4` |

## What this release learns

The datasets contain **82,944 authored examples**: 13,824 baseline and 69,120 disease examples, using 24 source templates, 12 organ groups and **60 external phenotype designs**. Each example retains 512 surface queries. These examples are not independent patients.

V2 is a bounded spline flow over **22 editable shape, material and disease controls**. Its default density is pooled by healthy/disease type; organ and phenotype selection are applied by the versioned renderer. The separate surface-field network is diagnostic by default (`field_weight=0`), so paired surface targets do not train the deployed flow. This is not a learned raw mesh/texture decoder.

Eleven photographic ROI palettes contribute to rendered colour targets. Photographic RGB is not calibrated albedo. The new CT cases are reference material only; they are not consumed by this release's training sampler or geometry targets. No new tissue-physics model or language model is trained.

Mild, moderate and severe denote visual design strengths, not clinical stages. Numerical source-capacity limits can reduce the effective deformation. Mesh checks establish the tested numerical properties and replay behavior; they do not establish collision-free anatomy, measured tissue mechanics or surgical validity. Internal disease anatomy and patient-population realism remain outside this release's validated scope.
