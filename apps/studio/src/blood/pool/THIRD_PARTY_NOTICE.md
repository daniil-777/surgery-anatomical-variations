# Third-party notice — Blood pool workspace

The blood pool workspace (`apps/studio/src/blood/pool/`) adapts techniques from:

- **jeantimex/webgpu-water** — https://github.com/jeantimex/webgpu-water
  (reviewed at commit `59d680ce4d39d62758fb10820dc754adedf622c9`), itself a WebGPU
  port of **Evan Wallace's WebGL Water** (https://madebyevan.com/webgl-water/).

## What was adapted

| Upstream technique | Where it lives here | Change |
| --- | --- | --- |
| Heightfield wave update (neighbour average, velocity damping) | `model.ts` `stepPool`, `shaders.ts` `SIM_WGSL` | Re-derived as the symplectic-Euler discretisation of the damped linear shallow-water equation; Courant number and damping now come from SI depth, grid spacing and blood viscosity. C² capped at 0.45 (upstream 0.5 is the marginal stability boundary). |
| Raised-cosine drop profile | `model.ts` `depositAmplitude`, `DEPOSIT_WGSL` | Discretely normalised so each drop adds exactly its Tate's-law volume. |
| Sphere displacement | `model.ts` `applyInstrumentMove` | Exact submerged-chord volume change per cell (2×2 supersampled), sub-stepped motion. |
| Caustics by refracted-area ratio | `shaders.ts` `CAUSTIC_WGSL` | Rendered into an `rgba16float` target, attenuated by the blood slab. |
| Ray-traced Fresnel surface | `shaders.ts` `SURFACE_RENDER_WGSL` | n = 1.35, spectral blood slab optics, procedural operating-room environment; no textures or cubemap from upstream are shipped. |

No upstream source file is copied verbatim; the code was rewritten in this
repository's style. The licence is reproduced because the algorithms and shader
structure are derived works.

## Licence (upstream)

```
MIT License

Copyright (c) 2026 Su

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
