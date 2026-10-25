# Cavity appearance and contact review — 25 October 2026

This revision treats the abdominal wall as an enclosing peritoneal lining around the working space. It is an authored approximation for the reconstructed upper-abdominal field. The supplied simulator video does not determine the unseen wall, absolute scale, insufflation pressure, tissue stiffness or friction.

## Real-image observations

The following existing research images were inspected directly at full display size:

| Reference | Observed appearance | Rendering implication |
| --- | --- | --- |
| DSAD abdominal-wall field 04/0, local research copy `dsad/abdominal_wall-04-0-image.png` (JPEG viewer rendition) | Pale grey-pink membrane over unequal yellow fat mounds; branching red vessels; small dark residue marks; localized elongated white glints. | Break up the lining into broad translucent-looking membrane and fat-supported regions. Keep vascular color below a smooth wet surface. Avoid a uniform pink room or a repeated wrinkle grid. |
| DSAD 25/47, tracked app reference | Broad fatty folds with embedded red branches and pale connective coverage; nearby bowel has different, smoother reflectance. | Preserve regional differences and coherent vessel taper. Use a continuous wet film across tissue changes without making all tissues identical. |
| DSAD 03/2, tracked app reference | Smooth low-contrast liver capsule, soft mottling, a few compact highlights; larger vessels are not painted everywhere. | Retain calm intact organ areas beside the more varied wall and fatty interfaces. Do not maximize detail uniformly. |

These are visual observations, not albedo, roughness or force measurements. Camera white balance, exposure, shadows and specular glare affect every observed color. The wall 04/0 copy remains research-only; no new dataset pixels are embedded in the cavity asset.

The primary DSAD publication describes eleven annotated structures, including abdominal wall, and heterogeneous operative visibility. Its 32 source operations were robotic rectal procedures, so appearance observations do not establish patient-specific hepatobiliary anatomy. [Carstens et al., *The Dresden Surgical Anatomy Dataset*, 2023](https://www.nature.com/articles/s41597-022-01719-2). Existing reference provenance is recorded in `apps/studio/public/body-reference/provenance.json`; the official distribution is [NCT Dresden's DSAD repository](https://huggingface.co/datasets/nct-tso/dsad).

## Geometry and mechanics evidence

In-vivo surface measurements during insufflation found a dome-shaped wall and directional mechanical differences. This motivates an anterior dome and regional support, but does not calibrate this reconstructed shell. [Song et al., 2006](https://pubmed.ncbi.nlm.nih.gov/16738998/).

A primary patient-specific simulation modeled separate wall, viscera and gas-space structures, calibrating against inflated CT and checking human feasibility. That acquisition is absent here; the new shape is explicitly authored. [Dawda et al., 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6736924/).

The implementation uses a closed welded manifold, inward normals, an anterior dome and shallow posterior reflection ridges. Front-side rendering makes the lining visible inside and yields a cutaway for external inspection. Every reconstructed organ remains inside in sampled geometry checks, and the normal video camera has clearance from the dome. See [the geometric specification](./abdominal-cavity.md).

## Acceptance evidence and limits

The focused scene tests exercise push, hold and recovery on actual triangles of all twelve parts, including the lining, with bounded force, finite state and matching displayed/contact positions. The source physics uses registered attachment components; independent surfaces do not become permanently attached merely because they are nearby. These are engineering consistency checks, not experimental validation of surgical mechanics.

`scripts/review_cavity_shell.mjs` records operative, lateral, superior and anterior interior views through public camera controls, plus external cutaway views. It saves unmodified screenshots, camera/material snapshots and browser errors for visual inspection. Contact videos and temporal displacement checks are produced by the separate contact review script.

Remaining limits include unknown patient anatomy and pressure, authored surface optics and support coefficients, no calibrated whole-cavity gas pressure, no resolved tissue-to-tissue sliding/contact solver, and no incision or fluid transport. Geometric enclosure and plausible appearance do not establish those missing capabilities.

## Contact mechanics revision

The previous solver applied one radial contact field to every nearby soft mesh and linked each organ to its three nearest centres. That made independent tissues behave as if they were glued. The registered scene now has one continuous displacement field per anatomical attachment component. A liver/ligament join remains continuous, while a nearby independent bowel surface does not inherit the liver's indentation merely because of proximity. The coarse force projection uses the displayed anchor's actual interpolation basis, `JᵀF`, instead of assigning an arbitrary ten percent of force to one organ.

The cavity wall has an explicit fixed coarse support and a local recoverable indentation mode. Its enclosing shell does not translate under the global breathing or palpation pulse. Contact from a visible instrument still deforms it. The wall's synthetic material and response coefficients are not measured human parameters.

The implementation retains an implicit 120 Hz standard-linear-solid history, a nonnegative quartic strain-stiffening energy, normal-only unilateral push, and a bounded compliant grasp. [Cadaveric liver/stomach measurements](https://pmc.ncbi.nlm.nih.gov/articles/PMC2693244/) motivate nonlinear and history-dependent response; they do not calibrate this scene. [Baraff and Witkin's implicit simulation work](https://publications.ri.cmu.edu/large-steps-in-cloth-simulation) supports the numerical approach for stiff systems; this implementation is a smaller reduced-order approximation.

At each physical step, the trilinear coarse field has an infinity-norm displacement-gradient bound at most 0.25. The Wendland local fields use their analytic derivative bound; component-specific scaling keeps the sum at most 0.45. A continuous field with derivative norm below one preserves local orientation and has no fold in that mathematical interpolation. This is not a proof of nonintersection between independent organs or of every discretized triangle's quality after interpolation. Registered copies of each attachment coordinate evaluate the identical field and remain coincident.

Tests additionally check exact replay across mixed render intervals, zero direct movement on unjoined coincident sheets, all-organ contact support, barycentric anchor agreement, continuous release, and monotonically decreasing reduced modal energy at each of 600 recovery substeps for both push and grasp. The energy diagnostic excludes virtual-tool and projection work; it is an engineering stability check, not biological validation. The detailed method and limitations are recorded in [anatomical-contact.md](./anatomical-contact.md).

The main remaining mechanics risks are unresolved tissue-to-tissue collision and friction, Euclidean rather than volumetric/geodesic contact kernels within an attached component, moving pressure footprints that are not represented in the modal-speed diagnostic, and missing cavity pressure, wall thickness and near-incompressibility constraints. The current result should be described as a bounded interactive deformation preview.

## Material and interaction iterations

The first enclosure material overemphasized cell-boundary relief and produced a
visible crackled pattern. The second pass removed that boundary displacement,
reduced relief to smooth 0.003–0.012 mm fields, softened yellow fat pigmentation,
and retained pale membrane regions and low-contrast branching vessels. These are
reference-guided authored optics, not newly estimated biological PBR parameters.
The wall uses inward-facing color and shadow triangles; external orbit inspection
shows a cutaway. Its environment reflection is disabled to avoid room-shaped
reflections inside the cavity.

`Explore cavity` supports a guarded camera inside the actual shell. `Use this view
for instruments` retains the chosen pose and illumination rather than resetting
its working distance or brightness. During cavity exploration, movement stops before visible wall triangles.
The global palpation pulse is disabled for the supported wall; local Push and
Grasp remain available.

A latched instrument previously jumped when the cursor returned from a sidebar
control. The pointer now rebases once on reentry while preserving its accepted
pose. Both push and grasp have event-handler regression tests.

Full video review also found a failure missed by force and finite-state checks:
the camera-axis fallback could place the scope inside the visible shaft or
proximal handle, hiding the scene behind metal or blue plastic. Camera clearance
now covers the complete visual instrument, including its handle, and alternative
oblique approaches receive the same tissue and camera guards. This is separate
from tissue collision: no handle-to-tissue mechanics or trocar portal is modeled.
The pre-fix recordings remain archived as failed visual acceptance evidence.
