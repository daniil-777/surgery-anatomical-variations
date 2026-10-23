import { CUTTING_NUMERICS } from "./numerics";
import type { CuttingReference, ScalpelGeometry, ScalpelPose } from "./types";

type Plane = readonly [number, number, number, number];
type Point2 = readonly [number, number];
export interface SurfacePenetrationBounds {
  /** Numerical bounds on maximum penetration over the entire source cap. */
  lowerMm: number; upperMm: number; worstTriangle: number;
  triangleCount: number; candidateTriangles: number;
}
const RESOLUTION_MM = CUTTING_NUMERICS.surfaceBoundResolutionMm;

function bladePlanes(shape: ScalpelGeometry): Plane[] {
  const {halfThicknessMm:t,halfLengthMm:length,heightMm:height,halfAngleRadians:angle}=shape;
  const bevel=shape.endBevelMm??0;
  if(![t,length,height,angle,bevel].every(Number.isFinite)||Math.min(t,length,height,angle)<=0||angle>=Math.PI/2||bevel<0||bevel>=length||t/Math.tan(angle)>=height)throw new Error("Invalid finite blade dimensions");
  const slope=Math.tan(angle),norm=Math.hypot(1,slope);
  const planes:Plane[]=[[1/norm,-slope/norm,0,0],[-1/norm,-slope/norm,0,0],
    [1,0,0,-t],[-1,0,0,-t],[0,1,0,-height],[0,0,1,-length],[0,0,-1,-length]];
  if(bevel>0){const scale=Math.hypot(bevel,t),ex=bevel/scale,ez=t/scale;
    for(const sx of [-1,1])for(const sz of [-1,1])planes.push([sx*ex,0,sz*ez,-ez*length]);}
  return planes;
}

/** Intersect the triangle's barycentric simplex with a shrunken blade.
 * Inflating each clipping halfspace by pad preserves a conservative numerical
 * feasibility test. A feasible returned witness is evaluated independently. */
function clippedWitness(distances:Float64Array,count:number,depth:number,pad:number):Point2|undefined {
  let polygon:Point2[]=[[0,0],[1,0],[0,1]];
  for(let plane=0;plane<count;plane++){
    const base=distances[3*plane]!,du=distances[3*plane+1]!-base,dv=distances[3*plane+2]!-base;
    const value=(p:Point2)=>base+du*p[0]+dv*p[1]+depth-pad;
    const next:Point2[]=[];let prior=polygon[polygon.length-1]!,priorValue=value(prior);
    for(const current of polygon){
      const currentValue=value(current);
      if((priorValue<=0)!==(currentValue<=0)){
        const t=priorValue/(priorValue-currentValue);
        next.push([prior[0]+t*(current[0]-prior[0]),prior[1]+t*(current[1]-prior[1])]);
      }
      if(currentValue<=0)next.push(current);
      prior=current;priorValue=currentValue;
    }
    if(!next.length)return undefined;
    polygon=next;
  }
  let u=0,v=0;for(const point of polygon){u+=point[0];v+=point[1];}
  return[u/polygon.length,v/polygon.length];
}

function boundsFromDistances(distances:Float64Array,count:number):{lowerMm:number;upperMm:number;candidate:boolean} {
  let separating=-Infinity,scale=1;
  const vertexMax=[-Infinity,-Infinity,-Infinity];
  for(let plane=0;plane<count;plane++){
    let minimum=Infinity;
    for(let j=0;j<3;j++){const d=distances[3*plane+j]!;minimum=Math.min(minimum,d);vertexMax[j]=Math.max(vertexMax[j]!,d);scale=Math.max(scale,Math.abs(d));}
    separating=Math.max(separating,minimum);
  }
  const pad=1e-9+128*Number.EPSILON*scale;
  if(separating>=pad)return{lowerMm:0,upperMm:0,candidate:false};
  let lower=Math.max(0,-Math.min(...vertexMax)-pad),upper=Math.max(0,-separating+pad);
  for(let iteration=0;upper-lower>RESOLUTION_MM&&iteration<40;iteration++){
    const depth=.5*(lower+upper),witness=clippedWitness(distances,count,depth,pad);
    if(!witness){upper=depth+pad;continue;}
    const [u,v]=witness;let nearest=-Infinity;
    for(let plane=0;plane<count;plane++)nearest=Math.max(nearest,(1-u-v)*distances[3*plane]!+u*distances[3*plane+1]!+v*distances[3*plane+2]!);
    lower=Math.max(lower,-nearest-pad,0);
  }
  if(!Number.isFinite(lower)||!Number.isFinite(upper)||upper<lower||upper-lower>RESOLUTION_MM)throw new Error("Continuous cap penetration bounds unresolved");
  return{lowerMm:lower,upperMm:upper,candidate:true};
}

/** Pure analytic test entry point. Coordinates are blade-local millimetres. */
export function triangleBladePenetrationBounds(triangleMm:ArrayLike<number>,shape:ScalpelGeometry):{lowerMm:number;upperMm:number} {
  if(triangleMm.length!==9||Array.from(triangleMm).some(v=>!Number.isFinite(v)))throw new Error("Finite triangle required");
  const planes=bladePlanes(shape),distances=new Float64Array(3*planes.length);
  planes.forEach(([nx,ny,nz,c],plane)=>{for(let j=0;j<3;j++)distances[3*plane+j]=nx*triangleMm[3*j]!+ny*triangleMm[3*j+1]!+nz*triangleMm[3*j+2]!+c;});
  const {lowerMm,upperMm}=boundsFromDistances(distances,planes.length);return{lowerMm,upperMm};
}

/** Saved/current-state geometric validity, independent of contact quadrature.
 * Each embedded cap triangle is affine in one tet. Its maximum true interior
 * finite-prism distance is bounded using separating planes then convex polygon
 * clipping/bisection. This is not force integration or swept collision. No
 * positions, contact sides, damage, or material histories are changed.
 * Bounds include floating-point padding; they are not interval-arithmetic proofs.
 */
export class ContactSurfaceValidator {
  private readonly planes:Plane[];
  private readonly indices:Uint32Array;
  private readonly ids:Uint32Array;
  private readonly weights:Float64Array;
  private readonly verticesMm:Float64Array;
  private readonly distances:Float64Array;
  private readonly positionLength:number;
  private readonly planeXMm:number;

  constructor(mesh:CuttingReference,shape:ScalpelGeometry){
    const cap=mesh.cap;
    if(!cap||!cap.indices.length||cap.indices.length%3||cap.positionsMm.length%3)throw new Error("Source cap triangles required");
    const count=cap.positionsMm.length/3;
    if(cap.tetIndices.length!==count||cap.weights.length!==4*count)throw new Error("Incomplete source cap embedding");
    this.planes=bladePlanes(shape);this.positionLength=mesh.positionsMm.length;this.planeXMm=mesh.planeXMm;
    if(!Number.isFinite(this.planeXMm)||this.positionLength%3||!mesh.positionsMm.every(Number.isFinite))throw new Error("Finite mechanical reference required");
    this.indices=Uint32Array.from(cap.indices);this.ids=new Uint32Array(4*count);this.weights=Float64Array.from(cap.weights);
    this.verticesMm=new Float64Array(3*count);this.distances=new Float64Array(3*this.planes.length);
    for(let i=0;i<count;i++){
      const tet=cap.tetIndices[i]!;
      if(!Number.isInteger(tet)||tet<0||4*tet+3>=mesh.tets.length)throw new Error("Invalid cap support tetrahedron");
      let total=0;const reconstructed=[0,0,0];
      for(let j=0;j<4;j++){
        const id=mesh.tets[4*tet+j]!,w=this.weights[4*i+j]!;
        if(!Number.isInteger(id)||id<0||3*id+2>=this.positionLength||!Number.isFinite(w)||w< -1e-9)throw new Error("Invalid cap barycentric embedding");
        this.ids[4*i+j]=id;total+=w;for(let axis=0;axis<3;axis++)reconstructed[axis]!+=w*mesh.positionsMm[3*id+axis]!;
      }
      if(Math.abs(total-1)>1e-8||reconstructed.some((v,axis)=>!Number.isFinite(cap.positionsMm[3*i+axis])||Math.abs(v-cap.positionsMm[3*i+axis]!)>1e-6))throw new Error("Cap embedding does not reconstruct reference");
    }
    for(let offset=0;offset<cap.indices.length;offset+=3){
      const ids=cap.indices.slice(offset,offset+3);
      if(ids.some(id=>!Number.isInteger(id)||id<0||id>=count)||ids.some(id=>cap.tetIndices[id]!==cap.tetIndices[ids[0]!]))throw new Error("Each cap triangle must be affine within one support tetrahedron");
    }
  }

  evaluate(positionsM:ArrayLike<number>,pose:ScalpelPose):SurfacePenetrationBounds {
    if(positionsM.length!==this.positionLength||![pose.tipYMm,pose.centerZMm].every(Number.isFinite)||typeof pose.active!=="boolean")throw new Error("Invalid continuous cap evaluation state");
    for(let i=0;i<positionsM.length;i++)if(!Number.isFinite(positionsM[i]))throw new Error("Finite current positions required");
    const result:SurfacePenetrationBounds={lowerMm:0,upperMm:0,worstTriangle:-1,triangleCount:this.indices.length/3,candidateTriangles:0};
    if(!pose.active)return result;
    for(let i=0;i<this.verticesMm.length/3;i++)for(let axis=0;axis<3;axis++){
      let value=0;for(let j=0;j<4;j++)value+=this.weights[4*i+j]!*positionsM[3*this.ids[4*i+j]!+axis]!;
      this.verticesMm[3*i+axis]=value*1000-(axis===0?this.planeXMm:axis===1?pose.tipYMm:pose.centerZMm);
    }
    for(let offset=0;offset<this.indices.length;offset+=3){
      for(let p=0;p<this.planes.length;p++){
        const [nx,ny,nz,c]=this.planes[p]!;
        for(let j=0;j<3;j++){const id=this.indices[offset+j]!;this.distances[3*p+j]=nx*this.verticesMm[3*id]!+ny*this.verticesMm[3*id+1]!+nz*this.verticesMm[3*id+2]!+c;}
      }
      const bounds=boundsFromDistances(this.distances,this.planes.length);
      if(bounds.candidate)result.candidateTriangles++;
      result.lowerMm=Math.max(result.lowerMm,bounds.lowerMm);
      if(bounds.upperMm>result.upperMm){result.upperMm=bounds.upperMm;result.worstTriangle=offset/3;}
    }
    return result;
  }
}
