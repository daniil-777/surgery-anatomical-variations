# VISCERA procedural shape research candidate

Status: research_candidate. Trained 600 steps on 89 procedural variations.

A conditional rectified flow learns construction parameters in a train-only PCA basis. Conditional Gaussian/PCA and nearest-design baselines are bundled. The decoder is the versioned procedural geometry implementation; weights alone do not contain anatomy.

Parameter transform: bounded_logit. Bounded logit uses authoritative capability intervals and a sigmoid decoder, with exact endpoint training values rejected explicitly. This prevents out-of-domain controls by construction; mesh gates can still reject shapes.

Data are original synthetic designs, unreviewed and not patient anatomy. Validation is within-generator interpolation only. No claim of empirical tissue realism, independent anatomical generalization, or physiological material validity. Training does not read the test split.

See training_report.json for measured compute, failed candidates, condition errors and baseline comparisons. model.pt uses PyTorch weights_only loading and a SHA-256 sidecar.

Development provenance: the former 20 test examples were observed during development and are now a development benchmark. Selection of the bounded representation used validation: acceptance improved 16/19 to 19/19, while liver-volume and width control errors worsened. This is an experimental constrained generator, not the most accurate control baseline. selection.json freezes the candidate before a fresh 32-seed audit. All data use the same authored recipe.

Frozen-model audit: all 32 fresh held-out procedural seeds passed decoded geometry gates for flow, conditional PCA and nearest-design baselines. Flow mean absolute liver-volume error was 93.69 mL, width 4.87 mm, height 3.74 mm, gallbladder enclosed volume 3.40 mL and length 4.42 mm. Conditional PCA performed better on these control errors (75.42 mL, 3.55 mm, 2.66 mm, 2.53 mL, 1.85 mm). These are same-generator synthetic measurements, not expert anatomical or tissue validation. The frozen flow is retained as a generative research baseline; this audit was not used to refit or select it. Twelve separately seeded unconditional samples also passed 12/12 gates. See postfreeze_evaluation.json and variants.json.
