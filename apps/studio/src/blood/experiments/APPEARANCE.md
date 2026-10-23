# Experimental appearance and illumination

These controls change presentation only. `setAppearance()` updates a paused
frame immediately; it does not step the tank/vessel solver or change inventory,
body position, trajectory, height, viscosity, pressure, or aperture geometry.

## Source-informed changes

The first image review showed a uniform pink wall, overbright blood, surface
shadow stripes, and depth fighting between a micrometre receiver film and its
tray. The depth-range and shadow-comparison fixes address numerical artifacts.
Appearance changes separately address material and illumination structure.

| Primary source | Observation used | Implementation and limit |
|---|---|---|
| [Holzapfel et al., layer-specific collagen orientations](https://pubmed.ncbi.nlm.nih.gov/22171063/) | Fiber families and dispersion differ across arterial wall layers; adventitial families tend more toward the axial direction than medial families. | Separate outer/inner structured maps and illustrative exposed-layer colours. They are not measurements of this displayed vessel. |
| [Rezakhaniha et al., collagen waviness in adventitia](https://link.springer.com/article/10.1007/s10237-011-0325-z) | Confocal microscopy of ex vivo rabbit carotid adventitia demonstrates wavy, distributed fiber families. | Seeded, crimped, oriented bundle fields. No copied microscopy images, random free-fluid surface noise, or learned texture claim. |
| [EndoPBR, lighting and material estimation](https://arxiv.org/html/2502.20669v1) | Camera-linked illumination is an important constraint in endoscopic appearance; illumination and material response should be separated. | Independently authored co-located spotlight with inverse-square falloff. No EndoPBR code/assets/weights are imported. This is a synthetic light model, not a calibrated endoscope. |
| [NIST surgical-lighting colour study](https://www.nist.gov/publications/development-surgical-lighting-enhanced-color-contrast) | Illumination spectrum affects surgical colour contrast. | Neutral RGB lighting and explicit model assumptions; no claim that a warm tint simulates a measured surgical LED spectrum. |
| [Three.js physical material](https://threejs.org/docs/pages/MeshPhysicalMaterial.html) and [DataTexture](https://threejs.org/docs/pages/DataTexture.html) | Nonmetallic dielectric response, linear data maps, colour texture encoding, and mipmap handling. | Linear normal/roughness maps; sRGB diffuse maps; mipmapping and bounded anisotropic filtering. |

## Wall maps and layers

The authoring field combines opposing wavy fiber families with a weaker
cross-oriented component. It is seamless, deterministic, independent of
camera/resolution/time, and mapped using axial metres and angular turns.
Adding an aperture can move the triangulation seam without moving the texture.

The outer map uses at most 3.5 µm of normal-map relief; the inner map uses at most
0.35 µm. Roughness ranges are approximately 0.34–0.425 and 0.19–0.225. These
amplitudes, diffuse reflectances, roughness values and cut-wall layer fractions
are **illustrative authoring choices**, not measured parameters from the cited
papers. Neither wall mesh nor solver geometry is displaced.

Each layer uses three 512² RGBA maps over approximately 4 mm periodic regions.
This preserves submillimetre detail without allocating a full-vessel 4K atlas.
Two layers occupy about 8 MiB of GPU texture storage including mipmaps. A bounded
four-entry CPU cache avoids regeneration on preset changes. Maps are not rebuilt
per frame or when adjusting exposure, lighting, or oxygenation.

This still omits measured subsurface tissue transport, patient-specific
adventitial anatomy, fat attachment, vasa-vasorum geometry, mechanical fiber
recruitment, coagulation and tissue damage. The appearance is not clinically
validated or indistinguishable from real surgical footage.

## Blood and light

Experimental blood colour uses the separately documented spectral oxygenation
lookup at fixed hematocrit 45% and D65/CIE assumptions. The illustrative defaults
are 0.98 arterial and 0.75 venous saturation. Diffuse response is not multiplied
by another red tint or by π. The top-lit tank floor and receiver use two-traversal
slab/substrate composition. Jet colour uses reconstructed local thickness.

Free-fluid normals remain geometry-derived. The wet material is nonmetallic
with white dielectric highlights and `ior=1.35` (`F0≈0.02218`); this is an
illustrative interface assumption, not a measured whole-blood calibration.

Camera mode places a neutral spotlight at the camera and removes environment
illumination. Its power is expressed in the scene's millimetre units so a
reference irradiance remains consistent with physical metre inputs. The
reference-distance convention is relative, not a claim of measured candela or
lux. Moving closer naturally changes irradiance. Studio mode uses a fixed
neutral key and neutral room environment.

Exposure is shared across the scene and bounded to ±2 EV. Optional matte
reference cards have 18% and 80% linear diffuse reflectance, share the scene
light and display transform, and are not unlit colour swatches. They support
comparisons; they do not constitute camera/spectral calibration.

## Validation

CPU tests cover deterministic maps, distinct layer ranges, metre-based normal
slopes, bounded texture allocation, Fresnel arithmetic, light unit conversion,
atomic invalid-control rejection, actual aperture ray passage and independent
closed-jet mesh volume. Browser tests separately exercise paused appearance
changes, state isolation, image differences and recorder lifecycle. Image and
video review must assess the actual outputs; these tests alone do not establish
surgical realism.
