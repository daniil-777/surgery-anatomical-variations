import type { ScenePhysicsAttachment } from "./wholeScenePhysics";

/** Mechanical joins need not be material-blending interfaces. This authored
 * bile-duct junction follows the two explicit centreline curves in
 * createVirtaMedScene(); its overlapping tube surfaces are not welded roots.
 * No artery tether, wall adhesion or tissue-to-tissue collision is inferred. */
export const VIRTAMED_AUTHORED_PHYSICS_JOINTS: (ScenePhysicsAttachment & {
  id: string; centerlinePointMm: [number, number, number]; provenance: string; scope: string;
})[] = [{
  id: "authored-cystic-hepatic-duct-junction",
  a: "cystic-duct", b: "hepatic-duct", centerlinePointMm: [-2, -24, -16],
  provenance: "Authored duct centrelines meet at this coordinate in createVirtaMedScene; anatomical design evidence, not measured attachment mechanics.",
  scope: "Shared continuous reduced-order motion across overlapping duct surfaces; no welded lumen, fluid continuity, junction stress or friction solve.",
}];
