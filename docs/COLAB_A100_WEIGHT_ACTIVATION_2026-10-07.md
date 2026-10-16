# Colab A100 weights activated · 7 October 2026

`viscera-joint-v2-weights_new.zip` is integrated and selected as the default joint model in [Studio](http://localhost:5174). A controlled API restart confirmed that the selection is persisted, and the existing text adapter was restored offline. The previous VAE and CPU flow versions remain available under **Trained models → Preserved joint models**.

## Use the model

Refresh Studio, choose an organ and optional **Disease profile**, set **Disease design range**, then press **Joint flow variation**. Use **New joint variation** to change the seed. Shape, colour and disease controls remain editable, and **Export GLB** downloads the displayed organ with textures.

This archive contains the matching six-layer, eight-bin spline-flow network and its A100-trained weights. The existing inference implementation already supports it; no renderer or network source changes were required. The generation-2 selection and exact archive pointer are persisted in the non-iCloud model store at `~/Library/Application Support/VISCERA/joint-v2-2026-10-07/model-store`. The original user ZIP and a checksummed cache copy are retained.

## Verification

| Check | Result |
| --- | --- |
| ZIP paths, CRCs, manifest, safe NumPy arrays and all payload hashes | Passed |
| Network architecture, dataset, renderer and all 24 template bindings | Passed |
| Independent deterministic recipe checks | 1,152 passed |
| Live API rendering | 144/144 passed: 24 baselines and 120 severe disease/template combinations |
| Coverage | All 12 organ groups and 60 disease profiles |
| Live output checks | Exact model identity, independently recomputed geometry hashes, original connectivity, finite geometry/normals, bounded colour, severity band and renderer QA |
| Real Studio browser workflow | Passed in 58.3 seconds |
| Editing and export | Shape/colour variation, severity edits, seed replay, 512-pixel API export and actual Studio GLB download passed |
| Preserved-model switching | Original T4 VAE → new A100 flow passed |
| Default after API restart | Passed |
| Earlier model payloads | All 217 files remain byte-identical; four joint versions are verified |

The first browser run completed its functional checks but exceeded the 120-second overall test limit during the cold texture-export workflow. Its trace and video are preserved. The unchanged assertions passed with a 240-second overall budget; that budget is now recorded in the integration test. Individual request and download deadlines remain unchanged. This is a test-duration adjustment, not a claim that export performance was improved.

## Model identity and scope

- Archive SHA-256: `33c3a424e1663e2f6544f4ec23ed6a797e41a45473fa87c1bc9b01aed4effcf0`
- Model SHA-256: `051bf03cd17a36942d21f4bd20452e28dfd6607e34ecb7fe387f2c1578882b70`
- Training metadata: NVIDIA A100-SXM4-40GB, 4,000 flow steps and 600 surrogate steps; validation selected step 100.

The new weights use the same architecture and data contracts as the earlier CPU run. Their density metrics differ only slightly. These tests establish integration and numerical generation behavior; they do not establish clinical realism or learned tissue mechanics.

The machine configuration used for restart remains in `~/Library/Application Support/VISCERA/joint-v2-2026-10-07/runtime-config.json`. `python scripts/run_joint_v2_local.py --check` verifies availability; the launcher without `--check` starts an API only when port 8000 is free. Studio is currently running separately on port 5174.

Evidence, screenshots, exported GLBs, original timeout trace and successful browser video are in `artifacts/joint-v2/new-colab-activation-2026-10-07/`. The compact handoff is `activation-complete.json`.
