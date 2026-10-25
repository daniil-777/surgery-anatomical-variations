import * as THREE from "three";
import { createAtlasVesselNetwork, ATLAS_VESSEL_VERSION, type AtlasVesselNetwork } from "./atlasVessels";
import { installAtlasVessels } from "./atlasVesselShader";

export const VIRTAMED_VESSEL_SOURCE = "shared-organ-surface-network/1";
const profiles:Record<string,[number,number,number]>={
  liver:[.16,.28,.8],gallbladder:[.68,.8,.92],colon:[.65,.73,.88],"small-intestine":[.7,.76,.9],
  duodenum:[.55,.8,1],"hepatocystic-fat":[.68,.76,1],"hepatoduodenal-ligament":[.6,.7,.8],
  "falciform-ligament":[.5,.66,.8],"abdominal-wall":[.58,.76,1],
};
/** Build-time reuse of the exact separate-organ delivery-tree generator. No
 * periodic texture projection and no run-time network regeneration. */
export function generateVirtaMedVessels(root:THREE.Group) {
  for(const mesh of root.children as THREE.Mesh[]){
    const profile=profiles[mesh.name];if(!profile)continue;
    const [density,visibility,radiusScale]=profile,geometry=mesh.geometry;
    let seed=2166136261;for(const char of mesh.name)seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
    mesh.userData.surfaceVessels=createAtlasVesselNetwork({id:mesh.name,name:mesh.name,kind:"organ",color:"#ffffff",positions:Array.from(geometry.getAttribute("position").array),indices:Array.from(geometry.index!.array)}, {organId:mesh.name,seed,density,visibility,radiusScale,fairingPasses:20});
    mesh.userData.surfaceVesselSource=VIRTAMED_VESSEL_SOURCE;
  }
}

export function applyVirtaMedVessels(geometry:THREE.BufferGeometry,material:THREE.MeshPhysicalMaterial,network:AtlasVesselNetwork|undefined,white:boolean) {
  if(white||!network)return;
  if(network.version!==ATLAS_VESSEL_VERSION)throw new Error("Unsupported scene vessel network.");
  // This buffer remains immutable through shape recipes and tool deformation.
  if(!geometry.hasAttribute("atlasRestPosition"))geometry.setAttribute("atlasRestPosition",geometry.getAttribute("sceneRestPosition").clone());
  installAtlasVessels(geometry,material,network,64);
  // Vessel pigment lies below operative films and fades into the registered
  // tissue blend at attachment boundaries, instead of painting over either.
  const compile=material.onBeforeCompile;
  material.onBeforeCompile=(shader,renderer)=>{
    compile.call(material,shader,renderer);
    shader.fragmentShader=shader.fragmentShader.replace(
      "diffuseColor.rgb = atlasVesselColor(diffuseColor.rgb, atlasVesselField);",
      `float vmVesselExposure=(1.-clamp(vmFilmLevel,0.,1.))/sqrt(vmTotal);
       atlasVesselField.artery*=vmVesselExposure;atlasVesselField.vein*=vmVesselExposure;
       atlasVesselField.core*=vmVesselExposure;atlasVesselField.gradient*=vmVesselExposure;
       diffuseColor.rgb = atlasVesselColor(diffuseColor.rgb, atlasVesselField);`);
  };
  material.userData.appearance.surfaceVessels={source:VIRTAMED_VESSEL_SOURCE,version:network.version,seed:network.seed,...network.statistics,settings:network.settings};
}
