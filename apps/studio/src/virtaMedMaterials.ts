import { operativeBloodTexture, OPERATIVE_BLOOD_GLSL, OPERATIVE_BLOOD_PROVENANCE } from "./operativeBloodOptics";
import { OPERATIVE_APPEARANCE_VERSION, OPERATIVE_REGION_GLSL, OPERATIVE_LAYER_GLSL, operativeStrength, type OperativeAppearance } from "./operativeAppearance";
import * as THREE from "three";
import { serosalVascularTexture, VIRTAMED_SURFACE_VERSION } from "./virtaMedVasculature";
import { interfaceMaterialRecipe as tissueRecipe, interfaceVariation, VIRTAMED_INTERFACE_VERSION, type InterfaceField } from "./virtaMedInterfaces";
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
const arrays=new WeakMap<VirtaMedTiles,{color:THREE.DataArrayTexture;surface:THREE.DataArrayTexture}>();
function tissueArrays(tiles:VirtaMedTiles) {
  let result=arrays.get(tiles);if(result)return result;
  const families=["liver","large_bowel","small_bowel"],size=512*512*4;
  const color=new Uint8Array(size*3),surface=new Uint8Array(size*3);
  families.forEach((family,layer)=>{const tile=tiles[family]!;color.set(tile.color.image.data as Uint8Array,layer*size);
    const normal=tile.normal.image.data as Uint8Array,rough=tile.roughness.image.data as Uint8Array;
    for(let i=0;i<size;i+=4){surface.set(normal.subarray(i,i+3),layer*size+i);surface[layer*size+i+3]=rough[i+1]!;}
  });
  const make=(data:Uint8Array,srgb:boolean)=>{const t=new THREE.DataArrayTexture(data,512,512,3);t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;t.anisotropy=8;t.needsUpdate=true;return t;};
  result={color:make(color,true),surface:make(surface,false)};arrays.set(tiles,result);return result;
}
export function disposeVirtaMedTiles(tiles:VirtaMedTiles){const a=arrays.get(tiles);a?.color.dispose();a?.surface.dispose();arrays.delete(tiles);for(const t of Object.values(tiles)){t.color.dispose();t.normal.dispose();t.roughness.dispose();}}

export function makeVirtaMedMaterial(id:string,white:boolean,tiles:VirtaMedTiles|null,volume:THREE.Data3DTexture,sample:VirtaMedVariation|null,fields:InterfaceField[]=[],operative?:OperativeAppearance|null,operativeAmount=.5) {
  const operativeLevel=operativeStrength(operativeAmount);
  const info=VIRTAMED_ORGANS.find(x=>x.id===id)!,tile=tiles?.[bundles[id]!],tissueIndex=(name:string)=>VIRTAMED_ORGANS.findIndex(o=>o.id===name);
  const material=white?whiteVirtaMedMaterial():new THREE.MeshPhysicalMaterial({color:info.color,metalness:0,roughness:.35,ior:1.37,clearcoat:.48,clearcoatRoughness:.19,specularIntensity:.6,envMapIntensity:.25,side:THREE.DoubleSide});
  // Inward shell is visible from the cavity; its exterior is culled for orbit inspection.
  if(id==="abdominal-wall"){material.side=THREE.FrontSide;material.shadowSide=THREE.FrontSide;material.envMapIntensity=0;}
  material.userData.selectionUniform={value:0};
  material.userData.appearance={operative: {version:OPERATIVE_APPEARANCE_VERSION,amount:white?0:operativeLevel,model:operative?.model??null,sha256:operative?.sha256??null,optics:OPERATIVE_BLOOD_PROVENANCE,coordinates:"shared undeformed surface",transport:"static attached appearance; no fluid solver"},mode:white?"white geometry":tile?"verified learned RGB; derived normal and assumed roughness":"authored tissue optics",bundle:tile?.bundle??null,sha256:tile?.sha256??null,resolution:tile?512:null,interfaces:fields.map(f=>({id:f.edge.id,...interfaceVariation(f.edge,sample)}))};
  const disease=sample?.variation.baseline?"baseline":sample?.disease??"baseline",severity=sample?.variation.baseline?0:sample?.variation.severity??0;
  const kind=disease==="liver-steatotic-enlargement"?1:disease==="liver-cirrhosis"?2:disease==="liver-metastases"?3:disease==="gallbladder-cholecystitis"?4:disease==="gallbladder-distension"?5:0;
  const palette=VIRTAMED_ORGANS.map(o=>new THREE.Color(o.color)),optics:THREE.Vector4[]=[],patterns:THREE.Vector4[]=[];
  for(const organ of VIRTAMED_ORGANS){const recipe=tissueRecipe(organ.id,sample),wall=organ.id==="abdominal-wall",rough=wall?.48:organ.id==="liver"?.29:.35;
    optics.push(new THREE.Vector4(THREE.MathUtils.clamp(.85*rough+.15*(1-recipe.wetness),.26,.7),wall?.28:.65+.28*recipe.wetness,.11+.08*(1-recipe.wetness),THREE.MathUtils.clamp(recipe.pigment_contrast,.6,1.5)));
    patterns.push(new THREE.Vector4(recipe.tint,recipe.fine_detail,0,0));
  }
  const edgeRecipes=fields.map(f=>({edge:f.edge.id,a:tissueRecipe(f.edge.a,sample),b:tissueRecipe(f.edge.b,sample),...interfaceVariation(f.edge,sample)}));
  material.customProgramCacheKey=()=>`${VIRTAMED_SURFACE_VERSION}:${OPERATIVE_APPEARANCE_VERSION}:${Boolean(operative)}:${white}:${Boolean(tiles)}:${id}:${fields.map(f=>f.edge.id).join(":")}`;
  material.onBeforeCompile=shader=>{
    shader.uniforms.uVmSelect=material.userData.selectionUniform;
    shader.vertexShader=shader.vertexShader.replace("#include <common>","#include <common>\nattribute vec3 sceneRestPosition;attribute vec3 sceneRestNormal;attribute vec4 sceneInterfaceDistance;attribute vec3 sceneCoverDistance;varying vec3 vVmCoverDistance;varying vec3 vVmRest;varying vec3 vVmRestNormal;varying vec4 vVmInterfaceDistance;").replace("#include <begin_vertex>","#include <begin_vertex>\nvVmRest=sceneRestPosition;vVmRestNormal=sceneRestNormal;vVmInterfaceDistance=sceneInterfaceDistance;vVmCoverDistance=sceneCoverDistance;");
    shader.fragmentShader=shader.fragmentShader.replace("#include <common>","#include <common>\nvarying vec3 vVmRest;varying vec3 vVmRestNormal;varying vec4 vVmInterfaceDistance;varying vec3 vVmCoverDistance;uniform float uVmSelect;");
    if(white){shader.fragmentShader=shader.fragmentShader.replace("#include <color_fragment>","#include <color_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.6,.8,.9),uVmSelect*.09);");return;}
    const atlas=tiles?tissueArrays(tiles):null;
    Object.assign(shader.uniforms,{uVmOperativeThreshold:{value:operative?.redThreshold??.33},uVmOperative:{value:operative?.texture},uVmOperativeStrength:{value:operative?operativeLevel:0},uOperativeBlood:{value:operativeBloodTexture(volume)},uVmVolume:{value:volume},uVmVessels:{value:serosalVascularTexture(volume)},uVmColorArray:{value:atlas?.color},uVmSurfaceArray:{value:atlas?.surface},uVmPalette:{value:palette},uVmOptics:{value:optics},uVmPattern:{value:patterns},uVmMeans:{value:["liver","large_bowel","small_bowel"].map(f=>tiles?.[f]?.mean??new THREE.Vector3(1,1,1))},uVmDisease:{value:kind},uVmSeverity:{value:severity},uVmOffset:{value:sample?.variation.baseline?0:((sample?.variation.seed??0)%997)/31},uVmWidth:{value:new THREE.Vector4(...[0,1,2,3].map(i=>fields[i]?interfaceVariation(fields[i]!.edge,sample).widthMm:1) as [number,number,number,number])}});
    shader.fragmentShader=shader.fragmentShader.replace("#include <common>",`#include <common>
      precision highp sampler3D;precision highp sampler2DArray;
      ${OPERATIVE_BLOOD_GLSL}
      ${OPERATIVE_REGION_GLSL}
      uniform sampler2D uVmOperative;uniform float uVmOperativeStrength;uniform float uVmOperativeThreshold;
      uniform sampler3D uVmVolume;uniform sampler2D uVmVessels;
      uniform sampler2DArray uVmColorArray;uniform sampler2DArray uVmSurfaceArray;
      uniform vec3 uVmPalette[12];uniform vec4 uVmOptics[12];uniform vec4 uVmPattern[12];uniform vec3 uVmMeans[3];
      uniform int uVmDisease;uniform float uVmSeverity;uniform float uVmOffset;uniform vec4 uVmWidth;
      struct VmSurface {vec3 color;vec3 gradient;float height;float roughness;float coat;float coatRoughness;float exposure;};
      VmSurface vmMix(VmSurface a,VmSurface b,float w){return VmSurface(mix(a.color,b.color,w),mix(a.gradient,b.gradient,w),mix(a.height,b.height,w),mix(a.roughness,b.roughness,w),mix(a.coat,b.coat,w),mix(a.coatRoughness,b.coatRoughness,w),mix(a.exposure,b.exposure,w));}
      vec3 vmWeights(vec3 n){vec3 w=pow(abs(normalize(n+vec3(1e-8))),vec3(4.));return w/max(dot(w,vec3(1.)),.001);}
      vec4 vmProjection(sampler2D t,vec3 p,vec3 w,vec3 dx,vec3 dy){return textureGrad(t,p.yz,dx.yz,dy.yz)*w.x+textureGrad(t,p.xz+vec2(.23,.37),dx.xz,dy.xz)*w.y+textureGrad(t,p.xy+vec2(.61,.19),dx.xy,dy.xy)*w.z;}
      vec3 vmBump(vec3 n,vec2 slope,float face){vec3 dx=dFdx(-vViewPosition),dy=dFdy(-vViewPosition),r1=cross(dy,n),r2=cross(n,dx);float det=dot(dx,r1)*face;if(abs(det)<1e-12)return n;return normalize(abs(det)*n-sign(det)*(slope.x*r1+slope.y*r2));}
      VmSurface vmEvaluate(int organ,vec3 p,vec3 w,vec3 dx,vec3 dy,vec4 cloud,vec4 fine,float fade,vec4 vascular){
        vec4 optics=uVmOptics[organ];vec4 pattern=uVmPattern[organ];vec3 rgb=uVmPalette[organ]*(.9+.2*cloud.r),gradient=vec3(0.);float roughness=optics.x;float vessels=max(vascular.r,vascular.g);
        int layer=organ==0?0:organ==5?1:(organ==6||organ==7)?2:-1;
        ${tiles?`if(layer>=0){vec3 tp=p/51.2+vec3(uVmOffset*.13,uVmOffset*.07,uVmOffset*.11);vec3 tx=dx/51.2,ty=dy/51.2;
          vec3 color=textureGrad(uVmColorArray,vec3(tp.yz,float(layer)),tx.yz,ty.yz).rgb*w.x+textureGrad(uVmColorArray,vec3(tp.xz+vec2(.23,.37),float(layer)),tx.xz,ty.xz).rgb*w.y+textureGrad(uVmColorArray,vec3(tp.xy+vec2(.61,.19),float(layer)),tx.xy,ty.xy).rgb*w.z;
          rgb=uVmPalette[organ]*mix(vec3(1.),clamp(color/max(uVmMeans[layer],vec3(.025)),vec3(.55),vec3(1.6)),(organ==0?.45:.7)*optics.w);
          vec4 sx=textureGrad(uVmSurfaceArray,vec3(tp.yz,float(layer)),tx.yz,ty.yz),sy=textureGrad(uVmSurfaceArray,vec3(tp.xz+vec2(.23,.37),float(layer)),tx.xz,ty.xz),sz=textureGrad(uVmSurfaceArray,vec3(tp.xy+vec2(.61,.19),float(layer)),tx.xy,ty.xy);
          vec3 nx=sx.xyz*2.-1.,ny=sy.xyz*2.-1.,nz=sz.xyz*2.-1.;vec2 gx=-nx.xy/max(nx.z,.15),gy=-ny.xy/max(ny.z,.15),gz=-nz.xy/max(nz.z,.15);
          gradient=vec3(gy.x*w.y+gz.x*w.z,gx.x*w.x+gz.y*w.z,gx.y*w.x+gy.y*w.y)*(.008+.008*pattern.y)*fade;
          roughness=clamp(roughness*(.8+.4*(sx.a*w.x+sy.a*w.y+sz.a*w.z)),.26,.55);
        }`:""}
        rgb*=1.+(fine.r-.5)*.1*fade;
        if(organ==0)rgb*=.91+.16*cloud.r+.09*(1.-smoothstep(.025,.16,cloud.b));
        if(organ==8){rgb*=vec3(1.04,.98,.78)*(.85+.3*cloud.g);rgb=mix(rgb,rgb*vec3(1.05,.91,.82),(1.-smoothstep(.035,.2,cloud.b))*.22);}
        float fibers=texture(uVmVolume,fract(p/vec3(4.,42.,5.))).r;
        if(organ==9||organ==10)rgb*=.94+.12*fibers;
        // Peritoneum covers irregular subperitoneal fat and pale fascial strands.
        // Shared 3-D rest coordinates keep these layers attached during deformation.
        float wallFat=0.;
        if(organ==11){
          vec4 broad=texture(uVmVolume,fract(p/vec3(115.,92.,105.)));
          wallFat=smoothstep(.28,.69,broad.g+.13*(cloud.g-.5));
          float fascia=smoothstep(.56,.8,broad.r+.16*fibers)*(1.-wallFat*.7);
          rgb=mix(vec3(.53,.30,.24),vec3(.58,.37,.18),wallFat*.65);
          rgb=mix(rgb,vec3(.65,.47,.38),fascia*.5);
          rgb*=.90+.16*cloud.r+.06*fine.r*fade;
          roughness=mix(.47,.39,wallFat)+.06*(1.-cloud.a);
        }
        if(organ==1){float mottle=smoothstep(.15,.85,cloud.r+(fine.a-.5)*.2);rgb=mix(vec3(.3712,.3515,.4233),vec3(.5149,.4678,.4072),mottle*.8)*(.93+.14*fine.r);rgb*=.97+.06*fine.a*fade;}
        rgb*=vec3(1.+pattern.x*.08,1.+pattern.x*.025,1.-pattern.x*.035);
        float mask=1.;vec3 diseaseColor=vec3(0.);
        if(organ==0&&uVmDisease>0&&uVmDisease<=3){
          if(uVmDisease==1)diseaseColor=vec3(.4233,.2423,.0844);
          if(uVmDisease==2){diseaseColor=vec3(.3185,.2086,.1221);mask=.35+.65*(sin(p.x*.43)*sin(p.y*.39)*sin(p.z*.37)*.5+.5);}
          if(uVmDisease==3){diseaseColor=vec3(.5395,.4564,.3231);vec3 a=(p-vec3(-85.,53.,19.))/vec3(9.,10.,15.),b=(p-vec3(36.,54.,9.))/vec3(9.,10.,15.),c=(p-vec3(-28.,31.,18.))/vec3(9.,10.,15.);mask=exp(-dot(a,a))+exp(-dot(b,b))+exp(-dot(c,c));}
          rgb=mix(rgb,diseaseColor,clamp(mask*uVmSeverity*.65,0.,.8));
        }
        if(organ==1&&uVmDisease>=4)rgb=mix(rgb,uVmDisease==4?vec3(.4125,.1384,.1170):vec3(.4287,.3916,.2159),uVmSeverity*.65);
        // Vessels sit below the capsule: distinct arterial/venous color and a
        // wider low-contrast halo, applied AFTER organ pigmentation and disease.
        float vesselStrength=organ==11?.42:organ==1?.48:organ==8?.55:(organ==9||organ==10)?.58:.78;
        if(organ!=0){
          float congestion=organ==1&&uVmDisease==4?1.+uVmSeverity*.6:1.;
          rgb*=mix(vec3(1.),vec3(1.,.78,.76),vascular.b*.2*congestion);
          rgb=mix(rgb,rgb*vec3(.52,.13,.18),clamp(vascular.r*vesselStrength*congestion,0.,.9));
          rgb=mix(rgb,rgb*vec3(.42,.22,.34),clamp(vascular.g*vesselStrength*.85*congestion,0.,.85));
        }
        float relief=organ==8?.038:organ==1?.009:(organ==9||organ==10)?.012:.016;
        float height=organ==11?(cloud.r*.012+fine.r*.003+cloud.a*.006)*fade:(fine.r*relief+cloud.r*(organ==8?.06:.035)+cloud.a*(organ==0?.025:organ==1?.03:.06))*(.6+.8*pattern.y)*fade+(organ==0?0.:vascular.a*.018);
        if(organ==9||organ==10)height+=fibers*.045*fade;
        // A spatially varying wet film breaks up a uniform plastic highlight.
        float film=clamp(.38+.62*cloud.a+.18*(fine.a-.5)*fade,0.,1.);
        roughness=clamp(roughness*(.9+.22*(1.-film)),.24,.7);
        return VmSurface(rgb,gradient,height,roughness,optics.y*(.8+.2*film),clamp(optics.z*(.68+.68*(1.-film)),.09,.3),operativeSupport(organ,p));
      }
    `);
    shader.fragmentShader=shader.fragmentShader.replace("#include <color_fragment>",`#include <color_fragment>
      vec3 vmDx=dFdx(vVmRest),vmDy=dFdy(vVmRest),vmW=vmWeights(vVmRestNormal);
      float vmFade=1.-smoothstep(.25,1.2,max(length(vmDx),length(vmDy)));
      vec4 vmCloud=texture(uVmVolume,fract(vVmRest/24.)),vmFine=texture(uVmVolume,fract(vVmRest/7.5));
      vec3 vmVesselP=vVmRest/82.+vec3(uVmOffset*.071,uVmOffset*.037,uVmOffset*.053);
      vec4 vmV=vmProjection(uVmVessels,vmVesselP,vmW,vmDx/82.,vmDy/82.);
      vec4 vmCapillary=vmProjection(uVmVessels,vmVesselP*1.83+vec3(.31,.47,.13),vmW,vmDx/44.8,vmDy/44.8);
      vmV=max(vmV,vmCapillary*vec4(.26,.26,.18,.08));
      VmSurface vmS=vmEvaluate(${tissueIndex(id)},vVmRest,vmW,vmDx,vmDy,vmCloud,vmFine,vmFade,vmV);float vmTotal=1.;
      ${fields.map((f,i)=>`if(vVmInterfaceDistance[${i}]<uVmWidth[${i}]){
        float w=1.-smoothstep(0.,uVmWidth[${i}],vVmInterfaceDistance[${i}]);float strength=w/max(1.-w,.00001);
        VmSurface a=vmEvaluate(${tissueIndex(f.edge.a)},vVmRest,vmW,vmDx,vmDy,vmCloud,vmFine,vmFade,vmV);
        VmSurface b=vmEvaluate(${tissueIndex(f.edge.b)},vVmRest,vmW,vmDx,vmDy,vmCloud,vmFine,vmFade,vmV);
        VmSurface joint=vmMix(a,b,.5);vmS=vmMix(vmS,joint,strength/(vmTotal+strength));vmTotal+=strength;
      }`).join("\n")}
      ${id==="hepatocystic-fat"?[5,6,7].map((organ,i)=>`if(vVmCoverDistance[${i}]<6.){
        float width=4.8+.6*(uVmOptics[8].y+uVmOptics[${organ}].y)+.3*(uVmPattern[8].y+uVmPattern[${organ}].y);
        float coverage=(1.-smoothstep(0.,width,vVmCoverDistance[${i}]))*.9;
        VmSurface under=vmEvaluate(${organ},vVmRest,vmW,vmDx,vmDy,vmCloud,vmFine,vmFade,vmV);vmS=vmMix(vmS,under,coverage);
      }`).join("\n"):""}
      ${operative?OPERATIVE_LAYER_GLSL:"float vmFilmLevel=0.;vec2 vmFilmSlope=vec2(0.);"}
      diffuseColor.rgb=mix(vmS.color,vec3(.6,.8,.9),uVmSelect*.09);
      vec2 vmSlope=vec2(dot(vmS.gradient,vmDx)+dFdx(vmS.height),dot(vmS.gradient,vmDy)+dFdy(vmS.height));
    `);
    shader.fragmentShader=shader.fragmentShader.replace("#include <roughnessmap_fragment>","#include <roughnessmap_fragment>\nroughnessFactor=vmS.roughness;");
    shader.fragmentShader=shader.fragmentShader.replace("#include <normal_fragment_maps>","#include <normal_fragment_maps>\nnormal=vmBump(normal,vmSlope,faceDirection);");
    shader.fragmentShader=shader.fragmentShader.replace("#include <clearcoat_normal_fragment_maps>","#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nclearcoatNormal=vmBump(clearcoatNormal,vmSlope*(.8*(1.-vmFilmLevel*.8))+vmFilmSlope,faceDirection);\n#endif");
    shader.fragmentShader=shader.fragmentShader.replace("#include <lights_physical_fragment>","#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.specularColor=mix(material.specularColor,vec3(.0001874),vmFilmLevel);material.specularColorBlended=material.specularColor;material.clearcoatF0=vec3(.02037);material.clearcoat=vmS.coat;material.clearcoatRoughness=clamp(vmS.coatRoughness+geometryRoughness,.0525,1.);\n#endif");
  };
  return {material,signature:JSON.stringify({id,white,tile:tile?.sha256,disease,severity,seed:sample?.variation.seed,interfaces:edgeRecipes,covers:id==="hepatocystic-fat"?["colon","small-intestine","duodenum"].map(i=>tissueRecipe(i,sample)):[],interfaceVersion:VIRTAMED_INTERFACE_VERSION,surfaceVersion:VIRTAMED_SURFACE_VERSION,operativeVersion:OPERATIVE_APPEARANCE_VERSION,operativeAmount:operativeLevel,operativeHash:operative?.sha256})};
}
