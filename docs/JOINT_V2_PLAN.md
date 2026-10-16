# Expanded disease generation release — iteration contract

Date: 7 October 2026. Owner: project user; implementation: Codex.

Goal: a separately versioned, larger paired dataset and advanced conditional model that produces stronger editable organ geometry, appearance and disease variation, with a Run All Colab release and reversible Studio activation.

Current baseline: joint CVAE v1 trained on 7,104 authored examples, 24 reference templates, 25 disease profiles, 128 corresponding anchors. Active Colab archive `524a2c3c17003fefee14bf9eccf244adbc9076b44a23a1554ebec9e424cc60ca` must remain recoverable. Four existing exported archives and registry pointers have been checksum-preserved before changes.

Hypotheses: explicit severity strata and broader spatial sampling improve coverage; a richer conditional distribution can avoid the v1 Gaussian prior's marginal underfit; denser regional observations improve validation of local disease effects. More parameters or synthetic examples alone do not establish anatomical realism.

Data contract: retain exact source licences and hashes; distinguish independent specimens, atlas templates and synthetic derivatives; group synthetic families across all disease and severity derivatives into one split. Photographic RGB is not albedo. Unpaired photos cannot supply registered mesh colour targets. Disease evidence must be mapped to its actual visual role, including internal findings that cannot be represented on an external surface.

Target release: at least eight times v1's sample count, broader supported disease patterns, stronger authored severity strata, source-derived reference evidence, complete replay metadata, and separate immutable baseline/disease/evidence archives. Final counts depend on passing data QA, and will be reported exactly.

Guardrails: no modification of frozen v1 renderer or decoder bytes; versioned v2 recipe routing; finite geometry and bounded material fields; disjoint family assignments; checksummed packages and safe NumPy model loading; exact training/inference parity; all-condition real-renderer audit; deterministic same-seed replay, inter-seed diversity and editable textured export.

Evaluation: compare per-condition and per-severity control distributions, covariance, diversity and region observations against a simple baseline and v1 where conditions overlap. Select configurations on validation only; record audit metrics without concealing regressions. Numerical QA is not medical validation.

Delivery: upload immutable files to a new private Drive folder, verify notebook bootstrapping and full export locally, attempt the requested Google Colab A100 run through its UI, retain old models and activate only a verified completed artifact. A100 availability and Google authorization are external dependencies. No purchase, public sharing or credential changes are authorized by this work.

References: [Neural Spline Flows](https://arxiv.org/abs/1906.04032), [Flow Matching](https://arxiv.org/abs/2210.02747), [Google Colab FAQ](https://research.google.com/colaboratory/faq.html).
