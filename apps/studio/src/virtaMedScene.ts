import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WholeSceneCategory, WholeSceneVariation } from "./wholeSceneModel";
import { warpScenePositions } from "./wholeSceneModel";
import { sampleNeuralVariation, type ImportedVariationSystem, type ImportedVariationRecipe } from "./imports/variations";
import { anatomicalNoise, cranialAttachment, detailCapsule, drapedFat, hepaticAttachment, joinedFat } from "./virtaMedSurfaceDetail";
import { createBiliaryEnvelope, registerBiliaryNeck } from "./virtaMedBiliary";
import { createAbdominalCavityGeometry } from "./abdominalCavity";

export const VIRTAMED_VERSION = "viscera.video-field/4";
/** Authored reconstruction of the visible 00:08–00:15 field, not source simulator assets.
 * Hidden surfaces and millimetre scale are estimates. No logo/video pixels are bundled. */
export const VIRTAMED_ORGANS: { id: string; label: string; category: WholeSceneCategory; color: string }[] = [
  { id: "liver", label: "Liver canopy", category: "digestive", color: "#995251" },
  { id: "gallbladder", label: "Gallbladder", category: "digestive", color: "#ada9b4" },
  { id: "cystic-duct", label: "Cystic duct", category: "digestive", color: "#bba78b" },
  { id: "hepatic-duct", label: "Extrahepatic bile duct", category: "digestive", color: "#b9a382" },
  { id: "cystic-artery", label: "Cystic artery", category: "cardiovascular", color: "#9b4547" },
  { id: "colon", label: "Partly visible colon", category: "digestive", color: "#cb858a" },
  { id: "small-intestine", label: "Foreground bowel", category: "digestive", color: "#d5a39a" },
  { id: "duodenum", label: "Duodenal support surface (inferred)", category: "digestive", color: "#c5988b" },
  { id: "hepatocystic-fat", label: "Connected fatty apron", category: "connective", color: "#ce9871" },
  { id: "hepatoduodenal-ligament", label: "Hepatocystic membrane", category: "connective", color: "#c9ad99" },
  { id: "falciform-ligament", label: "Cranial ligament sheet", category: "connective", color: "#dbc2a3" },
  { id: "abdominal-wall", label: "Abdominal cavity lining (inferred)", category: "connective", color: "#b9917d" },
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
    const a=j===sides?0:j/sides*Math.PI*2,r=radius(t,a), q=c.clone().addScaledVector(frames.normals[i]!,r*Math.cos(a)).addScaledVector(frames.binormals[i]!,r*Math.sin(a)*flatten);
    p.push(q.x,q.y,q.z); uv.push(j/sides,t*2);
    if(i<segments&&j<sides){const k=i*(sides+1)+j;indices.push(k,k+1,k+sides+1,k+1,k+sides+2,k+sides+1);}
  }}
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return g;
}
const cap=(t:number)=>t<=0||t>=1?0:Math.pow(Math.sin(Math.PI*t),.24);
export function createVirtaMedScene() {
  const root=new THREE.Group();root.name="VirtaMed scene";
  root.userData={sceneVersion:VIRTAMED_VERSION,source:"User-provided Full.mp4, intact field 00:08–00:15",geometryEvidence:"Visible silhouettes reconstructed by hand; hidden surfaces and physical scale inferred",units:"mm (assumed)",scenePreset:"virtamed"};
  const geometries:Record<string,THREE.BufferGeometry>={};
  geometries.liver=implicit([
    {c:[-65,60,-25],r:[96,36,51]}, {c:[19,59,-30],r:[77,30,47]},
    {c:[87,65,-33],r:[74,23,37]}, {c:[-7,43,-41],r:[36,17,32]},
  ],[-173,-4,-91],[173,119,39],13,94);
  detailCapsule(geometries.liver,"liver");
  geometries.gallbladder=loft([[-91,5,60],[-84,5,47],[-76,2,29],[-57,-7,1],[-40,-12,-18]],(t,a)=>{
    const tail=Math.max(0,Math.min(1,(t-.23)/.77)),ease=tail*tail*(3-2*tail);
    const r=t<.23?27*Math.sqrt(Math.max(0,1-(1-t/.23)**2)):2.9+24.1*(1-ease)**1.6;
    return r*(1+.035*Math.cos(a*3+t*5)*Math.sin(Math.PI*t));
  },112,64,.94);
  detailCapsule(geometries.gallbladder,"gallbladder");
  Object.assign(geometries,createBiliaryEnvelope());
  registerBiliaryNeck(geometries.gallbladder,geometries["cystic-duct"]!);
  // Hidden proximal continuation and a distal insertion inside the neck replace
  // the free red rod. These endpoints are authored, not recovered from video.
  geometries["cystic-artery"]=loft([[-8,29,-33],[-12,2,-27],[-23,-12,-25],[-38,-8,-19],[-48,-10,-9]],t=>cap(t)*(1.35-.35*t),88,24,1);
  geometries.colon=loft([[-156,-72,-2],[-91,-63,13],[-30,-44,22],[36,-30,25],[95,-16,11],[159,-15,-9]],(t,a)=>{
    const fold=Math.exp(-1*(Math.sin(t*28+Math.sin(t*13)*.7+a*.24)/.24)**2)*(1+.45*Math.sin(a*2+t*9));
    return cap(t)*(20+14*Math.exp(-1*((t-.69)/.22)**2)-1.05*fold+.65*Math.sin(t*39+a*2))*(1+.035*Math.cos(3*a+t*3));
  },200,64,.86);
  geometries["small-intestine"]=loft([[-162,-108,35],[-95,-102,54],[-14,-92,57],[63,-91,43],[141,-97,27]],(t,a)=>cap(t)*(21+.75*Math.sin(t*32+Math.sin(t*17)+a*.4)-.7*Math.exp(-1*(Math.sin(t*49+a*.3)/.24)**2))*(1+.035*Math.cos(4*a+t*4)),180,56,.88);
  // The short U previously ended in two conspicuous capped stumps. Continue
  // both limbs behind the field, with a smooth C-shaped visible middle.
  geometries.duodenum=loft([[8,18,-58],[22,-18,-43],[39,-43,-27],[40,-61,-25],[16,-76,-29],[-25,-72,-36],[-70,-55,-54],[-107,-32,-73]],t=>cap(t)*12,144,48,1);
  for(const id of ["colon","small-intestine","duodenum"])detailCapsule(geometries[id]!,"bowel");
  const fat:{c:V3;r:V3}[]=[{c:[-22,2,-10],r:[45,29,10]}];
  for(let i=0;i<10;i++){const t=i/9;fat.push({c:[-53+76*t,-12-7*Math.sin(t*7),-1+3*Math.cos(t*5)],r:[14,15,6]});}
  for(let i=0;i<10;i++){const t=i/9;fat.push({c:[-53-45*t,-26-46*t,-1+39*t],r:[12,12,4]});}
  const pad=implicit(fat,[-115,-89,-27],[70,38,47],4,88),pp=pad.getAttribute("position"),pn=pad.getAttribute("normal");
  for(let i=0;i<pp.count;i++){const x=pp.getX(i),y=pp.getY(i),z=pp.getZ(i),w=.55*anatomicalNoise(x/4,y/4,z/4)+.4*Math.sin(x*.42+y*.19)*Math.sin(y*.31);pp.setXYZ(i,x+pn.getX(i)*w,y+pn.getY(i)*w,z+pn.getZ(i)*w);}
  pad.computeVertexNormals();
  geometries["hepatocystic-fat"]=joinedFat(pad,drapedFat([geometries.colon,geometries["small-intestine"],geometries.duodenum]));
  geometries["hepatoduodenal-ligament"]=hepaticAttachment(geometries.liver,geometries.gallbladder);
  geometries["falciform-ligament"]=cranialAttachment(geometries.liver);
  geometries.liver.computeVertexNormals();
  geometries["abdominal-wall"]=createAbdominalCavityGeometry();
  for(const info of VIRTAMED_ORGANS){const geometry=geometries[info.id]!;geometry.computeBoundingBox();geometry.computeBoundingSphere();const material=whiteVirtaMedMaterial();if(info.id==="abdominal-wall")material.side=THREE.FrontSide;const mesh=new THREE.Mesh(geometry,material);mesh.name=info.id;mesh.userData={id:info.id,organId:info.id,scenePreset:"virtamed",label:info.label,...geometry.userData};root.add(mesh);}
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
export interface VirtaMedVariation {recipes?:Record<string,ImportedVariationRecipe>;recipe:ImportedVariationRecipe; variation:WholeSceneVariation; disease:string;textEdit?:boolean}
export function sampleVirtaMedVariation(system:ImportedVariationSystem,variation:WholeSceneVariation,disease:string,textRecipe?:ImportedVariationRecipe|null):VirtaMedVariation {
  if(textRecipe) {
    const profile=textRecipe.disease?.profile_id??"baseline";
    if(!VIRTAMED_DISEASES.some(item=>item.id===profile))throw new Error("This disease is not supported in the connected VirtaMed scene.");
    const baseline=sampleVirtaMedVariation(system,{seed:0,strength:0,severity:0,baseline:true},"baseline");
    return {recipe:textRecipe,recipes:{...baseline.recipes,[textRecipe.reference.organ]:textRecipe},textEdit:true,
      variation:{...variation,baseline:false,severity:textRecipe.disease?.severity??0},disease:profile};
  }
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
  if(sample.textEdit) {
    const c=sample.recipe.controls,gb=sample.recipe.reference.organ==="gallbladder";
    const center=gb?[-70,5,28]:[-20,60,-25],r=gb?45:120,out=new Float32Array(rest.length);
    // One smooth map for every attached tissue, evaluated in immutable scene coordinates.
    for(let i=0;i<rest.length;i+=3){
      const x=rest[i]!,y=rest[i+1]!,z=rest[i+2]!,px=x-center[0]!,py=y-center[1]!,pz=z-center[2]!;
      const w=Math.exp(-(px*px+py*py+pz*pz)/(r*r)),a=.16*c.twist!*Math.tanh(py/r);
      const taper=1+.1*c.taper!*Math.tanh(py/r),sx=px*Math.exp(.14*c.scale_x!)*taper,sz=pz*Math.exp(.14*c.scale_z!)*taper;
      const dx=sx*Math.cos(a)-sz*Math.sin(a)-px+3*c.bend!*Math.sin(py/r)+2*c.asymmetry!*Math.sin(pz/r);
      const dz=sx*Math.sin(a)+sz*Math.cos(a)-pz;
      const d=virtaMedDiseaseField(x,y,z,sample.disease,sample.variation.severity);
      out[i]=x+w*dx+d.dx;out[i+1]=y+w*py*(Math.exp(.14*c.scale_y!)-1)+d.dy;out[i+2]=z+w*dz+d.dz;
    }
    return out;
  }
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
