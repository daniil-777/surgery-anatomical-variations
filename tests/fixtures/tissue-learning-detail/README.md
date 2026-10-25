This is a **synthetic engineering fixture**, exported after three actual CPU training updates. It is not a trained surgical appearance model and provides no visual-quality evidence.

The v2 decoder has 64 latent components, three hidden layers of width 160, 24 directional integer Fourier vectors and two synthetic conditions. Its training-only critic is absent from the artifact. The embedded decoder values come from the actual PyTorch forward pass; the embedded latent reference uses the maximum uint64 seed.

Artifact SHA256: `64ab4393549e8a8741bcf6277b6905622b712db08fa2aaf4227ed8a99bc68b6a`.

Original export evidence is retained in `artifacts/tissue-colab-2026-10-19/detail-candidate/engineering-fixture/`. The original v1 fixture and imported real-data v1 model remain separate.
