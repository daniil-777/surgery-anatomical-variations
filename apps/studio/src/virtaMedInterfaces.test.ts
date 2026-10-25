import { afterAll,beforeAll,describe,expect,it } from "vitest";
import * as THREE from "three";
import { buildVirtaMedInterfaces, interfaceVariation, interfaceWeight, intrinsicInterfaceDistance, reconcileInterfaceNormals, type InterfaceGraph, type InterfacePart } from "./virtaMedInterfaces";
import { createVirtaMedScene, type VirtaMedVariation } from "./virtaMedScene";
import { makeVirtaMedMaterial } from "./virtaMedMaterials";
let parts:InterfacePart[],graph:InterfaceGraph;
beforeAll(()=>{parts=createVirtaMedScene().root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,geometry:m.geometry,attachments:m.userData.attachments,coverRange:m.userData.coverRange};});graph=buildVirtaMedInterfaces(parts);},60000);
afterAll(()=>parts.forEach(p=>p.geometry.dispose()));
describe("registered PBR tissue interfaces",()=>{
  it("has matching zero-distance roots on both real surfaces, with finite rest fields",()=>{
    expect(graph.edges).toHaveLength(5);
    expect(graph.edges.some(e=>e.id==="cystic-duct~hepatic-duct")).toBe(true);
    for(const edge of graph.edges)for(const id of [edge.a,edge.b]){const part=parts.find(p=>p.id===id)!,p=part.geometry.getAttribute("position"),field=graph.fields.get(id)!.find(f=>f.edge.id===edge.id)!;
      expect(Array.from(field.distance).every(d=>Number.isFinite(d)&&d>=0)).toBe(true);
      for(const point of edge.roots){let found=0;for(let i=0;i<p.count;i++)if(p.getX(i)===Math.fround(point[0]!)&&p.getY(i)===Math.fround(point[1]!)&&p.getZ(i)===Math.fround(point[2]!)){expect(field.distance[i]).toBe(0);found++;}expect(found).toBeGreaterThan(0);}
    }
  });
  it("does not spread a material join through an empty gap to an unconnected fold",()=>{
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,0,0,.01,1,0,.01,0,1,.01],3));g.setIndex([0,1,2,3,4,5]);
    const {distance}=intrinsicInterfaceDistance(g,[0]);expect(distance[0]).toBe(0);expect(distance[1]).toBe(1);expect(Array.from(distance.slice(3))).toEqual([32,32,32]);g.dispose();
    expect(graph.fields.get("colon")).toEqual([]);expect(graph.fields.get("hepatocystic-fat")).toEqual([]);
  });
  it("confines thin-cover appearance to apron rim samples with actual bowel support",()=>{
    expect(graph.covers.length).toBeGreaterThan(0);expect(graph.covers.every(c=>c.a==="hepatocystic-fat"&&["colon","small-intestine","duodenum"].includes(c.b))).toBe(true);
    for(const part of parts){const d=part.geometry.getAttribute("sceneCoverDistance");expect(Array.from(d.array).every(x=>Number.isFinite(x)&&x>=0)).toBe(true);if(part.id!=="hepatocystic-fat")expect(Array.from(d.array).every(x=>x===32)).toBe(true);}
  });
  it("uses a smooth finite band with exact endpoints",()=>{
    expect(interfaceWeight(0,8)).toBe(1);expect(interfaceWeight(8,8)).toBe(0);expect(interfaceWeight(20,8)).toBe(0);expect(interfaceWeight(4,8)).toBe(.5);
    expect((1-interfaceWeight(.001,8))/.001).toBeLessThan(.001);expect(interfaceWeight(7.999,8)/.001).toBeLessThan(.001);
  });
  it("couples interface appearance and width to either neighboring recipe and replays exactly",()=>{
    const sample={disease:"gallbladder-cholecystitis",variation:{baseline:false,seed:319,severity:.8},recipes:{liver:{material:{wetness:.5,fine_detail:.4,tint:0,pigment_contrast:1}},gallbladder:{material:{wetness:.5,fine_detail:.4,tint:0,pigment_contrast:1}}}} as unknown as VirtaMedVariation;
    const edge=graph.edges.find(e=>e.a==="liver"&&e.b==="hepatoduodenal-ligament")!,base=interfaceVariation(edge,sample),volume=new THREE.Data3DTexture(new Uint8Array(4),1,1,1);
    const signature=()=>{const r=makeVirtaMedMaterial("liver",false,null,volume,sample,graph.fields.get("liver"));r.material.dispose();return r.signature;};
    const before=signature();expect(signature()).toBe(before);expect(interfaceVariation(edge,sample)).toEqual(base);
    sample.recipes!.liver!.material.wetness=.9;expect(interfaceVariation(edge,sample).widthMm).not.toBe(base.widthMm);expect(signature()).not.toBe(before);
    sample.recipes!.liver!.material.wetness=.5;sample.recipes!.gallbladder!.material.wetness=.9;expect(interfaceVariation(edge,sample).widthMm).not.toBe(base.widthMm);expect(signature()).not.toBe(before);volume.dispose();
  });
  it("keeps masks in rest space while normals follow current deformed geometry",()=>{
    const before=parts.map(p=>new Float32Array(p.geometry.getAttribute("sceneInterfaceDistance").array));
    for(const part of parts){part.geometry.scale(1.1,.94,1.03);part.geometry.computeVertexNormals();}
    reconcileInterfaceNormals(parts,graph);
    parts.forEach((part,i)=>{expect(part.geometry.getAttribute("sceneInterfaceDistance").array).toEqual(before[i]);expect(Array.from(part.geometry.getAttribute("normal").array).every(Number.isFinite)).toBe(true);});
  });
});
