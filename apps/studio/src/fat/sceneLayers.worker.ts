import * as THREE from "three";
import { createFatLayers, type FatLayerConfig } from "./sceneLayers";
import { bakeDepotRegionTexture, type OmentalTextureDomain } from "./depotTexture";

interface Source { id:string; positions:Float32Array; indices:Uint32Array|null }
self.onmessage=(event:MessageEvent<{sources:Source[];config:FatLayerConfig}>)=>{
  const parts=event.data.sources.map(source=>{
    const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.BufferAttribute(source.positions,3));
    if(source.indices)geometry.setIndex(new THREE.BufferAttribute(source.indices,1));
    return {id:source.id,geometry};
  });
  try{
    const result=createFatLayers(parts,event.data.config),transfer:ArrayBuffer[]=[];
    const geometries=result.geometries.map(layer=>{
      const positions=new Float32Array(layer.geometry.getAttribute("position").array);
      const normals=new Float32Array(layer.geometry.getAttribute("normal").array);
      const thicknessMm=new Float32Array(layer.geometry.getAttribute("fatThicknessMm").array);
      const columnThicknessMm=new Float32Array(layer.geometry.getAttribute("fatColumnThicknessMm").array);
      const regions=new Float32Array(layer.geometry.getAttribute("fatRegion").array);
      const depotUvs=new Float32Array(layer.geometry.getAttribute("fatDepotUv").array);
      const indices=Uint32Array.from(layer.geometry.index!.array);
      const metadata={...layer.geometry.userData};
      const regionTexture=metadata.depotField ? {data:bakeDepotRegionTexture(metadata.depotField as OmentalTextureDomain),resolution:512}:null;
      if(regionTexture)transfer.push(regionTexture.data.buffer as ArrayBuffer);
      transfer.push(positions.buffer,normals.buffer,indices.buffer,thicknessMm.buffer,columnThicknessMm.buffer,regions.buffer,depotUvs.buffer);layer.geometry.dispose();
      return {id:layer.id,label:layer.label,positions,normals,indices,thicknessMm,columnThicknessMm,regions,depotUvs,metadata,regionTexture};
    });
    self.postMessage({geometries,diagnostics:result.diagnostics},{transfer});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
  finally{parts.forEach(part=>part.geometry.dispose());}
};
