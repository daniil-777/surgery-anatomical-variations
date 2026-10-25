import * as THREE from "three";
import { SceneSurfaceContact } from "./wholeSceneContact";
import type { VirtaMedVariation } from "./virtaMedScene";

export const VIRTAMED_INTERFACE_VERSION = "registered-tissue-interfaces/1";
export interface InterfacePart { id: string; geometry: THREE.BufferGeometry; attachments?: {host:string; points:number[][]}[]; coverRange?:{start:number;count:number;rows:number;columns:number} }
export interface TissueInterface { id:string; a:string; b:string; widthMm:number; kind:"capsule-insertion"|"duct-continuity"; roots:number[][] }
export interface InterfaceField { edge:TissueInterface; distance:Float32Array; nearest:Int32Array; roots:number[][] }
export interface InterfaceGraph { edges:TissueInterface[]; fields:Map<string,InterfaceField[]>; projectionNormals:Map<string,Float32Array>; roots:Map<string,Map<string,number[]>>; covers:{a:string;b:string;vertices:number}[] }
const key=(p:ArrayLike<number>)=>Array.from(p).map(x=>Math.fround(x)).join(",");
const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
export const interfaceWeight=(distance:number,width:number)=>1-smooth(distance/Math.max(.001,width));

/** Surface-edge Dijkstra, including zero-length UV-seam links. Distances never
 * jump across a spatially close but disconnected bowel fold or tissue sheet. */
export function intrinsicInterfaceDistance(geometry:THREE.BufferGeometry,seeds:number[],limit=32) {
  const p=geometry.getAttribute("position"),index=geometry.index;
  if(!index)throw new Error("Interface fields require indexed geometry.");
  const neighbors=Array.from({length:p.count},()=>new Set<number>()),groups=new Map<string,number[]>();
  for(let i=0;i<p.count;i++){const k=key([p.getX(i),p.getY(i),p.getZ(i)]),g=groups.get(k);if(g)g.push(i);else groups.set(k,[i]);}
  for(let i=0;i<index.count;i+=3){const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2);neighbors[a]!.add(b).add(c);neighbors[b]!.add(a).add(c);neighbors[c]!.add(a).add(b);}
  for(const group of groups.values())for(const i of group.slice(1)){neighbors[group[0]!]!.add(i);neighbors[i]!.add(group[0]!);}
  const distance=new Float32Array(p.count).fill(limit),nearest=new Int32Array(p.count).fill(-1),heap:{vertex:number;distance:number;root:number}[]=[];
  const push=(entry:typeof heap[number])=>{heap.push(entry);let i=heap.length-1;while(i){const parent=(i-1)>>1;if(heap[parent]!.distance<=entry.distance)break;heap[i]=heap[parent]!;i=parent;}heap[i]=entry;};
  const pop=()=>{const first=heap[0]!,last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1]!.distance<heap[child]!.distance)child++;if(heap[child]!.distance>=last.distance)break;heap[i]=heap[child]!;i=child;}heap[i]=last;}return first;};
  seeds.forEach((vertex,root)=>{if(distance[vertex]===0)return;distance[vertex]=0;nearest[vertex]=root;push({vertex,distance:0,root});});
  while(heap.length){const item=pop(),i=item.vertex;if(item.distance>distance[i]!+1e-5)continue;
    for(const j of neighbors[i]!){const d=item.distance+Math.hypot(p.getX(i)-p.getX(j),p.getY(i)-p.getY(j),p.getZ(i)-p.getZ(j));if(d<distance[j]!){distance[j]=d;nearest[j]=item.root;push({vertex:j,distance:distance[j]!,root:item.root});}}
  }
  return {distance,nearest};
}

/** Only authored, geometrically registered attachments become permanent joins.
 * All other pairs retain independent serosa and can slide without color fusion. */
export function buildVirtaMedInterfaces(parts:InterfacePart[]):InterfaceGraph {
  const edges:TissueInterface[]=[],fields=new Map<string,InterfaceField[]>(),roots=new Map<string,Map<string,number[]>>(),projectionNormals=new Map<string,Float32Array>();
  for(const part of parts){const p=part.geometry.getAttribute("position"),map=new Map<string,number[]>();for(let i=0;i<p.count;i++){const k=key([p.getX(i),p.getY(i),p.getZ(i)]);map.set(k,[...(map.get(k)??[]),i]);}roots.set(part.id,map);projectionNormals.set(part.id,new Float32Array(part.geometry.getAttribute("normal").array));fields.set(part.id,[]);}
  for(const part of parts)for(const attachment of part.attachments??[]){
    if(!roots.has(attachment.host))throw new Error(`Missing interface host ${attachment.host}`);
    const edge:TissueInterface={id:[part.id,attachment.host].sort().join("~"),a:attachment.host,b:part.id,widthMm:part.id==="falciform-ligament"?13:part.id==="cystic-duct"?5:7,kind:part.id==="cystic-duct"?"duct-continuity":"capsule-insertion",roots:attachment.points};edges.push(edge);
    for(const id of [edge.a,edge.b]){
      const geometry=parts.find(p=>p.id===id)!.geometry,seeds=attachment.points.map(point=>{const ids=roots.get(id)!.get(key(point));if(!ids)throw new Error(`Unregistered interface ${edge.id}`);return ids[0]!;});
      const field={edge,...intrinsicInterfaceDistance(geometry,seeds),roots:attachment.points};fields.get(id)!.push(field);
    }
  }
  // The host supplies a common rest projection frame at both copies of each
  // root. Interpolation is intrinsic and confined to the same transition band.
  for(const part of parts){const own=projectionNormals.get(part.id)!,p=part.geometry.getAttribute("position"),n=new THREE.Vector3(),target=new THREE.Vector3();
    for(const field of fields.get(part.id)!){if(part.id===field.edge.a)continue;const host=parts.find(p=>p.id===field.edge.a)!.geometry.getAttribute("normal");
      for(let i=0;i<p.count;i++){const root=field.nearest[i]!,w=interfaceWeight(field.distance[i]!,field.edge.widthMm);if(root<0||w===0)continue;const hi=roots.get(field.edge.a)!.get(key(field.roots[root]!))![0]!;target.fromBufferAttribute(host,hi);n.fromArray(own,i*3);if(n.dot(target)<0)n.negate();n.lerp(target,w).normalize().toArray(own,i*3);}
    }
    const distances=new Float32Array(p.count*4).fill(32),list=fields.get(part.id)!;if(list.length>4)throw new Error("Interface palette exceeds four slots.");
    list.forEach((field,slot)=>{for(let i=0;i<p.count;i++)distances[i*4+slot]=field.distance[i]!;});
    part.geometry.setAttribute("sceneInterfaceDistance",new THREE.BufferAttribute(distances,4));part.geometry.setAttribute("sceneRestNormal",new THREE.BufferAttribute(own,3));
  }
  const covers:{a:string;b:string;vertices:number}[]=[];
  for(const part of parts){const p=part.geometry.getAttribute("position"),distance=new Float32Array(p.count*3).fill(32),range=part.coverRange;
    if(range){const hosts=["colon","small-intestine","duodenum"].map(id=>{const geometry=parts.find(p=>p.id===id)!.geometry;return new SceneSurfaceContact(id,geometry.getAttribute("position").array as Float32Array,geometry.index!.array as Uint16Array|Uint32Array);}),counts=[0,0,0],normal=projectionNormals.get(part.id)!;
      for(let offset=0;offset<range.count;offset++){const i=range.start+offset,column=offset%(range.columns+1),first=i-column,last=first+range.columns;
        const edgeDistance=Math.min(Math.hypot(p.getX(i)-p.getX(first),p.getY(i)-p.getY(first),p.getZ(i)-p.getZ(first)),Math.hypot(p.getX(i)-p.getX(last),p.getY(i)-p.getY(last),p.getZ(i)-p.getZ(last)));
        if(edgeDistance>6)continue;
        let chosen=-1,nearest=Infinity;
        for(let h=0;h<hosts.length;h++){const hit=hosts[h]!.raycast([p.getX(i),p.getY(i),p.getZ(i)+.05],[0,0,-1]);if(!hit)continue;const gap=p.getZ(i)-hit.pointMm[2];if(gap>=0&&gap<nearest){chosen=h;nearest=gap;}}
        // No material transfer through a gap. A tiny, thin rim admits the
        // underlying serosal appearance; the opaque apron interior is retained.
        if(chosen<0||nearest>1.4)continue;
        distance[i*3+chosen]=edgeDistance+nearest*2;counts[chosen]!++;
        const hit=hosts[chosen]!.closestPoint([p.getX(i),p.getY(i),p.getZ(i)]);if(hit){const n=new THREE.Vector3().fromArray(normal,i*3),target=new THREE.Vector3(...hit.normal);if(n.dot(target)<0)n.negate();n.lerp(target,interfaceWeight(distance[i*3+chosen]!,5)).normalize().toArray(normal,i*3);}
      }
      hosts.forEach((h,i)=>{if(counts[i])covers.push({a:part.id,b:["colon","small-intestine","duodenum"][i]!,vertices:counts[i]!});});
    }
    part.geometry.setAttribute("sceneCoverDistance",new THREE.BufferAttribute(distance,3));
  }
  return {edges,fields,projectionNormals,roots,covers};
}

export function interfaceMaterialRecipe(id:string,sample:VirtaMedVariation|null) {
  const direct=sample?.recipes?.[id]?.material;if(direct)return direct;
  const sources=id==="hepatoduodenal-ligament"?["liver","gallbladder"]:id==="falciform-ligament"?["liver"]:id.includes("duct")?["gallbladder"]:id.includes("fat")?["colon","small-intestine"]:[];
  const values=sources.map(s=>sample?.recipes?.[s]?.material).filter(v=>v!==undefined);
  const mean=(key:"wetness"|"pigment_contrast"|"fine_detail"|"tint"|"mottle_scale_mm"|"structure_strength",fallback:number)=>values.length?values.reduce((sum,v)=>sum+v[key],0)/values.length:fallback;
  return {wetness:mean("wetness",.6),pigment_contrast:mean("pigment_contrast",1),fine_detail:mean("fine_detail",.5),tint:mean("tint",0),mottle_scale_mm:mean("mottle_scale_mm",10),structure_strength:mean("structure_strength",.5)};
}

/** Variation uses BOTH endpoints. Width is a bounded visual design parameter,
 * not a measured fascia thickness or a patient-calibrated pathology estimate. */
export function interfaceVariation(edge:TissueInterface,sample:VirtaMedVariation|null) {
  const a=interfaceMaterialRecipe(edge.a,sample),b=interfaceMaterialRecipe(edge.b,sample);
  const wet=((a?.wetness??.6)+(b?.wetness??.6))/2,detail=((a?.fine_detail??.5)+(b?.fine_detail??.5))/2;
  const active=!sample?.variation.baseline,condition=sample?.disease??"baseline",severity=active?(sample?.variation.severity??0):0;
  const edema=condition==="gallbladder-cholecystitis"&&(edge.a==="gallbladder"||edge.b==="hepatoduodenal-ligament")?severity:0;
  return {widthMm:edge.widthMm*(1+.12*(wet-.6)+.1*(detail-.5)+.15*edema),wetness:wet,detail,edema,seed:active?sample?.variation.seed??0:0};
}

export function interfaceSnapshot(graph:InterfaceGraph|null,sample:VirtaMedVariation|null) {
  return graph?{version:VIRTAMED_INTERFACE_VERSION,coordinates:"intrinsic rest-surface millimetres",policy:"registered attachments blend full PBR; unregistered contacts retain sliding serosa",covers:graph.covers.map(c=>({...c,kind:"thin-cover",maximumRestGapMm:1.4})),edges:graph.edges.map(e=>({id:e.id,a:e.a,b:e.b,kind:e.kind,registeredRoots:e.roots.length,...interfaceVariation(e,sample)}))}:null;
}

/** Match oriented root normals after every deformation/normal update. Closed
 * sheet backs retain the opposite orientation rather than cancelling the front. */
export function reconcileInterfaceNormals(parts:InterfacePart[],graph:InterfaceGraph) {
  for(const edge of graph.edges){const host=parts.find(p=>p.id===edge.a)!.geometry.getAttribute("normal"),sheet=parts.find(p=>p.id===edge.b)!.geometry.getAttribute("normal");
    for(const point of edge.roots){const hi=graph.roots.get(edge.a)!.get(key(point))![0]!,x=host.getX(hi),y=host.getY(hi),z=host.getZ(hi);
      for(const i of graph.roots.get(edge.b)!.get(key(point))!){const sign=sheet.getX(i)*x+sheet.getY(i)*y+sheet.getZ(i)*z<0?-1:1;sheet.setXYZ(i,x*sign,y*sign,z*sign);}
    }sheet.needsUpdate=true;
  }
}
