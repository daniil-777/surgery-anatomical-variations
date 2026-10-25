import { SceneSurfaceContact, barycentricSurfacePoint } from "./wholeSceneContact";
import { VIRTAMED_AUTHORED_PHYSICS_JOINTS } from "./virtaMedPhysicsJoints";
import { VIRTAMED_TISSUE_RESPONSE } from "./sceneTissueResponse";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { createVirtaMedScene, VIRTAMED_ORGANS, virtaMedDiseaseField, warpVirtaMedPositions, type VirtaMedVariation } from "./virtaMedScene";
import { WholeScenePhysics, readLearnedSceneMaterials } from "./wholeScenePhysics";
import { buildVirtaMedInterfaces, type InterfaceGraph } from "./virtaMedInterfaces";
import materialsJson from "../public/anatomy-scene/virtamed-materials.json";
let root:THREE.Group,graph:InterfaceGraph;
beforeAll(()=>{root=createVirtaMedScene().root;graph=buildVirtaMedInterfaces((root.children as THREE.Mesh[]).map(m=>({id:m.name,geometry:m.geometry,attachments:m.userData.attachments,coverRange:m.userData.coverRange})));},60000);
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
  it("encloses every reconstructed organ without wall intersections or blocking the video camera",()=>{
    const wall=root.getObjectByName("abdominal-wall") as THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>;
    expect(wall.material.side).toBe(THREE.FrontSide);
    const raycaster=new THREE.Raycaster(),direction=new THREE.Vector3(.311,.523,.794).normalize();
    // A closed two-sided surface has an odd forward crossing count from inside.
    // Test actual vertices over each entire organ, including hidden endpoints.
    wall.material.side=THREE.DoubleSide;
    for(const mesh of root.children as THREE.Mesh[]){if(mesh===wall)continue;const p=mesh.geometry.getAttribute("position");
      for(let i=0;i<p.count;i+=Math.max(1,Math.floor(p.count/40))){
        raycaster.set(new THREE.Vector3().fromBufferAttribute(p,i),direction);
        const hits=raycaster.intersectObject(wall,false);
        const distances=hits.map(h=>h.distance).filter((d,j,a)=>!j||Math.abs(d-a[j-1]!)>.001);
        expect(distances.length%2,`${mesh.name} vertex ${i} outside enclosure`).toBe(1);
        expect(distances[0]).toBeGreaterThan(4);
      }
    }
    wall.material.side=THREE.FrontSide;
    raycaster.set(new THREE.Vector3(-4,-32,247),new THREE.Vector3(0,33,-247).normalize());
    expect(raycaster.intersectObject(wall,false)[0]!.distance).toBeGreaterThan(330);
  });
  it("registers real host vertices at the neck and sheet roots and preserves those joins under disease and force",()=>{
    const source=readLearnedSceneMaterials(materialsJson),organs=root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,category:VIRTAMED_ORGANS.find(i=>i.id===m.name)!.category,bounds:{min:m.geometry.boundingBox!.min.toArray(),max:m.geometry.boundingBox!.max.toArray()}};});
    const solver=new WholeScenePhysics(organs,source,VIRTAMED_TISSUE_RESPONSE,[...graph.edges,...VIRTAMED_AUTHORED_PHYSICS_JOINTS]);
    const gp=(root.getObjectByName("gallbladder") as THREE.Mesh).geometry.getAttribute("position"),anchor=new THREE.Vector3().fromBufferAttribute(gp,32*65+16);
    solver.beginToolContact({mode:"grasp",organId:"gallbladder",restPointMm:anchor.toArray(),normal:[0,0,1],targetPointMm:anchor.clone().add(new THREE.Vector3(0,0,7)).toArray(),radiusMm:12});
    for(let i=0;i<120;i++)solver.step(1/120,false);
    const sample={disease:"gallbladder-distension",variation:{seed:42,strength:.8,severity:.8,baseline:false},recipe:{controls:{scale_x:.4,scale_y:-.3,scale_z:.2,bend:.3,twist:0,taper:.1,asymmetry:.2}}} as unknown as VirtaMedVariation;
    const deformed=new Map<string,Float32Array>(),varied=new Map<string,Float32Array>();
    for(const mesh of root.children as THREE.Mesh[]){const rest=mesh.geometry.getAttribute("position").array as Float32Array,out=new Float32Array(rest.length);solver.deform(rest,out,solver.bind(rest,mesh.name));deformed.set(mesh.name,out);varied.set(mesh.name,warpVirtaMedPositions(rest,sample));}
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

  it("retains the overlapping biliary junction during gallbladder traction without proximity adhesion",()=>{
    const organs=(root.children as THREE.Mesh[]).map(mesh=>({id:mesh.name,category:VIRTAMED_ORGANS.find(info=>info.id===mesh.name)!.category,bounds:{min:mesh.geometry.boundingBox!.min.toArray(),max:mesh.geometry.boundingBox!.max.toArray()}}));
    const joined=new WholeScenePhysics(organs,readLearnedSceneMaterials(materialsJson),VIRTAMED_TISSUE_RESPONSE,[...graph.edges,...VIRTAMED_AUTHORED_PHYSICS_JOINTS]);
    const unjoined=new WholeScenePhysics(organs,readLearnedSceneMaterials(materialsJson),VIRTAMED_TISSUE_RESPONSE,graph.edges);
    const mesh=(id:string)=>root.getObjectByName(id) as THREE.Mesh;
    const positions=(id:string)=>mesh(id).geometry.getAttribute("position").array as Float32Array;
    const indices=(id:string)=>mesh(id).geometry.index!.array as Uint16Array|Uint32Array;
    const cystic=positions("cystic-duct"),hepatic=positions("hepatic-duct"),gb=positions("gallbladder");
    const hepaticSurface=new SceneSurfaceContact("hepatic-duct",hepatic,indices("hepatic-duct"));
    const center=VIRTAMED_AUTHORED_PHYSICS_JOINTS[0]!.centerlinePointMm;
    let witness:{vertex:number;hit:NonNullable<ReturnType<SceneSurfaceContact["closestPoint"]>>}|null=null;
    for(let i=0;i<cystic.length;i+=3){const point:[number,number,number]=[cystic[i]!,cystic[i+1]!,cystic[i+2]!];if(Math.hypot(...point.map((x,a)=>x-center[a]!))>6)continue;const hit=hepaticSurface.closestPoint(point)!;if(!witness||hit.distanceMm<witness.hit.distanceMm)witness={vertex:i/3,hit};}
    expect(witness).not.toBeNull();const selected=witness!,restGap=selected.hit.distanceMm;expect(restGap).toBeLessThan(.15);
    const gbSurface=new SceneSurfaceContact("gallbladder",gb,indices("gallbladder")),anchor=gbSurface.closestPoint([-40,-12,-16])!;
    const vertices=anchor.vertexIndices.map(i=>Array.from(gb.slice(i*3,i*3+3))) as [number[],number[],number[]];
    for(const solver of [joined,unjoined])solver.beginToolContact({mode:"grasp",organId:"gallbladder",restPointMm:anchor.restPointMm,normal:anchor.normal,targetPointMm:[anchor.pointMm[0],anchor.pointMm[1],anchor.pointMm[2]+10],radiusMm:3,attachment:{verticesMm:vertices,barycentric:anchor.barycentric}});
    for(let step=0;step<144;step++){joined.step(1/120,false);unjoined.step(1/120,false);}
    const displayedGap=(solver:WholeScenePhysics)=>{const a=new Float32Array(cystic.length),b=new Float32Array(hepatic.length);solver.deform(cystic,a,solver.bind(cystic,"cystic-duct"));solver.deform(hepatic,b,solver.bind(hepatic,"hepatic-duct"));const p=barycentricSurfacePoint(b,selected.hit.vertexIndices,selected.hit.barycentric);return Math.hypot(a[selected.vertex*3]!-p[0],a[selected.vertex*3+1]!-p[1],a[selected.vertex*3+2]!-p[2]);};
    const joinedGap=displayedGap(joined),unjoinedGap=displayedGap(unjoined);
    expect(joinedGap).toBeLessThan(restGap*1.5+.01);expect(unjoinedGap).toBeGreaterThan(joinedGap*3);
    expect(joined.samplePoint(center,"hepatic-duct")).toEqual(joined.samplePoint(center,"cystic-duct"));
    expect(Math.hypot(...joined.samplePoint(center,"hepatic-duct").map((value,axis)=>value-center[axis]!))).toBeGreaterThan(.1);
    expect(joined.snapshot().attachment_components!.some(component=>component.includes("gallbladder")&&component.includes("hepatic-duct"))).toBe(true);
    expect(joined.snapshot().attachment_components!.find(component=>component.includes("cystic-artery"))).toEqual(["cystic-artery"]);
    if(process.env.VIRTAMED_BILIARY_JUNCTION_OUTPUT)writeFileSync(process.env.VIRTAMED_BILIARY_JUNCTION_OUTPUT,JSON.stringify({restGapMm:restGap,joinedGapMm:joinedGap,unjoinedGapMm:unjoinedGap,graspTargetDisplacementMm:10,heldTimeS:1.2,scope:"Actual rest-matched surface witnesses; authored junction continuity, not welded lumen or organ-organ contact validation."},null,2));
  });
  it("uses independently fitted material estimates including the deformable cavity lining",()=>{
    const source=readLearnedSceneMaterials(materialsJson);expect(source.materials).toHaveLength(12);expect(new Set(source.materials.map(m=>m.young_pa)).size).toBe(12);
    const organs=root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,category:VIRTAMED_ORGANS.find(i=>i.id===m.name)!.category,bounds:{min:m.geometry.boundingBox!.min.toArray(),max:m.geometry.boundingBox!.max.toArray()}};});
    const solver=new WholeScenePhysics(organs,source,VIRTAMED_TISSUE_RESPONSE,[...graph.edges,...VIRTAMED_AUTHORED_PHYSICS_JOINTS]);expect(solver.snapshot().organs).toHaveLength(12);
  });
  it.each(["liver","gallbladder","cystic-duct","hepatic-duct","cystic-artery","colon","small-intestine","duodenum","hepatocystic-fat","hepatoduodenal-ligament","falciform-ligament","abdominal-wall"])("presses a real %s triangle and recovers with bounded force",id=>{
    const source=readLearnedSceneMaterials(materialsJson);
    const organs=root.children.map(o=>{const m=o as THREE.Mesh;return{id:m.name,category:VIRTAMED_ORGANS.find(i=>i.id===m.name)!.category,bounds:{min:m.geometry.boundingBox!.min.toArray(),max:m.geometry.boundingBox!.max.toArray()}};});
    const solver=new WholeScenePhysics(organs,source,VIRTAMED_TISSUE_RESPONSE,[...graph.edges,...VIRTAMED_AUTHORED_PHYSICS_JOINTS]),mesh=root.getObjectByName(id) as THREE.Mesh,p=mesh.geometry.getAttribute("position"),index=mesh.geometry.index!;
    // Choose a nondegenerate anterior triangle, not an invented off-surface anchor.
    let chosen:THREE.Vector3[]=[];let best=-Infinity;
    for(let f=0;f<index.count;f+=3){const v=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(p,index.getX(f+k))),n=v[1]!.clone().sub(v[0]!).cross(v[2]!.clone().sub(v[0]!));const z=v.reduce((s,a)=>s+a.z/3,0);if(n.length()>1e-4&&z>best){best=z;chosen=v;}}
    const n=chosen[1]!.clone().sub(chosen[0]!).cross(chosen[2]!.clone().sub(chosen[0]!)).normalize(),point=chosen.reduce((sum,v)=>sum.addScaledVector(v,1/3),new THREE.Vector3());
    solver.beginToolContact({mode:"push",organId:id,restPointMm:point.toArray(),normal:n.toArray(),targetPointMm:point.clone().addScaledVector(n,-3).toArray(),radiusMm:6,attachment:{verticesMm:[chosen[0]!.toArray(),chosen[1]!.toArray(),chosen[2]!.toArray()],barycentric:[1/3,1/3,1/3]}});
    for(let i=0;i<90;i++)solver.step(1/120,false);
    const report=solver.toolSnapshot()!;expect(solver.snapshot().finite).toBe(true);expect(Math.hypot(...report.forceN)).toBeLessThanOrEqual(3.000001);expect(Math.hypot(...report.displacementMm)).toBeGreaterThan(.0001);
    const rest=new Float32Array(chosen.flatMap(v=>v.toArray())),out=new Float32Array(9);solver.deform(rest,out,solver.bind(rest,id));
    for(let a=0;a<3;a++)expect((out[a]!+out[3+a]!+out[6+a]!)/3).toBeCloseTo(report.actualSurfacePointMm[a]!,4);
    solver.releaseToolContact();for(let i=0;i<1440;i++)solver.step(1/120,false);expect(Math.hypot(...solver.toolSnapshot()!.displacementMm)).toBeLessThan(.02);
    solver.reset();expect(solver.snapshot().displacement_mm).toBe(0);
  });
});
