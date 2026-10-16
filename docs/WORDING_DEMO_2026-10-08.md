# Working text controls — 8 October 2026

Open [Anatomy Studio](http://127.0.0.1:5174/?template=hra-liver-female). The existing A100 Joint Flow V2 model remains selected. Text instructions currently use the built-in compiler; no trained wording adapter is active.

For the liver, select **Disease → Alcohol-associated cirrhosis**, then use **Anatomy with words**:

1. `make the liver 10% healthier` reduces authored disease intensity and color contrast by 10%, preserving the other controls.
2. `make the liver 5% wider and wetter` combines a width edit with the supported wetness increase.
3. `clear disease` removes the authored disease recipe.

All three instructions were checked through real API mesh generation (18,011 vertices). The first two were also applied in the browser. The UI reported the healthier edit and a prepared 5% wider surface recipe; surface wetness displayed 65%. Displayed percentages are rounded. These are authoring controls, not clinical health estimates.

## New training result

Qwen2.5-0.5B-Instruct LoRA v3 completed 576 steps over 18,432 examples on A100. It failed the independent wording evaluation and was not activated. Its trained adapter and reports are preserved as a **research-only archive**, separate from production imports.

- [Dataset, notebook, run and research adapter in Drive](https://drive.google.com/drive/u/0/folders/1Uu4zcG5CEXBUSE2Qs7JHV-orNqBDaB_r)
- [Run all notebook](https://colab.research.google.com/drive/1pJQuBB-DkBYXDfmCbfBTZ0O5y6lmKJAX): the same release preserves its failed evaluation and refuses production export; rerunning it does not repair model quality.
- [Research adapter download verification](../artifacts/wording-v3-2026-10-08/research-download-verification.json)
- [Independent failure analysis](../artifacts/wording-v3-2026-10-08/evaluation/FAILURE_ANALYSIS.md)

The new audit and challenge differ from the earlier v2 tests, so their percentages do not establish a controlled v2/v3 comparison.
