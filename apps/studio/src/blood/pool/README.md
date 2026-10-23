# Blood pool — heightfield surface model

Workspace: `?mode=blood&flow=pool`. A thin layer of collected blood in a
stainless tray; drops fall into it and a blunt probe can be moved through it.
WebGPU compute + render, with an FP32/FP64 CPU reference of the same kernel.

## Equations

Linear shallow water over a flat floor with linear bottom friction λ:

```
u_t = −g∇η − λu,   η_t = −H∇·u   ⇒   η_tt + λη_t = gH∇²η
```

State is nondimensional: `h = η/H`, `w = Δt·η_t/H`. One step:

```
w ← w + C²(h_E + h_W + h_N + h_S − 4h)
w ← w·(1 − λΔt)        (exp form for large λΔt)
h ← h + w
```

This is the upstream webgpu-water update rewritten as symplectic Euler.
`dx = L/n`, `c = √(gH)`, `Δt = C·dx/c`.

Friction options (`PoolConfig.damping`):

- `laminar` — Poiseuille-profile value `λ = 3ν/H²` (low-frequency limit).
- `stokes-drop-scale` (default) — oscillatory Stokes layer
  `λ = √(νω/2)/H` at the drop-footprint wavelength `4·R_dep`,
  `R_dep = max(3·r_drop, 3·dx)`.

## Stability correction

The upstream constant is C² = 0.5, the exact von Neumann boundary of the 2D
five-point scheme. There the checkerboard mode is marginal and grows linearly
with round-off; upstream hid this with numerical damping. `MAX_COURANT_SQUARED
= 0.45`; `model.test.ts` reproduces the growth at 0.5 and its absence at 0.45.

## Conservation

- Drops add the Tate's-law volume `V = 2πrσ/(ρg)` (`r` = 0.5 mm contact) through a
  raised-cosine footprint normalised on the discrete grid.
- The probe sphere displaces exactly the change in its submerged per-cell chord
  (2×2 supersampled), sub-stepped to ≤ 0.12 m/s.
- GPU readbacks every 400 ms report relative volume error and peak |h|; the run
  halts at |h| > 0.9 (outside linear theory) or non-finite state.
- "Run GPU/CPU parity check" runs a deterministic two-drop fixture for 240 steps on
  both backends; pass threshold is 1e-3 of peak.

## Optics

Fresnel reflection at n = 1.35; transmitted light uses the shared spectral blood
slab (`experiments/bloodAppearanceOptics`) baked into a 96-row R/T LUT, with
dilution mapped to an equivalent whole-blood thickness `φ·d`. Caustics use the
upstream refracted-area ratio. The environment (lamp disc, two softboxes) is
authored, not measured.

## Validity indicators (`poolValidity`)

Reported at the drop-footprint wavelength, as engineering indicators:
finite-depth dispersion ratio `ω_exact/ω_SW`, capillary-to-gravity ratio
`σk²/(ρg)`, Stokes-layer thickness vs depth, and peak elevation vs depth.

## Not modelled

Capillary waves, dispersion, nonlinear steepening, impact momentum, crowns and
splash, wetting/meniscus, coagulation, non-Newtonian rheology, calibrated camera
response. This is a visual-surface model with conserved volume, not a validated
haemodynamic model.

## Tests

`npx vitest run apps/studio/src/blood/pool` — scheme derivation, config limits,
exact deposit and probe volumes, discrete dispersion vs analytic mode frequency,
damping rate, stability boundary, optics LUT monotonicity.

Attribution: see [THIRD_PARTY_NOTICE.md](./THIRD_PARTY_NOTICE.md).
