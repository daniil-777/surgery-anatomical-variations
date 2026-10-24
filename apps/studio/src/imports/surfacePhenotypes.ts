import { Matrix3, Vector3, type BufferGeometry, type Matrix4 } from "three";
import type { AtlasDiseaseSpec } from "../atlasDisease";
import { Pcg64 } from "../numpyRandom";
import type { ImportedDiseaseProfile } from "./variations";

export interface SurfacePhenotype {
  displacement: Float64Array;
  mask: Float32Array;
  rim: Float32Array;
  globalScale: [number, number, number];
  targetLinear: [number, number, number];
  siteRadii: number[];
}
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const linear = (x: number) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;

/** Edge geodesics prevent pathology jumping across nearby, disconnected bowel
 * loops. Weld coincident UV/normal seams for traversal only; never change the mesh. */
export function surfaceGraph(coords: Float64Array, geometry: BufferGeometry) {
  const count = coords.length / 3;
  let scale = 0;
  for (const value of coords) scale = Math.max(scale, Math.abs(value));
  const tolerance = Math.max(scale * 1e-7, 1e-9);
  const keys = new Map<string, number>(), representatives: number[] = [], vertexNode = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(coords[i*3]! / tolerance)},${Math.round(coords[i*3+1]! / tolerance)},${Math.round(coords[i*3+2]! / tolerance)}`;
    let node = keys.get(key);
    if (node === undefined) { node = representatives.length; keys.set(key, node); representatives.push(i); }
    vertexNode[i] = node;
  }
  const neighbors = representatives.map(() => new Map<number, number>());
  const edge = (a: number, b: number) => {
    const u = vertexNode[a]!, v = vertexNode[b]!;
    if (u === v || neighbors[u]!.has(v)) return;
    const d = Math.hypot(coords[a*3]! - coords[b*3]!, coords[a*3+1]! - coords[b*3+1]!, coords[a*3+2]! - coords[b*3+2]!);
    neighbors[u]!.set(v, d); neighbors[v]!.set(u, d);
  };
  const index = geometry.index, corners = index?.count ?? count;
  for (let i = 0; i + 2 < corners; i += 3) {
    const a = index ? index.getX(i) : i, b = index ? index.getX(i+1) : i+1, c = index ? index.getX(i+2) : i+2;
    edge(a,b); edge(b,c); edge(c,a);
  }
  return { representatives, vertexNode, neighbors };
}

function distances(graph: ReturnType<typeof surfaceGraph>, anchor: number, radius: number) {
  const out = new Map<number, number>();
  // Binary min-heap; each search visits only the lesion's surface support.
  const heap: [number, number][] = [[0, anchor]];
  out.set(anchor, 0);
  const push = (entry: [number, number]) => {
    let i = heap.length; heap.push(entry);
    while (i > 0) { const p = (i-1) >> 1; if (heap[p]![0] <= entry[0]) break; heap[i] = heap[p]!; i = p; }
    heap[i] = entry;
  };
  while (heap.length) {
    const [d, at] = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i*2+1 < heap.length) {
        let child = i*2+1;
        if (child+1 < heap.length && heap[child+1]![0] < heap[child]![0]) child++;
        if (heap[child]![0] >= last[0]) break;
        heap[i] = heap[child]!; i = child;
      }
      heap[i] = last;
    }
    if (d !== out.get(at)) continue;
    for (const [next, length] of graph.neighbors[at]!) {
      const nd = d + length;
      if (nd > radius || nd >= (out.get(next) ?? Infinity)) continue;
      out.set(next, nd); push([nd,next]);
    }
  }
  return out;
}

/** Evidence-informed external phenotypes, not a patient reconstruction.
 * Geometry and pigmentation use the SAME rest-surface support. Disease sizes
 * are relative to organ bounds; no universal radius floor, no mucosal texture. */
export function buildSurfacePhenotype(coords: Float64Array, geometry: BufferGeometry, world: Matrix4,
  disease: AtlasDiseaseSpec, profile: ImportedDiseaseProfile, shape: number, texture: number): SurfacePhenotype {
  const count = coords.length / 3;
  const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  for (let i=0;i<coords.length;i++) { const k=i%3; lo[k]=Math.min(lo[k]!,coords[i]!); hi[k]=Math.max(hi[k]!,coords[i]!); }
  const extent = hi.map((v,k)=>v-lo[k]!);
  const diagonal = Math.max(Math.hypot(...extent),1e-8);
  const severity = clamp(disease.severity), strength = clamp(shape) * severity;
  const id=profile.id;
  const nodular = id.includes("cirrhosis");
  const cyst = /cyst/.test(id) && !/cholecystitis/.test(id);
  const metastatic = /metastas/.test(id);
  const steatotic = /steatotic/.test(id);
  const inflamed = /cholecystitis|crohn|diffuse-swelling/.test(id);
  const diffuse = steatotic || /distension|contraction|enlargement|splenomegaly|diffuse-swelling|pancreatitis/.test(id);
  const infarct = /infarct/.test(id);
  const out: SurfacePhenotype = {
    displacement:new Float64Array(coords.length), mask:new Float32Array(count), rim:new Float32Array(count),
    globalScale:profile.logScale.map(s=>Math.exp(s*strength)) as [number,number,number],
    targetLinear:profile.srgb.map(linear) as [number,number,number], siteRadii:[],
  };
  // Intact capsules retain organ pigment over masses. Cut-surface golden RCC
  // and mucosal ulcer appearances must not be transferred to external serosa.
  if (/kidney.*(carcinoma|cancer)/.test(id)) out.targetLinear=[.43,.22,.17].map(linear) as [number,number,number];
  if (cyst) out.targetLinear = (profile.organ === 'spleen' ? [.66,.59,.53] : [.57,.59,.50]).map(linear) as [number,number,number];
  if (inflamed) out.targetLinear=[.56,.23,.21].map(linear) as [number,number,number];
  if (infarct) out.targetLinear=[.58,.49,.43].map(linear) as [number,number,number];
  if (severity === 0) return out;
  const chroma = severity * clamp(texture) * (.45+.4*clamp(disease.contrast));
  if (diffuse) {
    for (let i=0;i<count;i++) {
      const x=coords[i*3]!/diagonal,y=coords[i*3+1]!/diagonal,z=coords[i*3+2]!/diagonal;
      const mottling=.85+.15*Math.sin(x*17+z*9)*Math.cos(y*19-z*11);
      out.mask[i]=chroma*mottling;
    }
    return out;
  }
  const graph=surfaceGraph(coords,geometry), rng=new Pcg64(disease.seed);
  const target=extent.map((e,k)=>(lo[k]!+hi[k]!)*.5+disease.location[k]!*e*.5);
  let first=0,best=Infinity;
  for (let a=0;a<graph.representatives.length;a++) {
    const i=graph.representatives[a]!;
    const d=Math.hypot(coords[i*3]!-target[0]!,coords[i*3+1]!-target[1]!,coords[i*3+2]!-target[2]!);
    if(d<best){best=d;first=a;}
  }
  const radius=diagonal*(profile.rMin+profile.rRange*clamp(disease.size));
  const sites=nodular ? Math.round(150+220*severity) : Math.min(profile.maxSites,Math.max(1,Math.round(disease.count*profile.mult)));
  const anchors=[first], occupied=new Float32Array(graph.representatives.length);
  const nodeHeight=new Float64Array(graph.representatives.length),nodeMask=new Float32Array(graph.representatives.length),nodeRim=new Float32Array(graph.representatives.length);
  const pool=rng.permutation(Array.from({length:graph.representatives.length},(_,i)=>i));
  let cursor=0;
  for(let site=0;site<sites;site++) {
    let anchor=anchors[site];
    if(anchor===undefined) {
      while(cursor<pool.length) {
        const candidate=pool[cursor++]!;
        if(occupied[candidate]!>.16)continue;
        const i=graph.representatives[candidate]!,j=graph.representatives[first]!;
        const d=Math.hypot(coords[i*3]!-coords[j*3]!,coords[i*3+1]!-coords[j*3+1]!,coords[i*3+2]!-coords[j*3+2]!);
        if(!nodular && d>diagonal*(.2+.8*disease.spread))continue;
        anchor=candidate;anchors.push(anchor);break;
      }
    }
    if(anchor===undefined)break;
    const r=radius*(nodular ? .55+.9*rng.nextDouble() : .8+.4*rng.nextDouble());
    out.siteRadii.push(r);
    const phase=rng.nextDouble()*Math.PI*2;
    const ai=graph.representatives[anchor]!;
    for(const [node,distance] of distances(graph,anchor,r)) {
      const i=graph.representatives[node]!;
      const dx=(coords[i*3]!-coords[ai*3]!)/r,dy=(coords[i*3+1]!-coords[ai*3+1]!)/r,dz=(coords[i*3+2]!-coords[ai*3+2]!)/r;
      const irregular=cyst ? 1 : 1+.12*disease.irregularity*Math.sin(dx*4+phase)*Math.cos(dy*5-dz*3);
      const t=clamp(distance/r*irregular), support=1-t*t;
      const dome=support*support;
      const wedge=infarct ? clamp(.65+dy*.6-dx*.2) : 1;
      let h = dome*support;
      if(cyst)h=dome;
      if(metastatic)h=dome*.8-.28*Math.exp(-t*t*50)*support; // shallow central umbilication
      const amplitude=r*(cyst ? .40 : nodular ? .23 : id.includes("crohn") ? .045 : Math.min(.24,Math.abs(profile.amp)*1.6));
      nodeHeight[node]=nodeHeight[node]!+Math.sign(profile.amp)*amplitude*strength*h*wedge;
      // Pale apex of cyst; diffuse subtle nodular mottling, no dark bullseye ring.
      const pigment=cyst ? dome**3 : infarct ? dome*wedge : dome;
      nodeMask[node]=Math.max(nodeMask[node]!,pigment*chroma*(nodular?.5:1));
      nodeRim[node]=Math.max(nodeRim[node]!,nodular ? t*t*support*chroma*.15 : 0);
      occupied[node]=Math.max(occupied[node]!,dome);
    }
  }
  const normal=geometry.getAttribute('normal'), transform=new Matrix3().getNormalMatrix(world), n=new Vector3();
  // Smooth normals at split attribute seams; displacement remains continuous.
  const normals=graph.representatives.map(()=>new Vector3());
  for(let i=0;i<count;i++) {
    if(normal)n.fromBufferAttribute(normal,i).applyMatrix3(transform).normalize();
    else n.set(coords[i*3]!,coords[i*3+1]!,coords[i*3+2]!).normalize();
    normals[graph.vertexNode[i]!]!.add(n);
  }
  for(const normal of normals)normal.normalize();
  for(let i=0;i<count;i++) {
    const node=graph.vertexNode[i]!,h=clamp(nodeHeight[node]!,-radius*.3,radius*.5);
    n.copy(normals[node]!);out.displacement[i*3]=n.x*h;out.displacement[i*3+1]=n.y*h;out.displacement[i*3+2]=n.z*h;
    out.mask[i]=nodeMask[node]!;out.rim[i]=nodeRim[node]!;
  }
  return out;
}
