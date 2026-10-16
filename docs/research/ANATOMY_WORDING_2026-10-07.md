# Anatomy wording: context-aware visual edits and training evidence

Research date: 2026-10-07. Scope: language for the existing VISCERA surface authoring system, not clinical decision support. Sources were checked directly on NIH/NCI and library/model publishers' websites. The independent challenge set is [anatomy-wording-challenge.jsonl](../../tests/fixtures/anatomy-wording-challenge.jsonl).

## What “healthier” can mean here

“Healthier” is a comparative instruction, not a disease, a measurement, or an anatomical diagnosis. For an existing disease recipe, VISCERA can interpret it as **reduce the current authored disease appearance**. Preserve the selected anatomy, reference, random seed, location, shape controls, and material unless the user explicitly asks to change them. If no disease is active, explain that the baseline already has no applied disease; do not invent a disease or turn a reference into a supposedly clinically normal patient.

**Authored design policy:** the default comparative step reduces existing normalized `severity` and `contrast` by 20% of their current values. “Healthy”, “remove disease”, and “return to baseline appearance” clear the disease recipe. “Sicker” with no profile requests clarification. These are reversible editor conventions; no medical source establishes a universal 20% healthier morphology. “Healthier but leave the disease unchanged” is contradictory and must not partially apply. “Healthier without changing the size” preserves shape controls, but lowering a disease deformation can itself change the final bounds; the application must describe that distinction or solve the preservation constraint.

An interface interpretation should say, for example, “Reduced the selected disease appearance; kept your shape controls.” It should never say that liver function improved or that a cancer has regressed. Cirrhosis involves tissue damage, fibrosis and impaired function; those are not equivalent to a smoother display surface. [NIDDK: cirrhosis definition and facts](https://www.niddk.nih.gov/health-information/liver-disease/cirrhosis/definition-facts).

## Medical concepts versus renderer capabilities

The local [v2 profile catalog](../../py/viscera_core/disease_profiles_v2.json) contains 71 profiles: 60 enabled outer-surface proxies and 11 reference-only profiles. `severity` is explicitly a normalized synthetic morphology strength, not a clinical stage. The supplied photographs are unpaired contextual references. Several newer phenotypes reuse an organ reference from a different disease; neither the appearance target nor deformation magnitude is a measured patient distribution.

| Language concept | Medical grounding | Appropriate editor interpretation and limit |
| --- | --- | --- |
| Less cirrhotic, less nodular, smoother cirrhotic surface | Cirrhosis is scarring with functional consequences, not simply surface roughness. [NIDDK](https://www.niddk.nih.gov/health-information/liver-disease/cirrhosis/definition-facts) | On `liver-cirrhosis`, reduce the authored nodularity strength. Do not change fibrosis stage, stiffness, portal pressure, or prognosis. “Smoother material” is a separate material operation. |
| Fatty liver, steatotic appearance | Fat accumulation differs from the inflammation and scarring associated with steatohepatitis. [NIDDK research update](https://www.niddk.nih.gov/news/archive/2024/making-new-connections-address-silent-epidemic-nonalcoholic-fatty-liver-disease) | `liver-steatotic-enlargement` is an enlarged, yellow-brown external proxy. It cannot set a histologic fat percentage, diagnose MASLD/MASH, or imply that every fatty liver has that contour. |
| Smaller mass, fewer focal deposits | Tumor size, number, location and spread are distinct staging inputs, assessed with imaging and other clinical information. [NCI: liver cancer diagnosis](https://www.cancer.gov/types/liver/what-is-liver-cancer/diagnosis) | Change normalized `size`, `count` or `spread` on the selected matching recipe. A support radius in the renderer is not a calibrated tumor diameter; “lesion 20 mm” must not silently become an arbitrary normalized number. |
| Less swollen pancreas, less inflamed appearance | Pancreatitis is inflammation; acute and chronic disease differ, and chronic disease may cause lasting damage. [NIDDK: pancreatitis](https://www.niddk.nih.gov/health-information/digestive-diseases/pancreatitis/definition-facts) | With a swelling profile selected, reduce the surface swelling proxy. “Less inflammation” must not automatically substitute a chronic fibrosis recipe or promise treatment response. |
| Kidney with more cysts | PKD involves many kidney cysts and can affect other organs. [NIDDK: PKD](https://www.niddk.nih.gov/health-information/kidney-disease/polycystic-kidney-disease) | `kidney-polycystic` can illustrate external cystic bulges; it does not provide internal cyst segmentation or a patient-specific cyst burden. Preserve the selected laterality. |
| Hydronephrosis | Urinary tract blockage or reflux can be involved in hydronephrosis. [NIDDK: hydronephrosis](https://www.niddk.nih.gov/health-information/urologic-diseases/hydronephrosis-newborns) | Keep `kidney-hydronephrosis` unsupported: there is no segmented collecting system or parenchymal thickness model. Enlarging the entire kidney is not a substitute. The cited source concerns newborns, so its prevalence and prognosis are not adult training labels. |
| Dilated or hypertrophic heart | Ventricular dilation and muscle hypertrophy are different structural changes; restrictive disease can involve stiffness without thickening. [NHLBI: cardiomyopathy types](https://www.nhlbi.nih.gov/health/cardiomyopathy/types) | External envelope presets can illustrate contour differences. They do not set wall thickness, ejection fraction, contractility, pressure, or valve geometry. |
| Edematous, congested, poorly perfused | These terms can describe physiology or different anatomical compartments. Cirrhosis-related edema can refer to legs or feet, while ascites is fluid in the abdomen. [NIDDK](https://www.niddk.nih.gov/health-information/liver-disease/cirrhosis/definition-facts) | Ask which visible feature/profile is intended; do not equate “congested” with a redder material or enlarge every organ. Explicit “redder” is an appearance instruction, not a physiological model. |

Other reference-only features remain unsupported: gallbladder/bladder stones require a lumen; gastric ulcers and colitis pseudopolyps require labeled mucosa; splenic rupture requires topology and tissue failure; bowel obstruction requires lumen, mesentery and contact; valve disease needs annotated leaflets; bronchiectasis needs airway walls; cerebral aneurysms need arterial geometry. These are code/catalog limitations, not claims that the diseases lack visible manifestations.

## Language contract

Use a compact, versioned intermediate plan: `accepted`, `clarify`, or `unsupported`, with a list of typed operations. Distinguish normalized disease controls, physical organ dimensions, shape controls and material controls. Validate the complete plan against the active organ and current profile, then apply it atomically. Unknown clauses, contradictory preservation requirements, impossible numeric values, and unsupported internal structures must not be silently discarded.

Examples of intended distinctions:

- “Make it healthier” on a cirrhosis recipe: lower current disease appearance; same profile and template.
- “Make it healthier and 5% wider”: disease reduction plus a measured width edit, subject to geometry QA.
- “Make the surface less shiny but keep the lesions”: material edit with disease preserved.
- “Make the tumor less irregular”: disease irregularity, not organ asymmetry.
- “20 mm wider” and “width 20 mm”: relative dimension and absolute dimension are different requests; unsupported forms should request clarification rather than reinterpret the unit.
- “Do not make it healthier”: preserve disease, not a positive healthier edit.
- “Reduce cirrhosis to Child-Pugh A”, “restore perfusion”, “perform a wedge resection”: unsupported by this renderer. Never replace these with a visually plausible unrelated edit.

These mappings are product semantics authored for the editor. The medical sources motivate distinctions; they do not provide supervised text-to-mesh labels. No patient records or copied clinical text are required for this dataset.

## Dataset and training design

The earlier `atlas_language.py` dataset creates six compiler-derived utterance families per parent geometry. It explicitly describes itself as compiler distillation, not evidence of understanding unseen anatomy language. More rows from the same six templates cannot establish the requested broader vocabulary.

For the new release, author explicit semantic families and derive varied contexts: active/baseline disease, organ-compatible profile, nonzero/zero/saturated controls, material present/absent, single clauses, composed edits, negation, preservation, conflicts, unsupported anatomy, unit mistakes and ordinary misspellings. Keep the target operation defined independently of the recognizer. Record template/family identity, context identity, source/version, split and expected status. Report both row count and unique semantic/phrase-family count; synthetic examples are not independent surgical cases.

Keep entire phrase families out of training, and keep all near-paraphrases or siblings together. Audit normalized-text collisions across splits. Group-aware splitting is designed to keep declared groups together; its size parameters refer to groups rather than rows. A fixed one-time train/validation/audit partition is preferable to overlapping repeated test folds for release reporting. [scikit-learn: GroupShuffleSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupShuffleSplit.html).

The existing pinned Qwen2.5-0.5B-Instruct base is a reasonable low-resource starting point because its publisher explicitly targets instruction following and JSON generation. This is a model choice to test, not evidence of anatomy competence. Retain the exact base revision and tokenizer/chat template in the release. [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct).

Train compact JSON completions with loss on assistant output only, checking that input/padding tokens are masked and that no target is truncated. TRL supports conversational prompt/completion datasets and completion-only loss; assistant-only masking additionally depends on the chat template. Use actual generated predictions for validation rather than teacher-forced token accuracy alone. [TRL SFT documentation](https://huggingface.co/docs/trl/en/sft_trainer).

LoRA adapters allow a smaller trainable artifact. If using 4-bit QLoRA on a supported GPU, prepare the quantized model for training and choose the compute dtype supported by the hardware. PEFT documents NF4, nested quantization and all-linear adapter targets. A small model may fit ordinary LoRA; select the least complex tested path, with an explicit CPU smoke path rather than assuming CUDA is present. [PEFT quantization guide](https://huggingface.co/docs/peft/en/developer_guides/quantization).

## Evaluation and release claims

The challenge fixture contains 81 examples across 43 families and all 12 catalog organ categories: 41 accepted, 30 unsupported and 10 clarification targets. It is independently authored by the research agent, without calling the parser to generate its labels. It is synthetic, not clinician reviewed and not evidence of clinical validity. Keep it outside train and validation; retain every failure. Once its outputs are used to fix the implementation, it becomes a regression set and a fresh untouched set is needed for a new generalization claim. Do not relabel difficult cases to make a model pass. Operation order and explanatory prose are not semantic labels; compare normalized operations and check the separately recorded invariants.

**Pre-prediction contract revision 1.1:** the original 80-case fixture SHA256 was `98e03b5d46ec31e44142e1666ffd36a1e20f5d5aa1d091982b4b446ac6ef3ed0`. An independent geometry check found that absolute dimensions were fitted before disease deformation: a requested 247.1075 mm liver width became 275.3323 mm with active steatotic enlargement. The contract therefore requires clarification for absolute dimensions while a disease is active. Case 073 now supplies a baseline context for its unchanged absolute-width intent; case 081 adds the same wording with active disease and an expected clarification. This deliberate context counterfactual was authored before any model predictions. Other labels remain unchanged. This change records a verified renderer limitation, not a correction chosen to improve model scores.

Revision 1.1 SHA256: `44477cdd432a3c1018680f652fdc427cd8257fb9a78d740dcfdf0f97d6c2657c`.

Measure valid JSON/schema rate, three-way status accuracy, exact normalized operation accuracy, false accepts on unsupported/ambiguous inputs, numeric/unit accuracy, profile/organ compatibility, preservation of unspecified fields and all-or-nothing behavior. Report each category and organ with numerator/denominator; aggregate accuracy can hide dangerous failures. Compare against the existing compiler and the untuned base on identical prompts.

The release should bind adapter, base revision, semantic contract, dataset manifest, generated-prediction metrics and QA results by hashes. Validate the exported adapter after reloading it. A short local training smoke test establishes executable code and a real gradient update; it does not establish the quality of the future full Colab run. Automatic integration must reject corrupt, incompatible, or failed-evaluation bundles and preserve the previously active model. These are engineering acceptance policies, not guarantees from the cited sources.
