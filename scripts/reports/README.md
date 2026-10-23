# Reproduce the organ review PDF

These scripts inspect actual generated assets. They do not modify the frozen geometry, dataset releases or model weights. The output date identifies this review snapshot, not a claim that later runs reproduce a historical editor state.

From `viscera/`, with the Studio running on port 5174:

```sh
PYTHONPATH=py .venv/bin/python scripts/reports/prepare_visual_review.py
node scripts/reports/render_visual_review.mjs
node benchmarks/record-editor.mjs --output-dir benchmarks/results/code-review-2026-10-06
uv run --no-project --with reportlab==5.0.1 --with pymupdf==1.28.2 python scripts/reports/build_visual_review.py
```

Use Node 24 and the pinned project Python environment. PDF-only packages are supplied by an isolated `uv run --with` environment. Outputs go to the repository's `reports/` directory. The main PDF includes six-direction views, isolated organs, an uncapped lumen cutaway, stored dataset examples at fixed scale, controlled changes, mesh/material comparisons, and actual probe frames. `sources.json`, `renders.json` and `report-manifest.json` record input geometry, camera settings and file hashes. Page PNGs support visual layout review.

The scientific scope is a visual engineering review of one unreviewed construction lineage. Image appearance cannot establish anatomical or tissue validity.
