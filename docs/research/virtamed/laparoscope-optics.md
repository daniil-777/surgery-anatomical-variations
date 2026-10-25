# Laparoscope illumination and wet surface refinement

2026-10-25. This pass adds camera-mounted illumination, cast shadows, wet highlights and optical glare to the existing registered scene. It does not claim calibrated device photometry or surgeon validation.

## Evidence and design

- [Modrzejewski et al., Light Modelling and Calibration in Laparoscopy (2020), author manuscript](https://www.richardmodrzejewski.com/pdf/Light%20Modelling%20and%20Calibration%20in%20Laparoscopy.pdf): illumination, reflectance and camera response must be treated separately. The source position matters; a calibrated simple spotlight performed well against more complex models. The paper's spotlight model uses inverse-square falloff and exponential angular attenuation. We implement that model with two authored aperture samples to support partial instrument occlusion. The offsets and weights are engineering choices, not recovered device calibration.
- [Closed Contour Specular Reflection Segmentation in Laparoscopic Images (2013)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3747397/): wet tissue produces localized bright specular regions whose locations depend on light, surface normal and viewing direction. We generate these through the material BRDF, rather than storing white highlights in texture images.
- [Filament's physically based rendering reference](https://google.github.io/filament/main/filament.html): a separate dielectric film lobe and linear-light calculations provide a useful real-time implementation model. Our implementation uses Three's GGX material, overrides the film's normal-incidence reflectance for an assumed aqueous IOR, and applies the display transform only after the HDR glare pass.
- [Dresden Surgical Anatomy Dataset](https://pmc.ncbi.nlm.nih.gov/articles/PMC9837071/): re-inspected the existing 25/47 bowel/fat image. The supplied simulation video at 00:08 and the existing CholecSeg gallbladder reference were also inspected. Observed differences driving this pass were isolated wet glints, coherent vascular branches, smooth capsular regions and irregular connective detail. No additional reference pixels are distributed.

## Implementation

For each emitter, incident irradiance is proportional to

`weight × intensity × exp(-spread × (1 - cos(theta))) × max(0, n·l) / distance²`.

Two light origins, in camera-local assumed millimetres, are `(-3.4, 1.1, 1.8)` and `(3.4, -0.8, 1.8)`, with weights 0.62 and 0.38. Their sum preserves the authored total source strength. The lights follow translation, rotation and roll; each has its own 2048² filtered shadow map. The angular exponent is 2.4. Cookie attenuation is linear data, not sRGB color. Shadows are actual visibility tests against the instrument and tissue meshes; no dark decals are introduced. The finite cone is a real-time truncation of the angular profile.

The scene's assumed millimetre scale and source strength are not measured radiometric quantities. The operative view uses a fixed authored exposure; internal navigation retains its existing working-distance intensity compensation. This is not image-metered auto-exposure. Device-specific calibration requires diffuse calibration targets at known poses plus measured camera response. We do not claim two emitter samples reconstruct an actual scope's fiber distribution or exact area-light penumbra.

The HDR pipeline renders linear radiance into RGBA16F, with up to four MSAA samples. A soft threshold extracts bright radiance; a normalized separable Gaussian redistributes 7.5% of that component at half resolution. The original component is subtracted before adding the spread component. ACES and sRGB conversion occur once at the final output. This is a compact authored point-spread approximation, not a measured lens model. Floating-point-target support is checked; unsupported devices retain direct rendering. Idle scenes still render on demand, and all targets resize for native image capture and are disposed with the viewer.

Wet-film reflectance at normal incidence is 0.02037 (assumed IOR approximately 1.333). Film coverage, roughness and normals vary with shared rest-space tissue fields and each organ's material recipe. Capsule relief is reduced; membranes use elongated noise rather than a repeated sinusoidal grid. The surface and film remain attached during deformation.

Superficial vasculature is an authored hierarchy of seven curved trees, with side branches beginning at exact parent samples, decreasing radii and vanishing terminal coverage. Arterial color, venous color, a wider subserosal halo and bounded relief share one 1024² texture. Rasterization wraps pixel addresses without clipping branches at tile boundaries. All organs and their attachment bands sample the same seeded rest-space field. Gallbladder vascular color now applies after organ pigmentation and disease changes; previously its base-color override erased the vessels. This is not a reconstructed vascular anatomy or a learned vessel generator.

## Reproducible validation

Use Node 24. Commands below run from the repository root:

```sh
node scripts/build_public_copy.mjs --out public-copy --keep-specimens
node scripts/verify_laparoscope_optics.mjs
node node_modules/vitest/vitest.mjs run apps/studio/src/laparoscopeLighting.test.ts apps/studio/src/virtaMedVasculature.test.ts apps/studio/src/virtaMedInterfaces.test.ts
node node_modules/@playwright/test/cli.js test --config playwright.virtamed.config.ts
REVIEW_OUTPUT=/tmp/virtamed-optics/final-review node scripts/virtamed_review.mjs
BENCH_OUTPUT=/tmp/virtamed-optics/performance-2 node scripts/benchmark_virtamed_browser.mjs
```

The optics fixture directly bundles the production modules. It compares shadow receivers enabled/disabled, glare enabled/disabled, three camera angles, and a diffuse plane at 40 and 80 assumed mm. Receiver toggles keep the cookie matrices current; disabling the entire shadow renderer at runtime produced a stale-transform diagnostic and was rejected as a test method.

Measured fixture result: 24,184 pixels darkened by more than 8 display levels with shadows, maximum change 79 levels. Glare changed 5,321 pixels by more than 3 summed RGB levels. Doubling camera distance reduced rendered diffuse intensity by 3.767×; the expected ideal ratio is modified by finite emitter offsets and 8-bit readback. All three views contained bright wet highlights and their centroids moved. No shader or page errors occurred.

The first material iteration was rejected because vessels were too sparse and membrane highlights remained broad. The second increases branch coverage and adjusts film microstructure. Full-scene evidence retains white geometry, baseline tissue, five disease variations at front/left/right/close views, and instrument force/release at three angles. Numerical correctness is separate from visual review and clinical validity.

Initial performance run at 1600×1100 CSS pixels, DPR 1, Chrome Metal: 59.98 FPS breathing, 60.00 FPS held grasp, 60.01 FPS recovery; p95 requestAnimationFrame interval 16.7 ms, zero dropped physics time. Resting idle produced zero scene draws. The prior accepted release also reached approximately 60 FPS; this pass preserves that cadence rather than claiming a frame-rate increase. Final repeat and deployment evidence are in the local review artifact.

Remaining limitations: inferred hidden anatomy, stylized procedural vessel distribution, approximate subsurface appearance and camera optics, and unvalidated deformation parameters. The findings do not establish clinical training suitability.
