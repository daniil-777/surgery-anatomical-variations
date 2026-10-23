import * as THREE from "three";
import { createFatMaterial, updateFatAppearance, disposeFatMaps, fatDataTexture, type FatMaps, type FatSurfaceStudy } from "./material";
import { warpScenePositions, type WholeSceneVariation } from "../wholeSceneModel";
import type { WholeScenePhysics, ScenePhysicsBinding } from "../wholeScenePhysics";
import type { FatLayerDiagnostics, FatLayerResult } from "./sceneLayers";

export interface FatSceneOptions {
  enabled: boolean; seed: number; thicknessMm: number; omentum: boolean; perirenal: boolean;
  lighting?: "studio" | "surgical" | "grazing";
  study?: FatSurfaceStudy; wetness?: number;
}
interface Source { id: string; mesh: THREE.Mesh; rest: Float32Array }
interface Layer { id:string; regionMap:THREE.DataTexture|null; mesh:THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>;rest:Float32Array;variant:Float32Array;binding:ScenePhysicsBinding|null }
/** Optional, independently owned scene layer. Atlas source geometries are never modified. */
export class FatSceneLayerView {
  private readonly group=new THREE.Group();
  private layers:Layer[]=[];
  private maps:FatMaps|null=null;
  private worker:Worker|null=null;
  private geometryWorker:Worker|null=null;
  private geometryReject:((error:Error)=>void)|null=null;
  private pendingCleanup:(()=>void)|null=null;
  private cancelBake(){this.geometryWorker?.terminate();this.geometryWorker=null;this.geometryReject?.(new DOMException("Layer generation cancelled","AbortError"));this.geometryReject=null;this.worker?.terminate();this.worker=null;this.pendingCleanup?.();this.pendingCleanup=null;}
  private generation=0;
  private disposed=false;
  private key="";
  private options:FatSceneOptions={enabled:false,seed:42,thicknessMm:5,omentum:true,perirenal:true};
  private variation:WholeSceneVariation;
  private physics:WholeScenePhysics|null=null;
  private diagnostics:FatLayerDiagnostics|null=null;
  private state="disabled";
  constructor(private parent:THREE.Object3D,private source:()=>Source[],variation:WholeSceneVariation,private changed:()=>void,private failed:(message:string)=>void){this.variation=variation;this.group.name="Experimental adipose layers";parent.add(this.group);}
  snapshot(){return {enabled:this.options.enabled,status:this.state,options:this.options,layers:this.layers.map(l=>({id:l.id,visible:l.mesh.visible,vertices:l.rest.length/3,metadata:l.mesh.geometry.userData,regionTextureResolution:l.regionMap?.image.width??0})),diagnostics:this.diagnostics,motion:"Shared atlas warp / interpolated scene motion; no fat contact solve",textureResolution:this.maps?.resolution??0};}
  bounds(id:string){const layer=this.layers.find(item=>item.id===id);return layer?.mesh.geometry.boundingBox?.clone()??null;}
  configure(options:FatSceneOptions){
    this.options=options;this.group.visible=options.enabled;
    const key=`${options.seed}:${options.thicknessMm}`;
    if(!options.enabled){this.generation++;this.cancelBake();if(this.state==="building")this.key="";this.state="disabled";this.changed();return;}
    if(key!==this.key){this.key=key;void this.build();}else{this.state=this.layers.length?"ready":this.state;this.visibility();this.changed();}
  }
  private visibility(){for(const layer of this.layers){layer.mesh.visible=layer.id.includes("omentum")?this.options.omentum:this.options.perirenal;updateFatAppearance(layer.mesh.material,this.options.wetness??.52,this.options.study??"tissue");}}
  private clear(){for(const layer of this.layers){layer.mesh.geometry.dispose();layer.mesh.material.dispose();layer.regionMap?.dispose();}this.group.clear();this.layers=[];disposeFatMaps(this.maps);this.maps=null;}
  private async build(){
    const version=++this.generation;this.cancelBake();this.clear();this.diagnostics=null;this.state="building";this.changed();
    const regionMaps=new Map<string,THREE.DataTexture>();
    try{
      const result=await new Promise<FatLayerResult>((resolve,reject)=>{
        const worker=new Worker(new URL("./sceneLayers.worker.ts",import.meta.url),{type:"module"});this.geometryWorker=worker;this.geometryReject=reject;
        const transfer:ArrayBuffer[]=[];
        const sources=this.source().map(part=>{const positions=part.rest.slice(),indices=part.mesh.geometry.index?Uint32Array.from(part.mesh.geometry.index.array):null;transfer.push(positions.buffer);if(indices)transfer.push(indices.buffer);return{id:part.id,positions,indices};});
        worker.onmessage=(event:MessageEvent<{error?:string;diagnostics:FatLayerDiagnostics;geometries:{id:string;label:string;positions:Float32Array;normals:Float32Array;indices:Uint32Array;thicknessMm:Float32Array;columnThicknessMm:Float32Array;regions:Float32Array;depotUvs:Float32Array;regionTexture:{data:Uint8Array;resolution:number}|null;metadata:Record<string,unknown>}[]}>)=>{
          if(version!==this.generation||this.disposed){worker.terminate();return;}
          worker.terminate();this.geometryWorker=null;this.geometryReject=null;
          if(event.data.error){reject(new Error(event.data.error));return;}
          const geometries=event.data.geometries.map(layer=>{if(layer.regionTexture){const texture=fatDataTexture(layer.regionTexture.data,layer.regionTexture.resolution);texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;regionMaps.set(layer.id,texture);}const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.BufferAttribute(layer.positions,3));geometry.setAttribute("fatRestPosition",new THREE.BufferAttribute(layer.positions.slice(),3));geometry.setAttribute("fatRestNormal",new THREE.BufferAttribute(layer.normals.slice(),3));geometry.setAttribute("fatThicknessMm",new THREE.BufferAttribute(layer.thicknessMm,1));geometry.setAttribute("fatColumnThicknessMm",new THREE.BufferAttribute(layer.columnThicknessMm,1));geometry.setAttribute("fatRegion",new THREE.BufferAttribute(layer.regions,3));geometry.setAttribute("fatDepotUv",new THREE.BufferAttribute(layer.depotUvs,2));geometry.userData=layer.metadata;geometry.setAttribute("normal",new THREE.BufferAttribute(layer.normals,3));geometry.setIndex(new THREE.BufferAttribute(layer.indices,1));geometry.computeBoundingBox();geometry.computeBoundingSphere();return{id:layer.id,label:layer.label,geometry};});
          resolve({geometries,diagnostics:event.data.diagnostics});
        };
        worker.onerror=event=>{if(version!==this.generation||this.disposed){worker.terminate();return;}worker.terminate();this.geometryWorker=null;this.geometryReject=null;reject(new Error(event.message||"Fat geometry worker failed"));};
        worker.postMessage({sources,config:{seed:this.options.seed,thicknessMm:this.options.thicknessMm}},transfer);
      });
      if(version!==this.generation||this.disposed){result.geometries.forEach(l=>l.geometry.dispose());regionMaps.forEach(map=>map.dispose());return;}
      this.diagnostics=result.diagnostics;
      const pending:Partial<FatMaps>={resolution:1024};
      const worker=new Worker(new URL("./texture.worker.ts",import.meta.url),{type:"module"});this.worker=worker;
      // Keep pending textures/geometries under a single cleanup owner, including cancellations.
      const cleanup=()=>{if(pending.color)pending.color.dispose();if(pending.height)pending.height.dispose();if(pending.roughness)pending.roughness.dispose();result.geometries.forEach(l=>l.geometry.dispose());regionMaps.forEach(map=>map.dispose());regionMaps.clear();};
      this.pendingCleanup=cleanup;
      worker.onmessage=(event:MessageEvent<{map?:"color"|"height"|"roughness";data?:Uint8Array;done?:boolean;error?:string}>)=>{
        if(version!==this.generation||this.disposed){worker.terminate();return;}
        const m=event.data;
        if(m.error){this.cancelBake();this.state="error";this.key="";this.failed(m.error);this.changed();return;}
        if(m.map&&m.data)pending[m.map]=fatDataTexture(m.data,1024,m.map==="color");
        if(m.done&&pending.color&&pending.height&&pending.roughness){
          this.maps=pending as FatMaps;this.pendingCleanup=null;this.cancelBake();
          this.layers=result.geometries.map(layer=>{const material=createFatMaterial(this.maps!,this.options.wetness??.52,undefined,this.options.study??"tissue",true,regionMaps.get(layer.id)??null);const mesh=new THREE.Mesh(layer.geometry,material);mesh.name=layer.label;mesh.castShadow=true;mesh.receiveShadow=false;this.group.add(mesh);const rest=new Float32Array(layer.geometry.getAttribute("position").array);return {id:layer.id,mesh,rest,variant:rest.slice(),binding:null,regionMap:regionMaps.get(layer.id)??null};});
          this.warp(this.variation);this.visibility();this.state="ready";this.changed();
        }
      };
      worker.onerror=event=>{if(version!==this.generation||this.disposed){worker.terminate();return;}this.cancelBake();this.key="";this.state="error";this.failed(event.message||"Fat layer texture failed");this.changed();};
      // Major vessels follow geometry-linked depot fields. Sparse fine vessels
      // remain in the texture; reducing them avoids two competing vascular trees.
      worker.postMessage({config:{preset:"omental",textureSeed:this.options.seed,vascularity:.18,septaStrength:.65,normalStrength:.7},resolution:1024});
    }catch(error){regionMaps.forEach(map=>map.dispose());if(!this.disposed&&version===this.generation){this.state="error";this.key="";this.failed(`Fat layers: ${error instanceof Error?error.message:String(error)}`);this.changed();}}
  }
  warp(variation:WholeSceneVariation){this.variation=variation;for(const layer of this.layers){layer.variant=warpScenePositions(layer.rest,variation);layer.binding=this.physics?.bind(layer.variant)??null;}this.sync(true);}
  bind(physics:WholeScenePhysics|null){this.physics=physics;for(const layer of this.layers)layer.binding=physics?.bind(layer.variant)??null;this.sync(true);}
  sync(normals=false,breath=0){
    for(const layer of this.layers){const attr=layer.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;const positions=attr.array as Float32Array;
      if(this.physics&&layer.binding)this.physics.deform(layer.variant,positions,layer.binding);else{positions.set(layer.variant);if(breath)for(let i=0;i<positions.length;i+=3){const envelope=Math.exp(-(((positions[i+1]!-60)/230)**2));positions[i]!*=1+breath*.004*envelope;positions[i+2]!*=1+breath*.012*envelope;positions[i+1]!-=breath*1.4*envelope;}}
      attr.needsUpdate=true;if(normals)layer.mesh.geometry.computeVertexNormals();layer.mesh.geometry.computeBoundingBox();layer.mesh.geometry.computeBoundingSphere();
    }
  }
  dispose(){this.disposed=true;this.generation++;this.cancelBake();this.clear();this.parent.remove(this.group);}
}
