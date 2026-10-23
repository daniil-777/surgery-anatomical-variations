# Blood experiment rendering

The tank and vessel views read accepted solver snapshots. They do not advance
time, apply forces, emit particles, or modify solver inventory. World positions
use metres in the contracts and a uniform ×1000 conversion in the Three.js
scene. Camera motion and recording resolution do not change physical scale.

## Tank

The free surface is the supplied cell-centred height field, interpolated at
shared cell edges. Normal vectors use the height field's physical derivatives.
Boundary interpolation uses the adjacent closed-wall cell; it does not wrap.
An opaque fluid boundary reaches the actual tank floor. The sphere or cube uses
the accepted body position and physical radius/edge length.

This is a hydrostatic, single-valued height graph. The renderer does not invent
overturning waves, spray, entrained bubbles, contact-line motion, or a solved
three-dimensional wetted body surface. The transparent enclosure is an
illustrative viewing aid; its outside faces sit 1 mm beyond the fixed inner
fluid boundary. This represents wall thickness and avoids coplanar pane/fluid
depth tests. Blood opacity is not reduced to reveal the object.

## Vessel

The curved wall consists of separate inner and outer surfaces, joined at the
open ends and aperture rims. Apertures are absent triangles in a triangulated
surface domain, not dark decals or alpha masks. Conforming subdivision limits
surface edges by both vessel length and radius. The solver outlet origins and
directions come from the same centreline frame as the wall.

The displayed wall is rigid reference geometry. The hydraulic solver's
compliance/storage variable does not constitute a deformation or fluid–structure
interaction solution, so changing inventory does not move the wall. The full
lumen surface is display context, not a solved spatial fill/emptying field.

The outgoing liquid now requires the breakup solver's accepted ligaments and
droplets. There is no runtime fallback to the former parcel-joining display.
Ligament centres, neck radii, connectivity and timing come from that solver.
Closed 32-sided tube rings use transported local frames; a per-ligament
polygon-area correction preserves the actual closed mesh volume while retaining
the centreline and relative neck profile. Float32 triangle volume is measured
independently. Distinct ligaments stay distinct: the renderer never bridges
gaps or chooses pinch-off times.

Droplets use reusable instanced, volume-equivalent spheres. Their centre,
radius, inventory and flight are authoritative solver state. A fixed
tessellation correction preserves sphere-mesh volume. This does not solve
droplet deformation, coalescence, surface oscillation or subgrid satellite
drops. Rendering never integrates gravity or adds decorative spray.

The collection tray now requires an accepted spatial film height field. Local
heights include the model's explicit initial prewet inventory; no initial
thickness is baked into the renderer. Cell values generate shared corner heights
and four triangle fans per cell. This reconstruction preserves total
finite-volume height inventory, including arbitrary deposits in corner cells,
without scaling heights. Normals follow metric height gradients, and the local
optical slab thickness follows that same field. This is the collector's
depth-averaged surface representation, not a three-dimensional impact/splash
simulation or tissue-absorption model. Outside-domain impacts remain in the
solver's escaped-volume ledger, rather than being painted onto the tray.

The solver's no-flux lateral boundary is displayed as a closed collection tray:
neutral matte walls, with 1 mm thickness entirely outside the
unchanged physical fluid rectangle. Their inner faces coincide with the domain
boundary and their bases meet the tray floor. No alpha mask, displaced fluid or
overflow animation substitutes for that geometry. Wall height equals the
solver's existing shallow-layer maximum, `0.1 × min(width, depth)`: 16 mm for
the default 160×200 mm domain. The renderer checks that same field-height bound
before changing buffers; it adds no stricter limit after an accepted physical
step. Overflow is outside the model. Airborne interaction with the rim
is not resolved; outside-domain impacts retain their existing escaped ledger.
The caption and exported visual state report the authored rim dimensions.

## Optics and lifecycle

Diffuse blood colour uses the repository's spectral slab approximation.
Directional light and a neutral room environment illuminate physical materials;
the result is illustrative laboratory optics, not a calibrated surgical camera
or patient-specific tissue appearance. No decorative cell texture or surface
noise is added.

Both renderers share native recording leases, fixed-resolution HD–4K drawing,
resize deferral during capture, abort restoration, keyboard/touch orbit
controls, context-loss stop, and explicit disposal of geometry, materials,
environment targets, controls, observers, event listeners and recording
registrations. Normal display pixel ratio is capped at two. Camera depth range
tracks actual viewing distance so thin receiver films do not quantise into the
tray. Shadow comparison bias uses one world-space shadow texel: the previous
half-texel offset left PCF self-shadow bands at the studio light angle. Frozen
accepted-state A/B images separately verified the shadow and coplanar-glass
causes. This is a tested scene-scale bias, not a guarantee for arbitrary slopes;
accepted fluid heights are never displaced to conceal depth artifacts.

Explicit material inspection uses lens magnification at the exact existing
camera position and unchanged light power. It targets the first aperture or
tank body/surface centre. Returning to overview restores the preceding camera
pose; Home resets the initial pose and unit zoom. Native recording leases use
the selected view. Optional physical grey targets sit outside the tank
footprint on a support, with the same scene lighting and exposure.

CPU geometry tests independently verify physical dimensions, slope and winding,
buffer reuse, rejection before mutation, exact shared outlet positions, ray
passage through a genuine wall aperture, actual ligament volume and neck shape,
and spatial collector mesh inventory. Browser/GPU recording and visual checks
are separate integration gates.

The geometry/material implementation uses the public Three.js APIs documented
in [ShapeUtils](https://threejs.org/docs/#ShapeUtils),
[Curve](https://threejs.org/docs/#Curve), and
[MeshPhysicalMaterial](https://threejs.org/docs/#MeshPhysicalMaterial).
