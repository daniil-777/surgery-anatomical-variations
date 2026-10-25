import * as THREE from "three";
import { publicUrl } from "./api";
import { synthesizeSeamlessOrganTile, type RgbaImage } from "./tissues/organMeshBake";
import { VIRTAMED_ORGANS, whiteVirtaMedMaterial, type VirtaMedVariation } from "./virtaMedScene";

export interface VirtaMedTile { color:THREE.DataTexture; roughness:THREE.DataTexture; normal:THREE.DataTexture; mean:THREE.Vector3; sha256:string; bundle:string }
export type VirtaMedTiles=Record<string,VirtaMedTile>;
const bundles:Record<string,string>={liver:"liver",colon:"large_bowel","small-intestine":"small_bowel",duodenum:"small_bowel"};
function texture(img:RgbaImage,srgb=false) {
  const t=new THREE.DataTexture(img.data,img.width,img.height);t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;t.anisotropy=8;t.needsUpdate=true;return t;
}
export async function loadVirtaMedTiles(signal?:AbortSignal):Promise<VirtaMedTiles> {
  const result:VirtaMedTiles={};
  try {
    // Serial so cancellation never leaves pending GPU allocations after cleanup.
    for(const family of new Set(Object.values(bundles))){
      const bundle=`learned-guided-${family}-s1`,prefix=publicUrl(`tissue-materials/${bundle}/preview/`);
      const manifestResponse=await fetch(`${prefix}manifest.json`,{signal:signal ?? null});if(!manifestResponse.ok)throw new Error("Learned tissue manifest could not be loaded.");
      const manifest=await manifestResponse.json(),channel=manifest.channels?.base_color;
      if(manifest.generator!=="viscera.tissue-lora/v1"||manifest.resolution?.[0]!==512||channel?.file!=="base_color.png"||!/^[a-f0-9]{64}$/.test(channel.sha256))throw new Error("Learned tissue manifest failed validation.");
      const response=await fetch(`${prefix}base_color.png`,{signal:signal ?? null});if(!response.ok)throw new Error("Learned appearance image could not be loaded.");
      const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest("SHA-256",bytes);
      const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
      if(hash!==channel.sha256)throw new Error("Learned appearance checksum mismatch.");
      const bitmap=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
      const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext("2d",{willReadFrequently:true});if(!ctx){bitmap.close();throw new Error("Image decoding unavailable.");}
      ctx.drawImage(bitmap,0,0);bitmap.close();
      const source=ctx.getImageData(0,0,canvas.width,canvas.height);
      const maps=synthesizeSeamlessOrganTile({width:canvas.width,height:canvas.height,data:source.data},{wetness:.63});
      signal?.throwIfAborted();
      result[family]={color:texture(maps.image,true),normal:texture(maps.normal),roughness:texture(maps.roughness),mean:new THREE.Vector3(...maps.meanLinear),sha256:hash,bundle};
    }
    return result;
  }catch(error){disposeVirtaMedTiles(result);throw error;}
}
export function disposeVirtaMedTiles(tiles:VirtaMedTiles){for(const t of Object.values(tiles)){t.color.dispose();t.normal.dispose();t.roughness.dispose();}}
export function makeVirtaMedMaterial(id:string,white:boolean,tiles:VirtaMedTiles|null,volume:THREE.Data3DTexture,sample:VirtaMedVariation|null) {
  const info=VIRTAMED_ORGANS.find(x=>x.id===id)!;
  const tile=tiles?.[bundles[id]!];
  const material=white?whiteVirtaMedMaterial():new THREE.MeshPhysicalMaterial({
    color:info.color,metalness:0,roughness:id==="abdominal-wall"?.7:id==="liver"?.34:.39,ior:1.37,
    clearcoat:id==="abdominal-wall"?.04:.38,clearcoatRoughness:.24,specularIntensity:.5,envMapIntensity:.25,side:THREE.DoubleSide,
    transparent:id==="hepatoduodenal-ligament",opacity:id==="hepatoduodenal-ligament"?.8:1,
    depthWrite:id!=="hepatoduodenal-ligament",
  });
  material.userData.selectionUniform={value:0};
  material.userData.appearance={mode:white?"white geometry":tile?"verified learned RGB; derived normal and assumed roughness":"authored tissue optics",bundle:tile?.bundle??null,sha256:tile?.sha256??null,resolution:tile?512:null};
  const disease=sample?.variation.baseline?"baseline":sample?.disease??"baseline";
  const severity=sample?.variation.severity??0;
  const affected=disease.startsWith("liver")?id==="liver":disease.startsWith("gallbladder")?id==="gallbladder":false;
  const kind=disease==="liver-steatotic-enlargement"?1:disease==="liver-cirrhosis"?2:disease==="liver-metastases"?3:4;
  const color=disease==="liver-steatotic-enlargement"?"#ae8752":disease==="liver-cirrhosis"?"#997e62":disease==="liver-metastases"?"#c2b49a":disease==="gallbladder-cholecystitis"?"#ac6860":"#afa880";
  // Shape, pigmentation and wetness are conditioned by the same sampled recipe.
  const organRecipe=sample?.recipes?.[id] ?? sample?.recipe;
  const learnedWet=organRecipe ? 1-organRecipe.material.wetness : undefined;
  if(!white&&typeof learnedWet==="number")material.roughness=THREE.MathUtils.clamp(.85*material.roughness+.15*learnedWet,.26,.55);
  material.customProgramCacheKey=()=>`virtamed-v1:${white}:${Boolean(tile)}:${id}:${affected}:${kind}`;
  material.onBeforeCompile=shader=>{
    shader.uniforms.uVmSelect=material.userData.selectionUniform;
    shader.vertexShader=shader.vertexShader.replace("#include <common>","#include <common>\nattribute vec3 sceneRestPosition;varying vec3 vVmRest;").replace("#include <begin_vertex>","#include <begin_vertex>\nvVmRest=sceneRestPosition;");
    shader.fragmentShader=shader.fragmentShader.replace("#include <common>","#include <common>\nvarying vec3 vVmRest;uniform float uVmSelect;");
    shader.fragmentShader=shader.fragmentShader.replace("#include <color_fragment>","#include <color_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.6,.8,.9),uVmSelect*.09);");
    if(white)return;
    Object.assign(shader.uniforms,{uVmVolume:{value:volume},uVmVessels:{value:volume.userData.vascularTexture},uVmSeverity:{value:affected?severity:0},uVmDiseaseColor:{value:new THREE.Color(color)},uVmOffset:{value:sample?.variation.baseline?0:((sample?.variation.seed??0)%997)/31},uVmContrast:{value:organRecipe ? THREE.MathUtils.clamp(organRecipe.material.pigment_contrast,.6,1.5) : 1}});
    shader.fragmentShader=shader.fragmentShader.replace("#include <common>",`#include <common>
      precision highp sampler3D;
      uniform sampler3D uVmVolume;uniform sampler2D uVmVessels;
      uniform float uVmSeverity;uniform vec3 uVmDiseaseColor;uniform float uVmOffset;uniform float uVmContrast;
      ${tile?"uniform sampler2D uVmColor;uniform sampler2D uVmRough;uniform sampler2D uVmNormal;uniform vec3 uVmMean;":""}
      vec3 vmWeights(vec3 p){vec3 n=abs(normalize(cross(dFdx(p),dFdy(p))));vec3 w=pow(n,vec3(5.));return w/max(dot(w,vec3(1.)),.001);}
      vec4 vmSample(sampler2D m,vec3 p,vec3 w){return texture2D(m,p.yz)*w.x+texture2D(m,p.xz+vec2(.23,.37))*w.y+texture2D(m,p.xy+vec2(.61,.19))*w.z;}
    `);
    if(tile)Object.assign(shader.uniforms,{uVmColor:{value:tile.color},uVmRough:{value:tile.roughness},uVmNormal:{value:tile.normal},uVmMean:{value:tile.mean}});
    shader.fragmentShader=shader.fragmentShader.replace("#include <color_fragment>",`#include <color_fragment>
      vec3 vmP=vVmRest/51.2+vec3(uVmOffset*.13,uVmOffset*.07,uVmOffset*.11);vec3 vmW=vmWeights(vVmRest);
      vec4 vmCloud=texture(uVmVolume,fract(vVmRest/75.));
      ${tile?`vec3 vmRgb=vmSample(uVmColor,vmP,vmW).rgb; diffuseColor.rgb*=mix(vec3(1.),clamp(vmRgb/max(uVmMean,vec3(.025)),vec3(.55),vec3(1.6)),${id === "liver" ? ".28*uVmContrast" : ".65*uVmContrast"});`:"diffuseColor.rgb*=.93+.14*vmCloud.r;"}
      ${id!=="liver"&&id!=="abdominal-wall"?`float vmV=vmSample(uVmVessels,vVmRest/${id.includes("fat")?83:115}.,vmW).r;diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.72,.35,.30),vmV*${id.includes("fat")?".42":".6"});`:""}
      ${id.includes("fat") ? "vec4 lobule=texture(uVmVolume,fract(vVmRest/35.));diffuseColor.rgb*=.85+.3*lobule.g;diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.55,.39,.22),(.5-lobule.b)*.08);" : ""}
      ${id.includes("ligament") ? "float fibers=sin(vVmRest.x*2.+vmCloud.a*6.)*.5+.5;diffuseColor.rgb*=.99+.02*fibers;" : ""}
      ${id==="gallbladder" ? "vec4 capsule=texture(uVmVolume,fract(vVmRest/23.));diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.51,.49,.45),capsule.r*.25);" : ""}
      float vmMask=1.;
      ${kind===2?"vmMask=.35+.65*(sin(vVmRest.x*.43)*sin(vVmRest.y*.39)*sin(vVmRest.z*.37)*.5+.5);":""}
      ${kind===3?"vmMask=exp(-dot((vVmRest-vec3(-85.,53.,19.))/vec3(9.,10.,15.),(vVmRest-vec3(-85.,53.,19.))/vec3(9.,10.,15.)))+exp(-dot((vVmRest-vec3(36.,54.,9.))/vec3(9.,10.,15.),(vVmRest-vec3(36.,54.,9.))/vec3(9.,10.,15.)))+exp(-dot((vVmRest-vec3(-28.,31.,18.))/vec3(9.,10.,15.),(vVmRest-vec3(-28.,31.,18.))/vec3(9.,10.,15.)));":""}
      diffuseColor.rgb=mix(diffuseColor.rgb,uVmDiseaseColor,clamp(vmMask*uVmSeverity*.65,0.,.8));
    `);
    if(tile){
      shader.fragmentShader=shader.fragmentShader.replace("#include <roughnessmap_fragment>","#include <roughnessmap_fragment>\nroughnessFactor=clamp(roughnessFactor*(.8+.4*vmSample(uVmRough,vmP,vmW).g),.26,.55);");
      shader.fragmentShader=shader.fragmentShader.replace("#include <normal_fragment_maps>","#include <normal_fragment_maps>\nvec3 vmN=vmSample(uVmNormal,vmP,vmW).xyz*2.-1.;normal=normalize(normal+vec3(vmN.xy,0.)*.025);");
    }
    // Micrometre-scale authored relief in rest millimetres, attenuated when
    // smaller than a pixel. The wet coat remains smooth over this substrate.
    if(id!=="abdominal-wall")shader.fragmentShader=shader.fragmentShader.replace("#include <normal_fragment_maps>",`#include <normal_fragment_maps>
      float vmFootprint=max(length(dFdx(vVmRest)),length(dFdy(vVmRest)));
      float vmHeight=texture(uVmVolume,fract(vVmRest/7.5)).r*${id.includes("fat")?".045":".012"}*(1.-smoothstep(.12,.8,vmFootprint));
      vec3 vmDx=dFdx(-vViewPosition),vmDy=dFdy(-vViewPosition);
      vec3 vmR1=cross(vmDy,normal),vmR2=cross(normal,vmDx);
      float vmDet=dot(vmDx,vmR1)*faceDirection;
      normal=normalize(abs(vmDet)*normal-sign(vmDet)*(dFdx(vmHeight)*vmR1+dFdy(vmHeight)*vmR2));
    `);
  };
  return {material,signature:JSON.stringify({id,white,tile:tile?.sha256,disease,severity,seed:sample?.variation.seed})};
}
