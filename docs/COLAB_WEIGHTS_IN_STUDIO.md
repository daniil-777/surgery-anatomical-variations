# Use Colab weights in Studio

Finish the notebook's **full** training run and download `viscera-final-weights.zip`. Keep the matching final dataset bundle installed locally: weights alone do not contain the reference meshes, procedural decoders or training releases required for inference.

1. Open Atlas Studio and choose **Trained models** in the header.
2. Select the ZIP, then choose **Validate & activate**.
3. Check the active model methods and bundle checksum. Shape, material and disease models activate together after every check succeeds.
4. Use **Learned variation** in Shape, the learned surface sampler in Surface, or **Learned disease variation** in Disease. A parameter slider and the procedural **Generate variation** action still use the recorded explicit recipe; importing weights does not replace those controls.

If the archive includes the optional language adapter, choose **Enable text adapter (downloads base model)**. This explicit action may download the pinned Qwen base model and load it into memory. The text box then offers **Use trained text adapter** for supported shape instructions. The adapter proposes an edit, and the deterministic compiler must approve the exact result before it can apply. Existing surface and disease recipes are preserved on same-reference shape edits. Unsupported appearance/disease instructions or a rejected proposal leave the organ unchanged; switch off the checkbox to use the standard compiler. After an API restart, reopen Trained models and enable the adapter again. Studio checks the actual loaded cache, so a persisted enable flag cannot falsely claim that the model is ready.

**Observed clinical cases** opens a read-only group selector and retrieval result from the imported clinical prior. It reports measured organ/lesion volumes and the number of observed training patients. It does not replace or deform the procedural editor organ and does not invent a population distribution.

Opening or refreshing Trained models preserves your text-adapter checkbox choice. Reloading the page starts with the standard compiler selected; the loaded adapter remains available through the checkbox. Explicitly enabling the adapter selects it for that editing session. Rendered geometry identifiers are cleared from model inputs because they describe the previous mesh, while all anatomical controls and compiler checks remain intact.

The currently displayed organ stays unchanged on import. Its export remains bound to that displayed recipe. The next learned sample uses the active weights. **Restore defaults** switches back to the original configured models without deleting imported bundles. If default weights are absent, the panel reports them unavailable; import a compatible full-run archive first. A corrupted active registry can also be recovered with Restore defaults.

The local API exposes:

| Request | Behavior |
|---|---|
| `GET /api/atlas/models` | Active source, bundle checksum, per-model status and scope |
| `POST /api/atlas/models/import` | Raw ZIP body with `Content-Type: application/zip`; validate, then activate atomically |
| `POST /api/atlas/models/defaults` | JSON body `{}` with `Content-Type: application/json`; restore configured defaults |
| `POST /api/atlas/models/language/enable` | JSON `{"allow_model_download":true}`; explicitly load the pinned base and imported research adapter |
| `POST /api/atlas/compile` | Set `use_trained_language:true` only after enablement; compilation never starts a model download |
| `POST /api/atlas/models/clinical/sample` | JSON `organ`, `disease_code`, optional uint32 `seed`; retrieve one observed training case |

Uploads are streamed to temporary disk storage, limited to 128 MiB compressed and 512 MiB expanded. Import rejects smoke runs, path traversal, duplicate members, links, unmanifested files, unsafe NumPy arrays, changed model checksums, incompatible source code, missing model vocabulary, and dataset/template mismatches. PyTorch checkpoints use `weights_only=True` on CPU. Import never runs Python or tokenizer templates from the ZIP and never downloads a language base model. This is a local importer for your own Colab training outputs, not a remotely exposed model sandbox.

Validated bundles and the atomic activation pointer are stored under `data/imported-models/`, or `VISCERA_MODEL_STORE` when configured. The original releases and packaged model files remain untouched. Atlas uses `datasets/atlas/cohort-v2/templates` by default; `VISCERA_ATLAS_TEMPLATES` can select a compatible installed library. Existing model/dataset environment variables continue to configure the default lane and exact dataset dependencies.

The imported models learn bounded synthetic geometry, appearance and disease recipes. The clinical prior serves observed-case retrieval and does not become an editor generator. A supplied language adapter remains a research proposal model behind the deterministic compiler guard. No patient population distribution, calibrated material stiffness or surgical contact mechanics is inferred by this import.

The local `pnpm api` command includes the `train`, `disease-data` and `language` Python extras. For manual setup use `uv sync --extra train --extra disease-data --extra language`; installing these libraries does not download the language base weights. The API reports an actionable dependency error if language libraries are absent when enablement is requested.

Validation: archive rejection and rollback tests; real final ZIP import plus all three inference routes; post-import corruption refusal; browser tests for activation, restore, error recovery, busy-state focus containment and mobile layout. Optional real-archive integration runs with `VISCERA_TEST_WEIGHTS=/path/to/viscera-final-weights.zip PYTHONPATH=py python -m pytest tests/python/test_atlas_model_registry.py`.
