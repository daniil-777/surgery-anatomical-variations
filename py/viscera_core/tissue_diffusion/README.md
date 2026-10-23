# Optional pretrained PBR pilot

This isolated adapter evaluates **gvecchio/StableMaterials**, the released
general-domain material diffusion model. It does not retrain a network or claim
that the checkpoint has learned anatomical tissue. No model is automatically
enabled in Studio or included in a public deployment.

Author sources: [model card](https://huggingface.co/gvecchio/StableMaterials),
[paper](https://arxiv.org/abs/2406.09293), and the [exact reviewed pipeline](https://huggingface.co/gvecchio/StableMaterials/blob/4d452731535bd5c74261d6645623a573326f6f36/pipeline.py).

## Reviewed source and download

The immutable revision is `4d452731535bd5c74261d6645623a573326f6f36`.
`pipeline.py` is 36,317 bytes; SHA256 is
`0e0a5cd721d4abadd2ceb2e46fc3ee876b93e720fb63caf8bb74784ede5a55be`.
The standard text-only selection totals **4,272,253,380 bytes**. The omitted
LCM UNet and vision encoder are not needed for this route. A nonempty textual
negative prompt is mandatory because the upstream default negative condition
uses its vision encoder. All selected tensors are safetensors. The lock records
every file size and hash; inference verifies the whole snapshot before importing
the exact reviewed custom Python file. No `trust_remote_code` loader is used.

The source review found no shell, network or file-writing operations in the
custom pipeline. It does temporarily patch Torch convolution and transformer
classes for feature rolling, without upstream `finally` cleanup. The adapter
therefore runs in a standalone serial process and restores those classes and
the global CPU RNG even after an exception. It seeds both the dedicated latent
generator and the global RNG used by feature rolling. This supports same-runtime
replay, not cross-device bitwise determinism.

The published repository declares only an `openrail` model-card tag and contains
no full license file. That uncertainty is retained in the receipts. Do not label
the model MIT, infer unrestricted redistribution, or ship its weights in a
public static site. The full paper's high-resolution refiner is not in this
released checkpoint. Its real base prediction is **512 × 512**.

## Run

Use a fresh external directory. First inspect `plan`; downloading is explicit:

```sh
.venv/bin/python scripts/generate_tissue_pbr_diffusion.py plan
.venv/bin/python scripts/generate_tissue_pbr_diffusion.py download \
  --snapshot /external/stablematerials-4d452731 --allow-weights
PYTHONPATH=/private/tmp/viscera-tissue-diffusion-deps:py .venv/bin/python \
  scripts/generate_tissue_pbr_diffusion.py sample \
  --snapshot /external/stablematerials-4d452731 \
  --output /external/review/liver42 --device mps --steps 20 --seed 42
```

The optional additional package is `diffusers==0.35.1`. Keep a dedicated
environment or isolated package target rather than replacing the application's
Torch stack. CUDA uses float16; Metal and CPU use float32. There is no automatic
device fallback. The A100 notebook supplies a separately pinned CUDA profile;
its pinned environment is not evidence of an executed A100 run.

## Output and limits

The run retains raw predicted basecolor, normal, height, roughness and metallic
maps. Model output is checked for shapes, finite ranges and degenerate color.
`diagnostics.json` reports seam differences and distribution summaries without
claiming that such statistics establish realism.

The review-only tissue manifest maps generated basecolor/roughness into the
existing material contract. The mesh remains an opaque dielectric; generated
metalness is retained only in `raw/`. Because the pipeline's tangent normal
convention is not established by its source, the active OpenGL normal is derived
from the generated relative height using a declared, **authored** millimetre
scale. Neither its height amplitude nor the constant 1 mm thickness placeholder
is an anatomical measurement. Raw predicted normal is preserved for inspection.

The model cannot separate generated vessels/fascia/adipose into semantic layers.
Their contract overlays are therefore transparent and the added wet film is
disabled, rather than inventing learned layer separation. `*.tissue-pbr.json`
bundles only data: the material manifest and its 12 unique PNG files with hashes.
No model weights or Python executable code enter Studio. Raw predictions and
the inference receipt remain in the complete local review directory.

Import success and deterministic seeds do not establish tissue realism.
Compare several seeds and regions with suitable references, review light and
camera motion, reject nonbiological patterns or exaggerated relief, and leave
failed samples available. A pilot has no automatic production promotion step.

Focused software checks:
`.venv/bin/python -m pytest tests/python/test_tissue_diffusion.py -q`.
