# Full.mp4: anatomy and motion evidence for a Viscera reconstruction

Audit date: 2026-10-25. Source supplied by the user: `videos/Full.mp4`, 787.766667 seconds, 1920 × 1080, 60 fps. This report is an independent visual/code audit, not a medical review or recovery of the source simulator's original assets. No implementation files were changed.

## Main conclusion

The recording is a **focused simulated hepatocystic-triangle dissection**, labeled “Hepatocystic Triangle V2” in the recording. It is not a panoramic survey of all abdominal organs. The most faithful useful reconstruction target is an intact upper-abdominal operative field with liver, gallbladder, neighboring bowel, and its surrounding fat/peritoneal attachments, with several matching close camera views. Hidden anatomy can be supplied by the existing atlas, but cannot honestly be described as measured from this video.

The source has excellent examples of instrument-relative occlusion, retraction of a soft gallbladder, tension in thin attachment sheets, dissection revealing narrow tubes, wet surface highlights, and camera-dependent appearance. It does **not** supply calibrated forces, camera poses/intrinsics, organ dimensions, material constants, or an intact multi-angle survey sufficient to recover a unique 3D shape. Its visual responses are also those of an existing simulator, not measured human tissue.

## What was inspected

Evidence directory: `/tmp/viscera-virtamed-research/video-audit`.

- `overview.jpg`: broad timeline contact sheet at roughly 30-second intervals. Because FFmpeg resamples intervals, the first tile is around 15 seconds, followed by about 45, 75, …; do not treat the first tile as time zero.
- Exact direct-seek overview frames: `frame-0000.jpg`, `frame-0020.jpg`, then `frame-0060.jpg` through `frame-0780.jpg` at 40-second intervals. 21 direct-seek frames cover the whole recording.
- Detail frames (1280 × 720): source seconds 8, 15, 40, 295, 330, 350, 395, 425, 455, 485, 515, 545, 605, 635, 665, 695, 725, 755, 780.
- Motion contact sheets: `lift-sequence-16-38.jpg`, `retraction-sequence-386-408.jpg`, `peel-sequence-718-740.jpg`, each with twelve nominal two-second samples. Interval-resampled frames lie about one second after the corresponding nominal start. They are for qualitative temporal inspection.
- Existing Viscera source and manifest were inspected read-only: `apps/studio/src/imports/laparoscopicScene.ts`, `wholeSceneModel.ts`, `operativeView.ts`, `fat/sceneLayers.ts`, and `apps/studio/public/anatomy-scene/manifest.json`.

The recording's on-screen task timer is approximately seven seconds behind the MP4 timestamp after the initial prompt. All timestamps below mean **MP4 time**, not the task timer.

### Original-resolution comparison frames

Nine standalone PNGs retain the original 1920 × 1080 frame, including its timer: `full-00m08s.png`, `full-00m15s.png`, `full-00m40s.png`, `full-04m55s.png`, `full-06m26s.png`, `full-06m35s.png`, `full-07m35s.png`, `full-11m58s.png`, and `full-12m05s.png`. All are in the evidence directory above. The first two are the baseline matching targets; the 06:26/06:35 and 11:58/12:05 pairs are the requested qualitative traction comparison targets.

### Approximate intact-view screen proportions

Manual observations from `full-00m08s.png`, **not segmented measurements or anatomical dimensions**. The surgical image occupies approximately source pixels x=300…1620 and y=0…996, excluding the bottom instrument toolbar and side UI. Let u=(x−300)/1320 and v=y/996. Tolerance of these hand-estimated proportions is roughly ±0.03 of the field.

| Feature | Approximate image proportion | Interpretation |
|---|---|---|
| Visible liver canopy | Nearly 100% field width; upper surface starts near v=0.11; lower central edge near v=0.45 | Broad continuous overhang, not a compact organ floating at center |
| Exposed gallbladder fundus | u≈0.10…0.37, v≈0.37…0.64; center (0.23, 0.50); apparent width/height≈1.39 in source pixels | About 27% field width and 27% field height; longer gallbladder body/neck is foreshortened and partly hidden |
| Local fat behind gallbladder neck | Visible patch u≈0.36…0.57, v≈0.41…0.59 | Approximately one fundus-width of supporting connective tissue visible to its right, continuing behind occluders |
| Cranial pale sheet | Enters top around u≈0.50…0.73; tapers to lower insertion near (0.51, 0.39) | A diagonal broad ribbon tapering onto the liver, not a vertical cylindrical cord |
| Main pink right-background surface | Main bulge u≈0.49…1.00, v≈0.34…0.69; a narrower tail continues toward lower left | Broad partly occluded surface; do not infer its full organ outline |
| Fatty foreground apron | Spans almost all field width, rising from v≈0.83 on left to v≈0.63 on right, with variable thickness | Oblique drape over bowel; breaks uniformity and establishes depth |
| Closest pink foreground surface | Mainly v≈0.76…1.00 | Cropped by lower image boundary; gives camera-inside-body foreground occlusion |

These targets are camera-composition constraints. They should not be directly turned into millimetre organ sizes without a camera/scale model.

## Directly visible structures and relationships

### Liver

High confidence. The large deep red smooth structure forms the upper/back wall of the operating view. In the intact opening view it spans almost the full field width. Its inferior margin is rounded and irregular, with broad connected lobar convexities, rather than separate floating ellipsoids. The gallbladder is directly apposed to its lower/visceral surface. A shallow dark sulcus and adjoining liver surfaces become visible around the field as the camera gets closer.

Use the existing continuous liver capsule as a starting shape. Preserve a continuous surface and a coherent thin inferior edge; do not model the apparent screen-space lobes as disconnected balls. In the final dissection views the rough exposed gallbladder bed occupies a substantial patch of the liver surface. The pale patches that grow near the instrument in later frames are acquired simulator injury/coagulation effects, and should not be copied as healthy baseline texture or interpreted as cirrhosis.

### Gallbladder

High confidence from the full action sequence. In the opening frame the fundus is a pale gray, almost round visible bulb at viewer-left below the liver. This is a **foreshortened view of a longer organ**, not proof of a spherical organ. Later retraction exposes a larger elongated sac, tapering into a narrow bent neck and tube. It occupies much of the left field while the working point remains near its neck toward the middle/lower right.

At 04:55 and 05:50, a thickened fold/transition circles the tapering neck. Around 06:35–07:05 the sac rotates and the thin surrounding sheet is tensioned by graspers. At 12:05–13:00 the gallbladder body moves across the field as its remaining attachment is separated. This provides useful silhouette targets for an ungrasped broad fundus, neck taper, and a retracted/rotated configuration. No hidden posterior gallbladder wall geometry is recoverable from the opening view alone.

### Thin serosal/peritoneal attachments

High confidence as visible surface type; exact anatomical boundaries are partly inferred. A translucent/whitish layer is stretched between gallbladder, liver bed, and adjacent fat. The edges become thin folds under traction; exposed sheet can be narrow and ribbon-like near the neck while a broader zone stays attached. At 06:26–06:50 a top grasper holds an orange/white flap while a hook pulls and separates the opposite edge. Broad tension aligns folds toward anchor points. The bulk organ rotates while this attachment deforms locally.

This is a major omission in a scene made solely of independent atlas organ meshes. It needs a deformable shell with explicit organ-relative anchors, not only floating fibrous textures. A visible sheet cannot establish the original simulator's boundary conditions or its real material law.

### Fat/connective envelope in the hepatocystic region

High confidence for appearance and relative placement. A yellow-orange, lobulated pad spans the central posterior field and surrounds the gallbladder-neck region. It is behind the foreground sac and below the overhanging liver. The pad includes broad fleshy folds, not a uniform grid of equal spheres. Finer pale bands cross the yellow surface. A separate broader yellow fatty apron overlaps the pink foreground bowel in the opening view.

Keep these two functions distinct: the small hepatocystic envelope directly coupled to the gallbladder/duct dissection, and the broader omental/mesenteric context over bowel. Existing procedural greater omentum alone does not reproduce the small local envelope.

### Cranial sheet compatible with falciform ligament

Directly visible tapered tan/pale sheet at the upper center in the intact view; anatomical identification is an inference from location/appearance. It descends from outside the upper image onto the liver surface, with a narrow attachment and broader superior width. Its exact origin on the anterior wall and full extent are off camera.

This matters to the opening silhouette and sense of attachment. An explicitly inferred, thin folded ligament surface with a cranial wall anchor is more faithful than a detached tube. Do not claim its measured thickness or complete attachment footprint.

### Tubular structures exposed by dissection

High confidence that two narrow separate tube-like structures become visible and are clipped/divided; anatomical assignment comes from the hepatocystic procedural context, not independent labeling in the frames. The narrower pink tube and broader paler tube have different diameters and curvature. At 07:35 and 10:05 they are clearer than early in the recording. Later clips and severed ends confirm separate branches. These correspond plausibly to cystic artery and cystic duct, but a screenshot alone is not a safe identification method or evidence of a complete biliary tree.

For reconstruction, expose these only in an optional dissection state or after moving the covering fat/sheet. The intact scene should not put the entire portal tree, hepatic artery, and duct tree on top of the liver. Preserve artery/vein/bile-route identities and keep any illustrative branch additions explicit in provenance.

### Neighboring pink bowel/gastric surfaces

High confidence that the opening scene includes broad pink, vascular, rounded visceral surfaces at lower/right foreground. Their continuous full outlines are not shown. They have broad folds, small vessels following the curvature, and a yellow fatty sheet draped across them. Their exact partition into stomach, duodenum, transverse colon, and other bowel cannot be securely determined from the unlabelled close view alone. Avoid inventing an observed whole-organ identification or shape.

Use existing co-registered stomach/duodenum/colon as anatomical context and adjust the **camera** before changing their registration to fit a single image. Their background presence, occlusion, and surface treatment are important; rendering isolated full bowel loops in the central hepatocystic view would not resemble the source.

### Organs not evidenced in the recording

Kidneys, spleen, pancreas, the full small-intestinal coil, the aorta/vena cava, and the complete mesentery are not independently surveyed. They can remain in a whole-scene atlas as hidden context, but are not video-derived geometry and have no video-observed deformation calibration here. The abdominal wall's complete inflated shape is likewise not recoverable; dark peripheral regions alone do not define a cavity mesh.

## Timestamped comparison/interaction targets

| MP4 time | Useful visual evidence | Recommended use |
|---|---|---|
| 00:08–00:15 | Intact wide view: liver roof, bulbous gallbladder fundus left, cranial sheet, fat behind/over pink foreground viscera | Primary white-geometry composition target; also intact texture target |
| 00:16–00:40 | Instruments reposition; camera advances/tilts toward neck; gallbladder silhouette changes with perspective | Camera transition and occlusion review, not a stiffness measurement |
| 00:40–02:20 | Hook/grasper interact with covering pad and pale attachment beside liver | Local flap indentation and attachment visibility |
| 04:55 | Neck taper and gallbladder/liver/fat relationship clear | Close silhouette and overlap comparison |
| 05:30 | Fluorescence-like green display briefly visible | Do not use as white-light tissue color reference |
| 05:50–06:20 | A narrow pink tube visible under the dissected layer | Tubular placement and realistic hidden-versus-exposed state |
| 06:26–06:50 | Grasper holds an orange/white fold; hook moves its free lower edge; sac and sheet rotate/tent | Best qualitative organ–sheet coupling sequence |
| 07:05–07:35 | Exposed bed with thin tube and broad neck; substantial occlusion by the tool | Oblique close view and branch/thickness contrast |
| 08:05 | Tissue injury/bleeding appears during tool action | Separate acquired damage from disease presets; not healthy baseline |
| 08:35–09:15 | Retracted sheet, cautery changes, liver bed details | Wet/dry transition and wound surface only in optional procedural state |
| 10:05–11:05 | Clips placed on distinct tubular structures, then division | Optional dissection topology; no material calibration |
| 11:58–12:20 | Gallbladder rotated across the field, liver bed exposed, remaining attachment peels/tents | Multi-angle deformation/occlusion inspection target |
| 12:35–13:00 | Large rough exposed bed and detached/retracted sac | Optional end-state comparison, not intact scene target |

## Relationship to the current Viscera assets

The bundled BodyParts3D atlas uses millimetres, +X patient left, +Y superior, +Z anterior. It is an independently authored adult atlas, not the person or simulator anatomy from this recording. Current `full-laparoscopy` selects 24 structures and `hepatobiliary` selects 11. Existing loader merges cystic/hepatic duct surfaces, retains artery and vein separately, smooths/refines selected surfaces, and retains shared atlas placement. The geometry alone does not include a finite-element volume or validated organ contact surfaces.

Relevant centers/bounds from the current manifest:

| Structure | Center, mm | Bounds, mm | Consequence |
|---|---|---|---|
| Liver | (-11.0, 35.6, 12.5) | x -115.7…93.8; y -42.5…113.6; z -67.6…92.6 | Already a continuous capsule; preserve it as geometric base |
| Gallbladder | (-45.1, 1.3, 44.4) | x -63.3…-26.8; y -18.9…21.5; z 20.2…68.6 | Native visible fundus may be too small for the video view; first solve camera/foreshortening before swelling geometry |
| Cystic duct | (-25.3, 15.3, 23.1) | x -29.7…-20.9; y 9.2…21.3; z 18.4…27.8 | Distinct source exists although loader combines it into hepatic-duct mesh |
| Stomach | (38.3, 28.4, 27.9) | x -29.0…105.5; y -30.1…86.9; z -28.5…84.4 | Context at patient-left side, can occlude under liver depending camera |
| Duodenum | (-16.6, -38.6, 20.4) | x -65.6…32.3; y -84.4…7.1; z -6.1…46.9 | Subhepatic context already available |
| Colon | (-4.7, -159.0, -5.9) | x -126.8…117.5; y -312.7…-5.3; z -98.7…86.9 | Use nearby upper segment as foreground, not the entire colon in the local view |

Current `fat/sceneLayers.ts` creates an inferred greater-omentum apron and perirenal envelopes. Its own limitations correctly state it does not reproduce vascular pedicles, gastrocolic attachments, fusion planes, or four serosal layers. The video additionally needs local subhepatic/hepatocystic fat and serosal sheets, which are different structures. Current `operativeView.ts` has an illustrative enclosing peritoneal surface and regional camera entries; it is a useful framework but not a measured reconstruction of the recording's wall.

## Reconstruction recommendations, in order

1. **Implement a named video-study preset in neutral white first.** Keep original atlas assets intact. Assemble a liver–gallbladder operative field, co-registered neighboring viscera, a local fat envelope, a thin gallbladder attachment sheet, and an explicitly inferred cranial ligament sheet. Mark the basis as a video-informed illustration using independently sourced atlas geometry. A neutral-white scene makes false edges and gaps easy to review.
2. **Match framing before sculpting.** Start from the 00:08/00:15 image: liver fills the upper field, gallbladder at viewer-left, central working space beside its neck, pink/bowel context lower/right. Choose the camera direction under the liver, a finite near plane, realistic local light falloff, and an internal scope FOV. Then compare close views at 04:55 and 07:35. A single image silhouette should not dictate unobserved organ geometry.
3. **Keep reference and baseline camera/bookmarks.** Useful named views: intact overview, gallbladder neck, medial triangle, lateral bed/traction. An external orbit is useful for debugging connections, but should not replace the inside operative view as the quality target.
4. **Use a separate texture action.** One button applies organ-specific learned/derived appearance while retaining white mode as a reversible geometry inspection state. Keep camera, seed, and shape unchanged when toggling white/textured; otherwise comparison is confounded.
5. **Keep disease changes local and anatomically meaningful.** Preserve anchors while varying body shape and surface. Do not treat white thermal lesions in this video as pre-existing disease, and do not turn normal smooth liver into random spherical bumps. Shape and appearance controls should share a disease specification and deterministic seed.
6. **Model coupling explicitly.** Ligament/serosal edges should follow their host tissues. Fat may move with adjacent attachment regions and slide elsewhere. Prevent detached sheets and elastic “strings” spanning empty space. Use contact constraints where necessary; nearest-neighbor coupling alone does not prove contact realism.
7. **Make the physics evidence honest.** The footage supplies qualitative target behavior, not physical force/displacement data. Organ-specific constants must come from separately documented priors/measurements or existing calibrated Viscera experiments. If a model is fitted to synthetic trajectories, call that a simulation fit, not recovered human elasticity or video-learned physical parameters.

## Useful physics/visual acceptance checks

- At zero force, a stable intact rest state has no drift, missing attachments, or self-exploding sheets.
- A gentle local push gives a local dent with broad smooth falloff; the entire liver should not translate as an unconstrained rigid object.
- Pulling the gallbladder body visibly tensions the local sheet and moves associated fat modestly; distant bowel should not be dragged equally.
- Motion remains continuous across shared boundaries and does not expose texture seams or inverted normals.
- Release returns toward rest with damping, without persistent high-frequency ringing; any non-rest recovery must be an explicit model feature.
- Repeating the same force/seed/view gives repeatable motion. Refining the time step should not change gross displacement or make the model unstable.
- At least three camera angles are checked for contact penetration, artificially stretched necks, occluded wrong-side vessels, floating fat, and excessive sheet thickness.
- Report force units, contact radius, pinned regions, solver type, and the provenance of each parameter set in the physics panel/report. The video itself has no force labels.
- Record matched reference timestamps alongside screenshots. Describe visual similarity as a qualitative comparison; there is no complete ground-truth mesh or force record here from which to calculate reconstruction accuracy.

## Confidence and limits

Directly supported: local liver/gallbladder/attachment/fat silhouettes, ordering of visible layers, tool-relative deformation examples, camera-dependent occlusion, and the existence of a dissection sequence. Inferred: anatomical naming of some sheet/bowel surfaces, hidden organ geometry, absolute scale, wall shape, and attachment footprints. Not identifiable from this source: complete anatomy of all organs, exact intrinsic camera model, real tissue elastic/viscoelastic parameters, full 3D force trajectories, original simulator solver, and clinical/surgical validity.

The most consequential fidelity gain is a coherent **layered operative field with anchored soft tissues and correct camera framing**. Simply adding more independent organ meshes or stronger texture contrast will not reproduce what the recording shows.
