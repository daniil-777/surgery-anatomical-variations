# Vessel reuse and anatomical junction revision — 25 October 2026

The posterior screenshot exposed overlapping capped bile tubes, a disconnected-looking artery, a short bowel stump, and a repeating vessel tile. This revision changes the geometry and uses the existing separate-organ vascular system directly.

## Geometry

- Cystic and extrahepatic ducts are partitions of one swept implicit Y envelope. They share an exact boundary, with no cap inside the junction. The gallbladder neck is registered to that surface. The final asset is independently authored from the visible video field; it is not the simulator's source geometry.
- Proximal duct and artery continuations are buried in the liver envelope; the arterial tip enters the gallbladder neck. The distal bile duct enters the inferred duodenal envelope. Ray parity tests verify these four insertions against actual host triangles. They do not establish the anatomical accuracy of the hidden routes.
- The duodenal support now has a longer C-shaped continuation. Its unseen stomach and jejunal continuations remain incomplete; this is not a reconstruction of the entire digestive tract.
- Shared duct boundaries participate in the existing tissue blend and common deformation field. Explicit artery and duodenal mechanical attachments replace the previous isolated artery and single approximate duct constraint. Nearby unconnected organs are not glued together.

SAGES describes the hepatocystic triangle and the two structures entering the gallbladder, and emphasizes inspecting anterior and posterior views. Those descriptions informed the topology and inspection angles, not a claim of clinical validation: [Safe Cholecystectomy Program](https://www.sages.org/safe-cholecystectomy-program/), [biliary surgery guidelines](https://www.sages.org/publications/guidelines/guidelines-for-the-clinical-application-of-laparoscopic-biliary-tract-surgery/).

## Direct library reuse

`virtaMedVesselNetwork.ts` imports `createAtlasVesselNetwork` and `installAtlasVessels`, the same generator and shader used in the separate-organ view. Nine surfaces carry deterministic geodesic delivery trees, tapered branches, Murray-law junction radii, depth attenuation, and barycentric surface anchors. The large authored bile ducts and artery do not receive additional microvascular trees.

Regular scene lofts made grid-shaped bends visible in the first rendered pass. An optional fairing pass in the shared generator smooths degree-two runs on local triangle patches, preserving branch junctions, terminal count and surface attachment. Adaptive surface-projected cubic samples round perceptible bifurcations. A finer conservative lookup grid reduces shader candidate work without discarding branches. The separate-organ default is unchanged. A regression measures reduced bending and checks all stored anchors.

Networks are generated once when the GLB is built and stored in its metadata. Runtime shading samples immutable rest coordinates, so vessels follow shape variation and tool deformation without regenerating trees or drawing floating tubes. Vessel pigment fades under operative films and at registered material transitions. The old repeating vascular tile is no longer allocated or shaded in this scene.

These networks are procedural visual priors. They are not patient vessel segmentations, learned physiological circulation, or a perfusion solver. Existing learned RGB tissue maps remain in use; this change does not claim to train new texture models.

## Verification and retained limits

The review artifact includes matched baseline/revised views, the intermediate angular-vessel result, topology and exported-anchor tests, actual-mesh push/grasp stress results, browser tests, contact/release videos, performance measurements and deployment hashes. It records failed iterations separately from the final build.

The mechanics remain a bounded interactive deformation approximation. Organ-organ collision/friction, internal lumens, cavity pressure, blood transport and patient calibration are not resolved. Posterior exposed anatomy is an inspection view; it is not an assertion that the same view is accessible through an intact laparoscopic approach. Photorealism and clinical readiness require further work and independent expert review.
