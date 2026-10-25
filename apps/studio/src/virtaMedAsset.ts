import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { publicUrl } from "./api";
import { VIRTAMED_ORGANS, VIRTAMED_VERSION } from "./virtaMedScene";
export async function loadVirtaMedAsset(signal?:AbortSignal) {
  const init={signal:signal??null};
  const [mr,gr]=await Promise.all([fetch(publicUrl("anatomy-scene/virtamed-manifest.json"),init),fetch(publicUrl("anatomy-scene/virtamed-scene.glb"),init)]);
  if(!mr.ok||!gr.ok)throw new Error("The VirtaMed scene asset could not be loaded.");
  const [manifest,buffer]=await Promise.all([mr.json(),gr.arrayBuffer()]);
  const digest=await crypto.subtle.digest("SHA-256",buffer),sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  if(manifest.version!==VIRTAMED_VERSION||manifest.sha256!==sha256||manifest.bytes!==buffer.byteLength)throw new Error("The video-field asset failed its integrity check.");
  signal?.throwIfAborted();
  const gltf=await new GLTFLoader().parseAsync(buffer,"");
  const names=gltf.scene.children.map(c=>c.name).sort();
  if(signal?.aborted || JSON.stringify(names)!==JSON.stringify(VIRTAMED_ORGANS.map(o=>o.id).sort())){
    gltf.scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const material of Array.isArray(o.material)?o.material:[o.material])material.dispose();}});
    signal?.throwIfAborted();throw new Error("The video-field scene is incomplete.");
  }
  return {root:gltf.scene,manifest:{...manifest,organs:VIRTAMED_ORGANS},sha256,bytes:buffer.byteLength};
}
