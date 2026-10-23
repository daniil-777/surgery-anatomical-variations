import type { CuttingReference } from "./types";

export interface ContactSample { readonly index: number; ids: number[]; weights: Float64Array; areaM2: number; side: -1 | 1 }
export interface ContactQuadrature {
  samples: ContactSample[];
  adjacent: { sample: ContactSample; weight: number }[][];
  oneSidedAreaM2: number;
  mode: "source-cap" | "legacy-seam-nodes";
}
type Point = { y: number; z: number; w: number[] };
type Piece = { polygon: Point[]; area: number; weights: number[]; y: number; z: number };

function clip(points: Point[], axis: "y" | "z", bound: number, sign: number): Point[] {
  const output: Point[] = [];
  for (let i=0;i<points.length;i++) {
    const a=points[i]!, b=points[(i+1)%points.length]!, da=sign*(a[axis]-bound), db=sign*(b[axis]-bound);
    if (da>=0) output.push(a);
    if ((da<0&&db>0)||(da>0&&db<0)) {
      const t=da/(da-db);
      output.push({y:a.y+t*(b.y-a.y),z:a.z+t*(b.z-a.z),w:a.w.map((v,j)=>v+t*(b.w[j]!-v))});
    }
  }
  return output;
}
function integrate(polygon: Point[]): Piece | null {
  if(polygon.length<3)return null;
  let area=0,y=0,z=0; const weights=[0,0,0,0],a=polygon[0]!;
  for(let i=1;i+1<polygon.length;i++) {
    const b=polygon[i]!,c=polygon[i+1]!,v=Math.abs((b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y))/2;
    area+=v; y+=v*(a.y+b.y+c.y)/3;z+=v*(a.z+b.z+c.z)/3;
    for(let j=0;j<4;j++)weights[j]!+=v*(a.w[j]!+b.w[j]!+c.w[j]!)/3;
  }
  if(area<1e-16)return null;
  return {polygon,area,y:y/area,z:z/area,weights:weights.map(v=>v/area)};
}
function contains(polygon: Point[],y:number,z:number):boolean {
  let positive=false,negative=false;
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!,cross=(b.y-a.y)*(z-a.z)-(b.z-a.z)*(y-a.y);
    positive ||= cross>1e-9;negative ||= cross< -1e-9;
  }
  return !(positive&&negative);
}

/** Reference-area quadrature of the actual source cross-section. Each source
 * triangle lies in one mechanical tetrahedron. Grid clipping integrates area
 * and affine interpolation exactly; cell centroids approximate nonlinear contact.
 * Adjacent clipped pieces with the same support are merged only when their
 * centroid remains inside their union, preserving nonconvex source boundaries.
 * This adds contact samples, not independent deformation or fracture DOFs. */
export function buildContactQuadrature(mesh: CuttingReference, spacingMm=2.5): ContactQuadrature {
  if(!Number.isFinite(spacingMm)||spacingMm<=0)throw new Error("Positive contact quadrature spacing required");
  const samples:ContactSample[]=[],adjacent:ContactQuadrature["adjacent"]=Array.from({length:mesh.positionsMm.length/3},()=>[]);
  if(!mesh.cap){
    for(const pair of mesh.seamPairs)for(const [id,side] of [[pair.left,-1],[pair.right,1]] as const)samples.push({index:samples.length,ids:[id],weights:new Float64Array([1]),areaM2:pair.areaM2,side});
  } else {
    const cap=mesh.cap,groups=new Map<string,{tet:number;pieces:Piece[]}>();
    for(let offset=0;offset<cap.indices.length;offset+=3){
      const corners=cap.indices.slice(offset,offset+3),tet=cap.tetIndices[corners[0]!]!;
      if(corners.some(id=>cap.tetIndices[id]!==tet))throw new Error("Contact cap triangle must have one support tetrahedron");
      const triangle=corners.map(id=>({y:cap.positionsMm[3*id+1]!,z:cap.positionsMm[3*id+2]!,w:cap.weights.slice(4*id,4*id+4)}));
      const ymin=Math.floor(Math.min(...triangle.map(p=>p.y))/spacingMm),ymax=Math.floor(Math.max(...triangle.map(p=>p.y))/spacingMm);
      const zmin=Math.floor(Math.min(...triangle.map(p=>p.z))/spacingMm),zmax=Math.floor(Math.max(...triangle.map(p=>p.z))/spacingMm);
      for(let iy=ymin;iy<=ymax;iy++)for(let iz=zmin;iz<=zmax;iz++){
        let polygon=clip(triangle,"y",iy*spacingMm,1);polygon=clip(polygon,"y",(iy+1)*spacingMm,-1);
        polygon=clip(polygon,"z",iz*spacingMm,1);polygon=clip(polygon,"z",(iz+1)*spacingMm,-1);
        const piece=integrate(polygon);if(!piece)continue;
        const key=`${tet}:${iy}:${iz}`,group=groups.get(key);
        if(group)group.pieces.push(piece);else groups.set(key,{tet,pieces:[piece]});
      }
    }
    for(const {tet,pieces} of groups.values()){
      const ids=mesh.tets.slice(4*tet,4*tet+4);
      if(ids.length!==4)throw new Error("Invalid contact support tetrahedron");
      const side: -1|1=ids.reduce((sum,id)=>sum+mesh.positionsMm[3*id]!,0)/4<mesh.planeXMm?-1:1;
      const area=pieces.reduce((sum,p)=>sum+p.area,0),y=pieces.reduce((sum,p)=>sum+p.area*p.y,0)/area,z=pieces.reduce((sum,p)=>sum+p.area*p.z,0)/area;
      const merged={area,weights:[0,1,2,3].map(j=>pieces.reduce((sum,p)=>sum+p.area*p.weights[j]!,0)/area)};
      const selected=pieces.some(p=>contains(p.polygon,y,z))?[merged]:pieces;
      for(const piece of selected){
        if(piece.weights.some(w=>!Number.isFinite(w)||w< -1e-7)||Math.abs(piece.weights.reduce((a,b)=>a+b,0)-1)>1e-7)throw new Error("Invalid contact interpolation weights");
        const retained=piece.weights.map((w,i)=>({w:Math.max(0,w),id:ids[i]!})).filter(v=>v.w>1e-12),sum=retained.reduce((a,b)=>a+b.w,0);
        samples.push({index:samples.length,ids:retained.map(v=>v.id),weights:Float64Array.from(retained,v=>v.w/sum),areaM2:piece.area*1e-6,side});
      }
    }
  }
  let left=0,right=0;
  for(const sample of samples){
    if(sample.side<0)left+=sample.areaM2;else right+=sample.areaM2;
    sample.ids.forEach((id,j)=>adjacent[id]!.push({sample,weight:sample.weights[j]!}));
  }
  if(!(left>0)||Math.abs(left-right)>1e-8*Math.max(left,right))throw new Error("Contact sides require equal positive reference area");
  return {samples,adjacent,oneSidedAreaM2:(left+right)/2,mode:mesh.cap?"source-cap":"legacy-seam-nodes"};
}
