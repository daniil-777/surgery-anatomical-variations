# Existing learning implementation audit

The existing tissue pipeline has completed exterior-tissue adapters and verified
512-pixel preview assets. Its preprocessing excludes dominant illumination and
saturated highlights. Those albedo-oriented crops therefore cannot provide the
separate wet optical boundary or blood-film thickness required in the scene.

The local Python/PyTorch runtime and Metal backend were verified with a small
tensor computation. Completed training receipts and checkpoints were inspected;
no additional neural retraining was performed in this revision. A previous
small-VAE path produced blur and lattice artifacts, so it was not adopted.

This release adds a bounded, reproducible statistical appearance fit instead.
See [fitting.md](fitting.md), [model.json](model.json), and
[fit-report.json](fit-report.json). The complete machine-specific audit is retained
with the local downloaded-data and review artifacts.
