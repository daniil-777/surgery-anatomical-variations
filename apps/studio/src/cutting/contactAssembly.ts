/** Whole-triangle finite-penalty contact assembly for the prepared cut.
 * All public result arrays own their storage. History-free: no side transfer or
 * damage mutation. The reference side resolves exactly coincident plane ties.
 */
import { bladePlanes, type Plane, type TriangleGramTerm } from './contactIntegral';
import { TrianglePenaltyScratch } from './contactIntegralScratch';
import type { CuttingReference, ScalpelGeometry, ScalpelPose } from './types';
import type { RankOneTerm } from './preconditioner';
type V3 = [number, number, number];
interface Group { index: number; ids: number[]; maximumNegativeWeight: number; maximumWeightSumError: number }
interface Triangle { ids: number[]; weights: number[][]; areaM2: number; side: -1 | 1; group: Group }

export class IntegratedContactAssembly {
  private readonly triangles: Triangle[] = [];
  private readonly adjacent: Triangle[][];
  private readonly length: number;
  private readonly shape: ScalpelGeometry;
  private readonly planeXMm: number;
  private readonly triangleScratch: V3[] = [[0,0,0],[0,0,0],[0,0,0]];
  private cachedPose: ScalpelPose | null = null;
  private leftPlanes: Plane[] = [];
  private rightPlanes: Plane[] = [];
  private readonly groupSeen: Float64Array;
  private readonly groupOutside: Uint8Array;
  private generation = 0;
  private leftIntegrator: TrianglePenaltyScratch | null = null;
  private rightIntegrator: TrianglePenaltyScratch | null = null;
  private readonly integralGradient = new Float64Array(9);
  private readonly integralGram = new Float64Array(81);
  private readonly noGram = new Float64Array(0);
  private readonly integralTerms: TriangleGramTerm[] = [];
  readonly oneSidedAreaM2: number;

  constructor(mesh: CuttingReference, shape: ScalpelGeometry, private readonly stiffnessPaPerM = 8e11) {
    this.shape = { ...shape }; this.length = mesh.positionsMm.length;
    this.planeXMm = mesh.planeXMm;
    if (!this.length || this.length%3 || !mesh.positionsMm.every(Number.isFinite) || !Number.isFinite(this.planeXMm)) throw new Error('Finite mechanical reference required');
    this.adjacent = Array.from({ length: this.length / 3 }, () => []);
    if (!mesh.cap || !Number.isFinite(stiffnessPaPerM) || stiffnessPaPerM <= 0) throw new Error('Valid cap and contact stiffness required');
    const cap = mesh.contactCap ?? mesh.cap;
    const count=cap.positionsMm.length/3;
    if (!Number.isInteger(count) || !count || cap.indices.length%3 || cap.tetIndices.length!==count || cap.weights.length!==4*count || !cap.positionsMm.every(Number.isFinite)) throw new Error('Complete finite source cap required');
    let leftArea = 0, rightArea = 0;
    const groups = new Map<number, Group>();
    for (let offset = 0; offset < cap.indices.length; offset += 3) {
      const corners = cap.indices.slice(offset, offset + 3);
      if(corners.some(id=>!Number.isInteger(id)||id<0||id>=count))throw new Error('Invalid cap triangle indices');
      const tet = cap.tetIndices[corners[0]!]!;
      if(!Number.isInteger(tet)||tet<0||4*tet+3>=mesh.tets.length)throw new Error('Invalid cap support tetrahedron');
      if (corners.some(id => cap.tetIndices[id] !== tet)) throw new Error('Each triangle must have a single affine support tetrahedron');
      const ids = mesh.tets.slice(4 * tet, 4 * tet + 4);
      if (ids.length !== 4 || new Set(ids).size !== 4 || ids.some(id=>!Number.isInteger(id)||id<0||3*id+2>=this.length)) throw new Error('Invalid support tetrahedron');
      const p = corners.map(id => cap.positionsMm.slice(3 * id, 3 * id + 3));
      const a = [0,1,2].map(k => p[1]![k]! - p[0]![k]!), b = [0,1,2].map(k => p[2]![k]! - p[0]![k]!);
      const areaM2 = .5e-6 * Math.hypot(a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!);
      if (!(areaM2 > 0) || !Number.isFinite(areaM2)) throw new Error('Positive finite triangle area required');
      const side: -1|1 = ids.reduce((sum,id) => sum + mesh.positionsMm[3*id]!,0) / 4 < mesh.planeXMm ? -1 : 1;
      const weights = corners.map(id => cap.weights.slice(4*id,4*id+4));
      if (weights.some(row => row.length !== 4 || row.some(v => !Number.isFinite(v)||v< -1e-9) || Math.abs(row.reduce((a,b)=>a+b,0)-1)>1e-8)) throw new Error('Valid affine interpolation required');
      for(let corner=0;corner<3;corner++)for(let axis=0;axis<3;axis++){
        const reconstructed=ids.reduce((sum,id,j)=>sum+weights[corner]![j]!*mesh.positionsMm[3*id+axis]!,0);
        if(Math.abs(reconstructed-p[corner]![axis]!)>1e-6)throw new Error('Cap embedding does not reconstruct reference');
      }
      let group = groups.get(tet);
      if (!group) { group={index:groups.size,ids,maximumNegativeWeight:0,maximumWeightSumError:0}; groups.set(tet,group); }
      for (const row of weights) {
        group.maximumNegativeWeight=Math.max(group.maximumNegativeWeight,-row.reduce((sum,w)=>sum+Math.min(0,w),0));
        group.maximumWeightSumError=Math.max(group.maximumWeightSumError,Math.abs(row.reduce((sum,w)=>sum+w,0)-1));
      }
      const triangle = { ids, weights, areaM2, side, group };
      this.triangles.push(triangle);
      ids.forEach(id => this.adjacent[id]!.push(triangle));
      if (side < 0) leftArea += areaM2; else rightArea += areaM2;
    }
    if (!(leftArea > 0) || Math.abs(leftArea-rightArea)>1e-8*leftArea) throw new Error('Equal positive cap areas required');
    this.oneSidedAreaM2 = (leftArea + rightArea) / 2;
    this.groupSeen = new Float64Array(groups.size); this.groupOutside = new Uint8Array(groups.size);
  }

  private planes(pose: ScalpelPose, side: -1 | 1): Plane[] {
    if (!this.cachedPose || pose.tipYMm !== this.cachedPose.tipYMm || pose.centerZMm !== this.cachedPose.centerZMm) {
      this.leftPlanes = bladePlanes(this.planeXMm*.001,pose,this.shape,-1);
      this.rightPlanes = bladePlanes(this.planeXMm*.001,pose,this.shape,1);
      this.leftIntegrator=new TrianglePenaltyScratch(this.leftPlanes,this.stiffnessPaPerM);
      this.rightIntegrator=new TrianglePenaltyScratch(this.rightPlanes,this.stiffnessPaPerM);
      this.cachedPose = { ...pose };
    }
    return side < 0 ? this.leftPlanes : this.rightPlanes;
  }

  private points(triangle: Triangle, positionsM: ArrayLike<number>): V3[] {
    for(let corner=0;corner<3;corner++)for(let axis=0;axis<3;axis++){
      let value=0;for(let j=0;j<4;j++)value+=triangle.weights[corner]![j]!*positionsM[3*triangle.ids[j]!+axis]!;
      this.triangleScratch[corner]![axis]=value;
    }
    return this.triangleScratch;
  }

  private outside(points: V3[], planes: Plane[]): boolean {
    // Exact separating-halfspace rejection, with precisely the same arithmetic
    // as the integral's distance evaluation. It avoids allocations for the many
    // cap triangles entirely outside the finite tool.
    for(const {normal:n,offset:c} of planes){
      let separates=true;
      for(let j=0;j<3;j++){
        const p=points[j]!,distance=n[0]*p[0]+n[1]*p[1]+n[2]*p[2]+c;
        // Invalid values must reach the strict integral validator, never appear
        // to be a separating halfspace because comparisons with NaN are false.
        if(!Number.isFinite(distance))return false;
        if(distance<0){separates=false;break;}
      }
      if(separates)return true;
    }
    return false;
  }

  private outsideGroup(group: Group, positions: ArrayLike<number>, planes: Plane[]): boolean {
    if(this.groupSeen[group.index]===this.generation)return this.groupOutside[group.index]===1;
    this.groupSeen[group.index]=this.generation; this.groupOutside[group.index]=0;
    let coordinateScale=1;
    for(const id of group.ids)for(let axis=0;axis<3;axis++){
      const value=positions[3*id+axis]!;
      if(!Number.isFinite(value))return false;
      coordinateScale+=Math.abs(value);
    }
    for(const {normal:n,offset:c} of planes){
      let minimum=Infinity,maximum=-Infinity;
      for(const id of group.ids){const k=3*id;const value=n[0]*positions[k]!+n[1]*positions[k+1]!+n[2]*positions[k+2]!+c;
        if(!Number.isFinite(value))return false;
        minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);
      }
      // Every cap vertex is an affine combination in this tet. Account for
      // admitted tiny negative weights and nonunit sums, then leave >1000 ULP
      // scale-aware slack for the differing arithmetic of embedded points.
      const lower=minimum-group.maximumNegativeWeight*(maximum-minimum)
        -group.maximumWeightSumError*(Math.abs(minimum)+Math.abs(c))
        -1e-12*(coordinateScale+Math.abs(c));
      if(lower>=0){this.groupOutside[group.index]=1;return true;}
    }
    return false;
  }

  /** Full incident energy for coordinate line search, additive 3-vector/3x3.
   * Do not divide incident triangle energy among the participating nodes. */
  evaluateNode(id: number, positionsM: ArrayLike<number>, pose: ScalpelPose, gradient?: Float64Array, hessian?: Float64Array): number {
    if (!pose.active) return 0;
    if (!Number.isInteger(id) || id < 0 || id >= this.adjacent.length || positionsM.length !== this.length) throw new Error('Invalid contact node/state');
    this.generation++;
    let energy = 0;
    for (const triangle of this.adjacent[id]!) {
      const planes=this.planes(pose,triangle.side);
      if(this.outsideGroup(triangle.group,positionsM,planes))continue;
      const points=this.points(triangle,positionsM);
      if(this.outside(points,planes))continue;
      const result = (triangle.side<0?this.leftIntegrator!:this.rightIntegrator!).evaluate(points,triangle.areaM2,this.integralGradient,hessian?this.integralGram:this.noGram);
      energy += result.energyJ;
      const local = triangle.ids.indexOf(id), weights = triangle.weights.map(row=>row[local]!);
      if (gradient) for(let c=0;c<3;c++)for(let a=0;a<3;a++) gradient[a]! += weights[c]! * this.integralGradient[3*c+a]!;
      if (hessian) for(let c=0;c<3;c++)for(let d=0;d<3;d++)for(let a=0;a<3;a++)for(let b=0;b<3;b++) hessian[3*a+b]! += weights[c]!*weights[d]!*this.integralGram[9*(3*c+a)+3*d+b]!;
    }
    return energy;
  }

  /** Each source triangle is integrated once. The optional positive Gram terms
   * map exactly to tet DOFs for the existing rank-one PCG preconditioner. */
  evaluateAll(positionsM: ArrayLike<number>, pose: ScalpelPose, includeGramTerms = false) {
    if (positionsM.length !== this.length) throw new Error('Invalid contact state length');
    const gradient = new Float64Array(this.length), contactForceN: V3 = [0,0,0], gramTerms: RankOneTerm[] = [];
    let energyJ = 0, activeAreaM2 = 0, activeTriangles = 0;
    this.generation++;
    if (pose.active) for(const triangle of this.triangles) {
      const planes=this.planes(pose,triangle.side);
      if(this.outsideGroup(triangle.group,positionsM,planes))continue;
      const points=this.points(triangle,positionsM);
      if(this.outside(points,planes))continue;
      const result = (triangle.side<0?this.leftIntegrator!:this.rightIntegrator!).evaluate(points,triangle.areaM2,this.integralGradient,this.noGram,includeGramTerms?this.integralTerms:undefined);
      energyJ += result.energyJ; activeAreaM2 += result.activeAreaM2;
      if (result.activeAreaM2 > 0) activeTriangles++;
      for(let j=0;j<4;j++)for(let c=0;c<3;c++)for(let axis=0;axis<3;axis++) gradient[3*triangle.ids[j]!+axis]! += triangle.weights[c]![j]! * this.integralGradient[3*c+axis]!;
      if(includeGramTerms)for(const term of this.integralTerms) {
        const indices: number[] = [], coefficients: number[] = [];
        for(let j=0;j<4;j++) {
          const weight=triangle.weights.reduce((sum,row,c)=>sum+row[j]!*term.bary[c]!,0);
          for(let axis=0;axis<3;axis++) if(weight*(term.normal[axis]??0)!==0) { indices.push(3*triangle.ids[j]!+axis); coefficients.push(weight*term.normal[axis]!); }
        }
        gramTerms.push({indices,coefficients:Float64Array.from(coefficients),stiffness:term.stiffness});
      }
    }
    for(let i=0;i<this.length;i++) contactForceN[i%3]! += gradient[i]!;
    return {energyJ,gradient,contactForceN,gramTerms,activeAreaM2,activeTriangles};
  }
}
