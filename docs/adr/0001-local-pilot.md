# 0001 — Implement a local anatomy workflow before hosted infrastructure

Status: accepted for the current implementation by the autonomous development mandate.

The user prioritizes detailed organs, physically plausible behavior, strong geometry controls, sensitive variations and text-to-3D. Start with an executable original liver/gallbladder authoring workflow, dataset and Colab training, so quality can be inspected end to end.

The procedural construction is one authored lineage. Its variations are synthetic design samples, not independent people or reviewed anatomy. The versioned `PilotSceneSpec` (0.1.0) is a strict executable subset with eight shape controls. It deliberately does not claim to implement the broader planned `OrganSceneSpec` v2, diagnostic labels or unsupported organs. `GET /api/schema` exports the implemented contract.

Use a local FastAPI service and content-addressed SQLite snapshots. Each project commit compares the expected revision atomically. Keep service binding on localhost. Hosted authentication, organization billing, distributed queues and external deployment follow a validated local workflow; no external accounts or paid resources are needed.

Studio starts with a tested WebGL2 renderer and physically based materials. This is an explicit deviation from the planned WebGPU renderer until node-material, interaction and fallback parity are measured. No WebGPU performance is claimed. Browser surface manipulation is identified as an interaction preview; a separate numerical tetrahedral mechanics oracle verifies constitutive behavior, and neither is labeled measured human tissue.

Use the installed Node 24 runtime (minimum 22) and Python 3.11. Dependency lockfiles bind the tested versions. UI uses React, Three.js and plain CSS, with local fonts. A real trained compact conditional shape model and baselines are evaluated separately from the deterministic procedural generator; the UI must identify the selected source.

Unknown anatomy and empirical evidence remain unavailable rather than invented. Implementation status for every prompt is recorded in the acceptance ledger with actual artifacts and tests.
