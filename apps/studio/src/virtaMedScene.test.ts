import { VIRTAMED_TISSUE_RESPONSE } from "./sceneTissueResponse";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { createVirtaMedScene, VIRTAMED_ORGANS, virtaMedDiseaseField, warpVirtaMedPositions, type VirtaMedVariation } from "./virtaMedScene";
import { WholeScenePhysics, readLearnedSceneMaterials } from "./wholeScenePhysics";
import materialsJson from "../public/anatomy-scene/virtamed-materials.json";
let root:THREE.Group;
beforeAll(()=>{root=createVirtaMedScene().root;},60000);
afterAll(()=>{root.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();o.material.dispose();}});});
describe("video-field reconstruction",()=>{
  it("ships the exact current white geometry as an integrity-checked 12-part GLB",()=>{
    const buffer=readFileSync(new URL("../public/anatomy-scene/virtamed-scene.glb",import.meta.url));
    const manifest=JSON.parse(readFileSync(new URL("../public/anatomy-scene/virtamed-manifest.json",import.meta.url),"utf8"));
    expect(createHash("sha256").update(buffer).digest("hex")).toBe(manifest.sha256);expect(buffer.length).toBe(manifest.bytes);
    const jsonLength=buffer.readUInt32LE(12),doc=JSON.parse(buffer.subarray(20,20+jsonLength).toString()),binaryStart=28+jsonLength;
    expect(doc.meshes).toHaveLength(12);expect(doc.images??[]).toHaveLength(0);
    for(const node of doc.nodes.filter((n:{mesh?:number})=>n.mesh!==undefined)){const mesh=doc.meshes[node.mesh],source=root.getObjectByName(node.name) as THREE.Mesh,p=source.geometry.getAttribute("position"),accessor=doc.accessors[mesh.primitives[0].attributes.POSITION],view=doc.bufferViews[accessor.bufferView];
      expect(accessor.count).toBe(p.count);for(let i=0;i<p.count*3;i+=37)expect(buffer.readFloatLE(binaryStart+(view.byteOffset??0)+(accessor.byteOffset??0)+i*4)).toBe(p.array[i]);
    }
  });
  it("has 12 named finite surfaces in one coordinate frame and a neutral white baseline",()=>{
    expect(root.children.map(m=>m.name)).toEqual(VIRTAMED_ORGANS.map(m=>m.id));
    for(const object of root.children){const m=object as THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>,p=m.geometry.getAttribute("position");expect(m.position.length()).toBe(0);expect(p.count).toBeGreaterThan(100);expect(Array.from(p.array).every(Number.isFinite)).toBe(true);expect(m.material.map).toBeNull();expect(m.material.color.r).toBeCloseTo(m.material.color.g,1);}
  });
  it("registers real host vertices at the neck and sheet roots and preserves those joins under disease and force",()=>{
    const source=readLearnedSceneMaterials(materialsJson),organs=root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,category:m.name==="abdominal-wall"?"skeleton" as const:VIRTAMED_ORGANS.find(i=>i.id===m.name)!.category,bounds:{min:m.geometry.boundingBox!.min.toArray(),max:m.geometry.boundingBox!.max.toArray()}};});
    const solver=new WholeScenePhysics(organs,source,VIRTAMED_TISSUE_RESPONSE);
    const gp=(root.getObjectByName("gallbladder") as THREE.Mesh).geometry.getAttribute("position"),anchor=new THREE.Vector3().fromBufferAttribute(gp,32*65+16);
    solver.beginToolContact({mode:"grasp",organId:"gallbladder",restPointMm:anchor.toArray(),normal:[0,0,1],targetPointMm:anchor.clone().add(new THREE.Vector3(0,0,7)).toArray(),radiusMm:12});
    for(let i=0;i<120;i++)solver.step(1/120,false);
    const sample={disease:"gallbladder-distension",variation:{seed:42,strength:.8,severity:.8,baseline:false},recipe:{controls:{scale_x:.4,scale_y:-.3,scale_z:.2,bend:.3,twist:0,taper:.1,asymmetry:.2}}} as unknown as VirtaMedVariation;
    const deformed=new Map<string,Float32Array>(),varied=new Map<string,Float32Array>();
    for(const mesh of root.children as THREE.Mesh[]){const rest=mesh.geometry.getAttribute("position").array as Float32Array,out=new Float32Array(rest.length);solver.deform(rest,out,solver.bind(rest));deformed.set(mesh.name,out);varied.set(mesh.name,warpVirtaMedPositions(rest,sample));}
    let registered=0;
    for(const mesh of root.children as THREE.Mesh[]){
      const own=mesh.geometry.getAttribute("position"),ownKeys=new Set(Array.from({length:own.count},(_,i)=>[own.getX(i),own.getY(i),own.getZ(i)].join(",")));
      for(const attachment of mesh.userData.attachments??[]){
        const host=(root.getObjectByName(attachment.host) as THREE.Mesh).geometry.getAttribute("position"),hostKeys=new Set(Array.from({length:host.count},(_,i)=>[host.getX(i),host.getY(i),host.getZ(i)].join(",")));
        for(const point of attachment.points){
          const rest=new Float32Array(point),key=Array.from(rest).join(",");expect(ownKeys.has(key)).toBe(true);expect(hostKeys.has(key)).toBe(true);
          const find=(p:THREE.BufferAttribute|THREE.InterleavedBufferAttribute)=>{for(let i=0;i<p.count;i++)if(p.getX(i)===rest[0]&&p.getY(i)===rest[1]&&p.getZ(i)===rest[2])return i;throw new Error("Registered attachment disappeared.");};
          const a=find(own)*3,b=find(host)*3;
          expect(deformed.get(mesh.name)!.slice(a,a+3)).toEqual(deformed.get(attachment.host)!.slice(b,b+3));
          expect(varied.get(mesh.name)!.slice(a,a+3)).toEqual(varied.get(attachment.host)!.slice(b,b+3));
          registered++;
        }
      }
    }
    expect(registered).toBeGreaterThan(150);
  });
  it("connects the fatty pad and apron with real shared bridge boundaries",()=>{
    const mesh=root.getObjectByName("hepatocystic-fat") as THREE.Mesh,p=mesh.geometry.getAttribute("position"),counts=new Map<string,number>();
    for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].join(",");counts.set(key,(counts.get(key)??0)+1);}
    expect(mesh.userData.internalAttachments).toHaveLength(42);
    for(const point of mesh.userData.internalAttachments)expect(counts.get(Array.from(new Float32Array(point)).join(","))).toBeGreaterThanOrEqual(2);
  });
  it("bounds disease changes, keeps a healthy baseline exact, and moves coincident tissue coordinates identically",()=>{
    const rest=new Float32Array([-70,7,38,-70,7,38,40,55,10]);
    const sample={disease:"gallbladder-cholecystitis",variation:{seed:42,strength:.6,severity:.8,baseline:false},recipe:{controls:{scale_x:.4,scale_y:-.3,scale_z:.2,bend:.3,twist:0,taper:.1,asymmetry:.2}}} as unknown as VirtaMedVariation;
    const varied=warpVirtaMedPositions(rest,sample);expect(varied.slice(0,3)).toEqual(varied.slice(3,6));expect(varied).not.toEqual(rest);
    expect(warpVirtaMedPositions(rest,{...sample,variation:{...sample.variation,baseline:true}})).toEqual(rest);
    for(const id of ["baseline","gallbladder-cholecystitis","gallbladder-distension","liver-cirrhosis","liver-metastases","liver-steatotic-enlargement"]){for(const m of root.children as THREE.Mesh[]){const p=m.geometry.getAttribute("position");for(let i=0;i<p.count;i+=31){const f=virtaMedDiseaseField(p.getX(i),p.getY(i),p.getZ(i),id,1);expect(Math.hypot(f.dx,f.dy,f.dz)).toBeLessThan(20);expect(Number.isFinite(f.mask)).toBe(true);}}}
  });
  it("uses independently fitted material estimates with a fixed support category",()=>{
    const source=readLearnedSceneMaterials(materialsJson);expect(source.materials).toHaveLength(12);expect(new Set(source.materials.map(m=>m.young_pa)).size).toBe(12);
    const organs=root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,category:m.name==="abdominal-wall"?"skeleton" as const:VIRTAMED_ORGANS.find(i=>i.id===m.name)!.category,bounds:{min:m.geometry.boundingBox!.min.toArray(),max:m.geometry.boundingBox!.max.toArray()}};});
    const solver=new WholeScenePhysics(organs,source,VIRTAMED_TISSUE_RESPONSE);expect(solver.snapshot().organs).toHaveLength(11);
  });
  it.each(["liver","gallbladder","cystic-duct","hepatic-duct","cystic-artery","colon","small-intestine","duodenum","hepatocystic-fat","hepatoduodenal-ligament","falciform-ligament"])("presses a real %s triangle and recovers with bounded force",id=>{
    const source=readLearnedSceneMaterials(materialsJson);
    const organs=root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,category:m.name==="abdominal-wall"?"skeleton" as const:VIRTAMED_ORGANS.find(i=>i.id===m.name)!.category,bounds:{min:m.geometry.boundingBox!.min.toArray(),max:m.geometry.boundingBox!.max.toArray()}};});
    const solver=new WholeScenePhysics(organs,source,VIRTAMED_TISSUE_RESPONSE),mesh=root.getObjectByName(id) as THREE.Mesh,p=mesh.geometry.getAttribute("position"),index=mesh.geometry.index!;
    // Choose a nondegenerate anterior triangle, not an invented off-surface anchor.
    let chosen:THREE.Vector3[]=[];let best=-Infinity;
    for(let f=0;f<index.count;f+=3){const v=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(p,index.getX(f+k))),n=v[1]!.clone().sub(v[0]!).cross(v[2]!.clone().sub(v[0]!));const z=v.reduce((s,a)=>s+a.z/3,0);if(n.length()>1e-4&&z>best){best=z;chosen=v;}}
    const n=chosen[1]!.clone().sub(chosen[0]!).cross(chosen[2]!.clone().sub(chosen[0]!)).normalize(),point=chosen.reduce((sum,v)=>sum.addScaledVector(v,1/3),new THREE.Vector3());
    solver.beginToolContact({mode:"push",organId:id,restPointMm:point.toArray(),normal:n.toArray(),targetPointMm:point.clone().addScaledVector(n,-3).toArray(),radiusMm:6,attachment:{verticesMm:[chosen[0]!.toArray(),chosen[1]!.toArray(),chosen[2]!.toArray()],barycentric:[1/3,1/3,1/3]}});
    for(let i=0;i<90;i++)solver.step(1/120,false);
    const report=solver.toolSnapshot()!;expect(solver.snapshot().finite).toBe(true);expect(Math.hypot(...report.forceN)).toBeLessThanOrEqual(3.000001);expect(Math.hypot(...report.displacementMm)).toBeGreaterThan(.0001);
    const rest=new Float32Array(chosen.flatMap(v=>v.toArray())),out=new Float32Array(9);solver.deform(rest,out,solver.bind(rest));
    for(let a=0;a<3;a++)expect((out[a]!+out[3+a]!+out[6+a]!)/3).toBeCloseTo(report.actualSurfacePointMm[a]!,4);
    solver.releaseToolContact();for(let i=0;i<1440;i++)solver.step(1/120,false);expect(Math.hypot(...solver.toolSnapshot()!.displacementMm)).toBeLessThan(.02);
    solver.reset();expect(solver.snapshot().displacement_mm).toBe(0);
  });
});
