import type { ScenePhysicsAttachment } from "./wholeScenePhysics";
/** Explicit buried centreline insertions. The biliary Y itself uses registered
 * shared geometry. These are authored mechanical joins, not proximity adhesion. */
export const VIRTAMED_AUTHORED_PHYSICS_JOINTS: (ScenePhysicsAttachment & {
  id: string; centerlinePointMm: [number,number,number]; provenance: string;
})[] = [
  {id:"cystic-artery-neck-insertion",a:"cystic-artery",b:"gallbladder",centerlinePointMm:[-48,-10,-9],provenance:"Authored artery tip buried inside the gallbladder neck; proximal continuation lies inside its connected liver host."},
  {id:"bile-duct-duodenal-insertion",a:"hepatic-duct",b:"duodenum",centerlinePointMm:[37,-57,-27],provenance:"Authored distal bile-duct centreline buried inside the descending duodenal envelope; no resolved mucosal lumen."},
];
