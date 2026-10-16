# Code review and improvements

The review fixed concrete failure paths in editing, imports, persistence, API validation and model training. The procedural decoder and published model weights remain unchanged. The new PDF inspects the resulting assets without claiming that software verification establishes anatomical realism.

| Issue | Change and regression evidence |
|---|---|
| Delayed generation or text requests could replace newer edits | Responses are bound to the requesting state; browser tests delay requests and verify subsequent changes survive |
| Import failures could mutate history; undo lost appearance, visibility and locks | Validate before commit; history captures the complete editable state; imported topology and attributes replace old buffers even when their lengths match |
| Unsupported vessel controls appeared editable | Unsupported controls are disabled; export copies are disposed after GLB creation |
| Uploads could preserve stale derived anatomy or overflow face indices | Check containers, indices, attributes, units and resolution before conversion; recompute normals and invalidate derived fields unless geometry matches trusted or reconstructed original arrays |
| Oversized bodies were buffered before checking; non-finite validation errors caused HTTP 500 | Bound request streaming and serialize validation errors safely; malformed requests receive explicit 4xx responses |
| Compiler operations could violate combined wall/radius constraints or select the wrong family | Validate the complete candidate spec and organ-qualified intent atomically |
| Existing dataset releases could be silently regenerated | Verify the recipe, artifact hashes, card and candidate ledger, then return the existing release unchanged; corrupt artifacts remain untouched for inspection |
| Simulation snapshots omitted active grabs and rejection history | Save complete replay state, bind it to the reference mesh/supports/options, and validate restored support positions; reject non-finite derived state without advancing time |
| Training and evaluation could mix feature order, releases or runtime identity | Validate feature labels, row identities, data-release identity, finite conditions and resolved resume environment |
| Language checkpoints could be overwritten or evaluated with altered adapter files | Require explicit resume, verify adapter/tokenizer hashes and complete training state; interrupted tiny-model training reproduces uninterrupted weights |
| Colab ZIP integrity and local subprocess imports were incomplete | Verify every manifest hash and archive path before extraction; propagate source paths and terminate child training on interruption |

## Measured checks

- 116 Python tests passed in 39.88 seconds; no skips or failures. One existing Starlette/httpx deprecation warning remains.
- 21 TypeScript unit tests and 9 real browser tests passed.
- Ruff, strict mypy across 16 source files, strict TypeScript and production build passed.
- Shape notebook: all 9 code cells passed locally on CPU in 34.46 seconds. Its smoke run uses 40 optimizer steps; it does not replace the published 600-step model.
- Actual editor probe: minimum Jacobian 0.97379, maximum volume drift 0.04699%, zero rejected steps and 0.51819 mm terminal displacement. The preview uses heuristic XPBD mechanics.

Raw logs, JUnit, browser evidence and the recording are under `benchmarks/results/code-review-2026-10-06/`. The production build retains Vite's advisory about the main JavaScript chunk exceeding 500 kB; its measured gzip size is 246.62 kB.

## Artifact compatibility

The trainer source changed. Existing weights remain inference-compatible because the procedural decoder is unchanged, but resuming an old checkpoint requires its original trainer source. Both original Colab archives are retained under `artifacts/colab/*-before-code-review.zip`; their embedded trainer hash matches the published model. The current archives include the corrected workflow. No historical evaluation has been relabeled as a result from the changed trainer.

## Visual report

`reports/VISCERA Organ Realism Review 2026-10-06.pdf` at the repository root contains 12 pages and 37 unique images. Dedicated renders use actual source geometry, orthographic cameras and physical scale bars; editor screenshots retain the editor camera. It shows smooth, stylized surfaces, simplified cavities and schematic vessels candidly. Independent anatomical review and measured tissue/optical evidence remain absent.
