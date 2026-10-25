import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WholeSceneCategory, WholeSceneVariation } from "./wholeSceneModel";
import { warpScenePositions } from "./wholeSceneModel";
import { sampleNeuralVariation, type ImportedVariationSystem, type ImportedVariationRecipe } from "./imports/variations";

export const VIRTAMED_VERSION = "viscera.video-field/1";
/** Authored reconstruction of the visible 00:08–00:15 field, not source simulator assets.
 * Hidden surfaces and millimetre scale are estimates. No logo/video pixels are bundled. */
export const VIRTAMED_ORGANS: { id: string; label: string; category: WholeSceneCategory; color: string }[] = [
  { id: "liver", label: "Liver canopy", category: "digestive", color: "#793d3c" },
  { id: "gallbladder", label: "Gallbladder", category: "digestive", color: "#abb1b2" },
  { id: "cystic-duct", label: "Cystic duct", category: "digestive", color: "#bba78b" },
  { id: "hepatic-duct", label: "Extrahepatic bile duct", category: "digestive", color: "#b9a382" },
  { id: "cystic-artery", label: "Cystic artery", category: "cardiovascular", color: "#9b4547" },
  { id: "colon", label: "Partly visible colon", category: "digestive", color: "#c68d87" },
  { id: "small-intestine", label: "Foreground bowel", category: "digestive", color: "#d5a39a" },
  { id: "duodenum", label: "Duodenal support surface (inferred)", category: "digestive", color: "#c5988b" },
  { id: "hepatocystic-fat", label: "Connected fatty apron", category: "connective", color: "#cb994f" },
  { id: "hepatoduodenal-ligament", label: "Hepatocystic membrane", category: "connective", color: "#c9ad99" },
  { id: "falciform-ligament", label: "Cranial ligament sheet", category: "connective", color: "#c8b295" },
  { id: "abdominal-wall", label: "Posterior cavity support (inferred)", category: "connective", color: "#663b35" },
];
type V3 = [number, number, number];
const vec = (p: V3) => new THREE.Vector3(...p);
const smoothMin = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * .25; };
function ellipsoid(x: number, y: number, z: number, c: V3, r: V3) {
  const px = x-c[0], py=y-c[1], pz=z-c[2];
  const k0 = Math.hypot(px/r[0], py/r[1], pz/r[2]);
  const k1 = Math.hypot(px/(r[0]*r[0]), py/(r[1]*r[1]), pz/(r[2]*r[2]));
  return k0 * (k0-1) / Math.max(k1, 1e-8);
}
function implicit(shapes: { c: V3; r: V3 }[], lo: V3, hi: V3, blend: number, detail = 76) {
  const mc = new MarchingCubes(detail, new THREE.MeshBasicMaterial(), false, false, 180000);
  mc.isolation = 0;
  for (let z=0; z<detail; z++) for (let y=0; y<detail; y++) for (let x=0; x<detail; x++) {
    const px=lo[0]+(hi[0]-lo[0])*x/detail, py=lo[1]+(hi[1]-lo[1])*y/detail, pz=lo[2]+(hi[2]-lo[2])*z/detail;
    let d=1e5;
    for (const s of shapes) d=smoothMin(d,ellipsoid(px,py,pz,s.c,s.r),blend);
    mc.field[z*detail*detail+y*detail+x]=-d;
  }
  mc.update();
  const n=mc.geometry.drawRange.count;
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.BufferAttribute((mc.geometry.getAttribute("position").array as Float32Array).slice(0,n*3),3));
  g.scale((hi[0]-lo[0])/2,(hi[1]-lo[1])/2,(hi[2]-lo[2])/2);
  g.translate((hi[0]+lo[0])/2,(hi[1]+lo[1])/2,(hi[2]+lo[2])/2);
  mc.geometry.dispose(); (mc.material as THREE.Material).dispose();
  const merged=mergeVertices(g,.00001); g.dispose();
  // Remove collapsed marching-cube triangles, then use a volume-preserving
  // Taubin fairing pass to remove voxel-grid shading from the capsule.
  const mp=merged.getAttribute("position"), mi=merged.index!, clean:number[]=[], adjacency=Array.from({length:mp.count},()=>new Set<number>());
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  for(let i=0;i<mi.count;i+=3){const ia=mi.getX(i),ib=mi.getX(i+1),ic=mi.getX(i+2);if(ia===ib||ib===ic||ia===ic)continue;
    a.fromBufferAttribute(mp,ia);b.fromBufferAttribute(mp,ib);c.fromBufferAttribute(mp,ic);if(b.sub(a).cross(c.sub(a)).lengthSq()<1e-14)continue;
    clean.push(ia,ib,ic);adjacency[ia]!.add(ib).add(ic);adjacency[ib]!.add(ia).add(ic);adjacency[ic]!.add(ia).add(ib);
  }merged.setIndex(clean);
  const next=new Float32Array(mp.count*3);
  for(let pass=0;pass<4;pass++)for(const gain of [.5,-.53]){for(let i=0;i<mp.count;i++){
    const near=adjacency[i]!;a.set(0,0,0);for(const j of near)a.add(b.fromBufferAttribute(mp,j));if(near.size)a.multiplyScalar(1/near.size);else a.fromBufferAttribute(mp,i);
    b.fromBufferAttribute(mp,i).lerp(a,gain);next.set(b.toArray(),i*3);
  }(mp.array as Float32Array).set(next);}
  merged.computeVertexNormals();
  // Spherical rest UVs; the posterior seam is outside the operative field.
  const pos=merged.getAttribute("position"), uv=new Float32Array(pos.count*2);
  for(let i=0;i<pos.count;i++) { uv[i*2]=.5+Math.atan2(pos.getX(i),pos.getZ(i))/Math.PI/2; uv[i*2+1]=(pos.getY(i)-lo[1])/(hi[1]-lo[1]); }
  merged.setAttribute("uv",new THREE.BufferAttribute(uv,2)); return merged;
}
/** Parallel-transport loft: a connected surface with closed rounded endpoints. */
function loft(points: V3[], radius: (t:number,a:number)=>number, segments=100, sides=48, flatten=.88) {
  const curve=new THREE.CatmullRomCurve3(points.map(vec));
  const frames=curve.computeFrenetFrames(segments,false), p:number[]=[], uv:number[]=[], indices:number[]=[];
  for(let i=0;i<=segments;i++) { const t=i/segments,c=curve.getPointAt(t); for(let j=0;j<=sides;j++) {
    const a=j/sides*Math.PI*2,r=radius(t,a), q=c.clone().addScaledVector(frames.normals[i]!,r*Math.cos(a)).addScaledVector(frames.binormals[i]!,r*Math.sin(a)*flatten);
    p.push(q.x,q.y,q.z); uv.push(j/sides,t*2);
    if(i<segments&&j<sides){const k=i*(sides+1)+j;indices.push(k,k+1,k+sides+1,k+1,k+sides+2,k+sides+1);}
  }}
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return g;
}
const cap=(t:number)=>Math.pow(Math.max(0,Math.sin(Math.PI*t)),.24);
function sheet(points: V3[], width:(t:number)=>number, thickness:number) {
  return loft(points,(t,a)=>cap(t)*width(t)/Math.sqrt(Math.cos(a)**2+Math.sin(a)**2*(width(t)/thickness)**2),72,40,1);
}
export function createVirtaMedScene() {
  const root=new THREE.Group();root.name="VirtaMed scene";
  root.userData={sceneVersion:VIRTAMED_VERSION,source:"User-provided Full.mp4, intact field 00:08–00:15",geometryEvidence:"Visible silhouettes reconstructed by hand; hidden surfaces and physical scale inferred",units:"mm (assumed)",scenePreset:"virtamed"};
  const geometries:Record<string,THREE.BufferGeometry>={};
  geometries.liver=implicit([
    {c:[-65,60,-25],r:[96,36,51]}, {c:[19,59,-30],r:[77,30,47]},
    {c:[87,65,-33],r:[74,23,37]}, {c:[-7,43,-41],r:[36,17,32]},
  ],[-173,-4,-91],[173,119,39],13,94);
  geometries.gallbladder=loft([[-88,13,51],[-80,9,44],[-70,3,26],[-56,-6,0],[-40,-12,-18]],t=>cap(t)*(27*(1-t)**.55+3),100,64,.9);
  const gb=geometries.gallbladder.getAttribute("position");for(let i=0;i<gb.count;i++)gb.setXYZ(i,-40+(gb.getX(i)+40)*1.08,-12+(gb.getY(i)+12)*.85,gb.getZ(i));geometries.gallbladder.computeVertexNormals();
  geometries["cystic-duct"]=loft([[-40,-12,-18],[-30,-18,-14],[-12,-21,-10],[-2,-24,-16]],t=>cap(t)*2.9,56,24,1);
  geometries["hepatic-duct"]=loft([[-8,51,-30],[-5,-10,-21],[-2,-24,-16],[9,-53,-29]],t=>cap(t)*3.6,64,24,1);
  geometries["cystic-artery"]=loft([[-4,-37,-26],[-14,-24,-13],[-37,-8,-15],[-53,1,-2]],t=>cap(t)*(1.4-.4*t),64,20,1);
  geometries.colon=loft([[-156,-72,-2],[-91,-63,13],[-30,-44,22],[36,-30,25],[95,-16,11],[159,-15,-9]],(t,a)=>cap(t)*(20+14*Math.exp(-1*((t-.69)/.22)**2)+.8*Math.cos(t*Math.PI*18))*(1+.025*Math.cos(3*a)),150,56,.86);
  geometries["small-intestine"]=loft([[-162,-108,35],[-95,-102,54],[-14,-92,57],[63,-91,43],[141,-97,27]],(t,a)=>cap(t)*(21+1.1*Math.cos(t*Math.PI*18))*(1+.025*Math.cos(4*a)),140,48,.88);
  geometries.duodenum=loft([[22,-34,-35],[38,-53,-24],[16,-70,-17],[-15,-69,-22]],t=>cap(t)*13,72,40,1);
  const fat:{c:V3;r:V3}[]=[];
  for(let row=-1;row<=1;row++)for(let i=0;i<25;i++){const t=i/24;fat.push({c:[-157+314*t+3*Math.sin(i*2+row),-80+31*t+row*10+3*Math.sin(t*17+row),49+10*Math.sin(t*4)+2*Math.sin(i*2.7+row)],r:[11+2*Math.sin(i*1.7),9+1.5*Math.sin(i*2.3),7+2*Math.cos(i*1.3+row)]});}
  fat.push({c:[-22,2,-7],r:[45,29,15]});
  for(let i=0;i<10;i++){const t=i/9;fat.push({c:[-53+76*t,-12-7*Math.sin(t*7),3+3*Math.cos(t*5)],r:[14,15,10]});}
  for(let i=0;i<10;i++){const t=i/9;fat.push({c:[-53-45*t,-26-46*t,3+39*t],r:[12,12,7]});}
  geometries["hepatocystic-fat"]=implicit(fat,[-180,-111,-35],[181,41,80],5,88);
  geometries["hepatoduodenal-ligament"]=sheet([[-40,40,-25],[-28,-6,-13],[-3,-28,-22],[15,-44,-28]],t=>15+10*Math.sin(t*Math.PI),.65);
  geometries["falciform-ligament"]=sheet([[8,39,6],[12,45,24],[16,65,27],[28,103,19],[70,153,1]],t=>19+19*t,1.6);
  const wall=new THREE.SphereGeometry(1,112,64,0,Math.PI*2,0,Math.PI/2);
  // Inward-facing bowl with an open anterior rim, beyond the operative frame.
  const wp=wall.getAttribute("position");for(let i=0;i<wp.count;i++){const x=wp.getX(i),y=wp.getZ(i),depth=wp.getY(i);wp.setXYZ(i,x*260,y*235,-125+170*(1-depth)+2*Math.sin(x*17)*Math.sin(y*19));}
  wall.computeVertexNormals();geometries["abdominal-wall"]=wall;
  for(const info of VIRTAMED_ORGANS){const geometry=geometries[info.id]!;geometry.computeBoundingBox();geometry.computeBoundingSphere();const mesh=new THREE.Mesh(geometry,whiteVirtaMedMaterial());mesh.name=info.id;mesh.userData={id:info.id,organId:info.id,scenePreset:"virtamed",label:info.label};root.add(mesh);}
  return {root,manifest:{organs:VIRTAMED_ORGANS,version:VIRTAMED_VERSION}};
}
export function whiteVirtaMedMaterial() {return new THREE.MeshPhysicalMaterial({color:0xeeeae3,roughness:.68,metalness:0,clearcoat:.08,side:THREE.DoubleSide});}
export const VIRTAMED_DISEASES=[
  {id:"baseline",label:"Healthy appearance",organ:"liver"},
  {id:"gallbladder-cholecystitis",label:"Gallbladder inflammation",organ:"gallbladder"},
  {id:"gallbladder-distension",label:"Gallbladder distension",organ:"gallbladder"},
  {id:"liver-steatotic-enlargement",label:"Fatty liver enlargement",organ:"liver"},
  {id:"liver-cirrhosis",label:"Nodular liver / fibrosis",organ:"liver"},
  {id:"liver-metastases",label:"Focal hepatic lesions",organ:"liver"},
] as const;
export interface VirtaMedVariation {recipes?:Record<string,ImportedVariationRecipe>;recipe:ImportedVariationRecipe; variation:WholeSceneVariation; disease:string}
export function sampleVirtaMedVariation(system:ImportedVariationSystem,variation:WholeSceneVariation,disease:string):VirtaMedVariation {
  const condition=VIRTAMED_DISEASES.find(d=>d.id===disease)??VIRTAMED_DISEASES[0]!;
  const reference=system.references.find(r=>r.organ===condition.organ);if(!reference)throw new Error("No supported organ variation reference.");
  const recipe=sampleNeuralVariation(system,{referenceId:reference.id,seed:variation.seed,temperature:.65,profileId:condition.id==="baseline"?null:condition.id,severity:variation.severity>.66?"severe":variation.severity>.33?"moderate":"mild"});
  const recipes:Record<string,ImportedVariationRecipe>={};
  for(const [id,family] of Object.entries({liver:"liver",gallbladder:"gallbladder",colon:"large-intestine","small-intestine":"small-intestine",duodenum:"small-intestine"})){
    const ref=system.references.find(r=>r.organ===family);if(!ref)throw new Error(`Missing variation family for ${id}`);
    recipes[id]=id===condition.organ?recipe:sampleNeuralVariation(system,{referenceId:ref.id,seed:(variation.seed+Object.keys(recipes).length*7919)>>>0,temperature:.65});
  }
  return {recipe,recipes,variation,disease:condition.id};
}
/** Shared spatial map keeps every coincident tissue attachment coincident.
 * Learned shape controls drive broad scale/shear; authored localized disease
 * fields drive both capsule displacement and pigment at the same rest point. */
export function warpVirtaMedPositions(rest:Float32Array,sample:VirtaMedVariation) {
  if(sample.variation.baseline)return rest.slice();
  const v={...sample.variation,strength:sample.variation.strength*.15,severity:0};
  const out=warpScenePositions(rest,v),c=sample.recipe.controls,s=sample.variation.strength;
  for(let i=0;i<out.length;i+=3){const x=rest[i]!,y=rest[i+1]!,z=rest[i+2]!;
    const d=virtaMedDiseaseField(x,y,z,sample.disease,sample.variation.severity);
    const hepatic=Math.exp(-1*((y-55)/70)**2-((z+20)/85)**2);
    const gb=Math.exp(-1*((x+66)/43)**2-((y-3)/29)**2-((z-29)/42)**2);
    const scale=1+.035*s*c.scale_x!;
    out[i]=out[i]!*scale+.9*s*c.bend!*Math.sin(y/80)+d.dx;
    out[i+1]=out[i+1]!*(1+.03*s*c.scale_y!)+d.dy;
    out[i+2]=out[i+2]!*(1+.03*s*c.scale_z!)+s*c.asymmetry!*(hepatic+gb)*1.3+d.dz;
    for(const [id,center,radius] of [["liver",[-20,60,-25],115],["gallbladder",[-70,5,28],42],["colon",[20,-35,20],95],["small-intestine",[0,-94,50],100]] as const){
      const controls=sample.recipes?.[id]?.controls;if(!controls)continue;
      const weight=Math.exp(-((x-center[0])**2+(y-center[1])**2+(z-center[2])**2)/(radius*radius*.6))*s*.018;
      out[i]!+=(x-center[0])*weight*controls.scale_x!;out[i+1]!+=(y-center[1])*weight*controls.scale_y!;out[i+2]!+=(z-center[2])*weight*controls.scale_z!;
    }
  }return out;
}
export function virtaMedDiseaseField(x:number,y:number,z:number,id:string,severity:number) {
  const h=Math.exp(-1*((x+5)/145)**4-((y-55)/65)**4-((z+20)/70)**4);
  const g=Math.exp(-1*((x+66)/38)**2-((y-3)/27)**2-((z-29)/40)**2);
  let dx=0,dy=0,dz=0,mask=0;
  if(id.startsWith("gallbladder")){mask=g;const f=severity*g*(id.endsWith("distension")?.22:.09);dx=(x+24)*f;dy=(y+12)*f;dz=(z+1)*f;}
  if(id==="liver-steatotic-enlargement"){mask=h;dx=x*.07*severity*h;dy=(y-90)*.1*severity*h;dz=(z+50)*.1*severity*h;}
  if(id==="liver-cirrhosis"){mask=h*(.35+.65*(Math.sin(x*.43)*Math.sin(y*.39)*Math.sin(z*.37)*.5+.5));dz=severity*1.5*mask;dy=-severity*2*h;}
  if(id==="liver-metastases"){for(const c of [[-85,53,19],[36,54,9],[-28,31,18]]){const b=Math.exp(-1*((x-c[0]!)/9)**2-((y-c[1]!)/10)**2-((z-c[2]!)/15)**2);mask+=b;dz+=b*severity*4;}mask=Math.min(1,mask);}
  return {dx,dy,dz,mask:mask*severity};
}
