# Joint VAE weights in Studio

The new joint model samples organ shape, continuous tissue appearance and the
selected disease together. One latent sample drives all three decoder heads.
Studio realizes the returned editable recipe on the exact anatomical reference
used during dataset creation. It does not switch to the original ridge models.

Studio includes a validated full V1 checkpoint. **Joint VAE variation** is
available on a fresh local installation without training or importing weights.

1. Select an organ and reference. In **Disease**, select a supported profile,
   or **Baseline · no disease modifier** for a disease-free specimen.
2. In **Joint shape + color VAE**, enter a **Joint variation seed** and choose
   **Joint variation temperature**. Click **Joint VAE variation**.
3. Click **New joint variation** to choose and sample a fresh seed. The same
   reference, disease profile, seed, temperature and weights reproduce the same
   recipe. Higher temperature explores more of the learned latent distribution;
   it does not expand the renderer's supported control bounds.
4. Continue editing with the Shape, Surface and Disease controls. Export GLB
  to download the displayed mesh with baked PBR textures and its exact recipe.

To use a newly trained checkpoint, run the **Joint VAE Colab** notebook and
download `viscera-joint-weights.zip`. In **Trained models**, choose the ZIP and
**Validate & activate**. Explicitly imported V1 or V2 weights take precedence.

Joint sampling uses Tissue appearance so the learned color changes are visible.
It replaces the shape, surface and disease controls together. The existing
shape-only **Keep overall dimensions** option does not apply to joint sampling.
Disease intensity is a synthetic morphology control, not clinical staging.

## Compatibility and persistence

Joint weights use a separate active registry pointer. Importing them preserves
the existing `viscera-final-weights.zip` models and optional text adapter.
Importing an original bundle also preserves the joint VAE. The model panel shows
separate checksums. **Restore defaults** returns joint sampling to the bundled
V1 checkpoint while retaining imported models on disk.

The packaged archive is `artifacts/joint-vae/default/viscera-joint-weights.zip`,
SHA-256 `524a2c3c17003fefee14bf9eccf244adbc9076b44a23a1554ebec9e424cc60ca`.
Deployments can set `VISCERA_JOINT_DEFAULT_WEIGHTS` to another compatible full
V1 archive. Defaults pass the same complete validation as manual imports before
use, with no weakened provenance checks. The first request installs the inert
files into the model store without overwriting the user's selection; subsequent
requests verify the archive, retained artifacts and renderer again. A configured
archive that is missing or invalid fails clearly. A minimal source-only bundle
without the default archive continues to offer manual import.

The downloaded joint archive contains NumPy deployment tensors, model metadata,
dataset release snapshots and reports. Serving requires no PyTorch or GPU.
Import validates archive paths and size, every artifact hash, completed full
training (at least 1,000 VAE and 200 surrogate steps), both dataset identities,
all renderer sources, the joint decoder, every trained reference mesh and its
metadata, and a valid sampled recipe for every condition. A passed full
exact-renderer audit must be bound to the same model hash and cover every
condition. Smoke bundles are rejected. A failed validation preserves the
previous weights. The larger training datasets do not need to be installed on
the Studio computer.

`POST /api/atlas/sample-joint` accepts:

```json
{
  "spec": {
    "template_id": "hra-liver-male",
    "seed": 42,
    "controls": {},
    "appearance": "tissue"
  },
  "seed": 42,
  "temperature": 1.0
}
```

For disease-conditioned generation, include a valid `spec.disease` recipe.
Temperature is a finite number in `[0.2, 1.5]`; seed is an unsigned 32-bit integer.
The response contains the standard `spec`, `scene` and `summary` objects plus
`summary.joint_model` with the exact model and bundle hashes, requested
condition, seed, temperature and realized appearance/disease spatial seeds.
Requests for an unsupported reference/profile pair fail without applying edits.

## Scope

The model learns a coupled **synthetic design distribution** from authored
variations and rendered observations. The reference meshes retain their source
topology; the VAE predicts bounded controls rather than unrestricted new mesh
topologies. It does not establish population anatomy, measured tissue color,
clinical disease realism, tissue mechanics or surgical safety. Independent
anatomical, optical and physical measurements remain necessary for those claims.

## Integration checks

```bash
python -m pytest tests/python/test_joint_default.py tests/python/test_atlas_joint_integration.py tests/python/test_atlas_model_registry.py
node node_modules/vitest/vitest.mjs run apps/studio/src/atlasJoint.test.ts
VISCERA_STUDIO_URL=http://127.0.0.1:5174 node node_modules/@playwright/test/cli.js test --config playwright.joint.config.ts
```

The browser contract tests exercise import and default restoration, baseline
and disease sampling, seed replay, continued editing/export, and rejection of
incorrect response provenance. The actual trained artifact must additionally
pass the full release evaluation and real Studio integration checks.

Default deployment and live browser evidence: [2026-10-07 verification](../benchmarks/results/default-models-2026-10-07/README.md).
