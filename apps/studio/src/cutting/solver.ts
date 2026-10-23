import { createLogVolumeCorrection } from "./logVolume";
import { IntegratedContactAssembly } from "./contactAssembly";
import type { PhysicsParameters } from "../atlasPhysics";
import { cofactor, continuumResponse, determinant, emptyMaxwellState, TetContinuumMaterial, type MaxwellState } from "../liverContinuumMaterial";
import { cohesiveEffectiveOpening, cohesiveResponse } from "./cohesive";
import { buildContactQuadrature, type ContactQuadrature, type ContactSample } from "./contactQuadrature";
import { minimizeIncremental } from "./minimize";
import { CUTTING_NUMERICS } from "./numerics";
import { ContactSurfaceValidator } from "./contactSurface";
import type { RankOneTerm } from "./preconditioner";
import { sparseBlockPreconditioner } from "./sparseBlockPreconditioner";
import { continuumBlocks } from "./continuumBlocks";
import { CuttingContinuumEvaluator, type CuttingContinuumEvaluation } from "./continuumEvaluator";
import { DEFAULT_SCALPEL, type CuttingOptions, type CuttingReference, type ScalpelGeometry, type ScalpelPose } from "./types";

type Vec3 = [number, number, number];
type Cell = { ids: number[]; volume: number; gradients: Float64Array; state: MaxwellState };
export interface CuttingMetrics {
  timeSeconds: number; acceptedSteps: number; rejectedSteps: number;
  lastStepSeconds: number; lastStepSweeps: number; lastGlobalIterations: number; timeStepRetries: number;
  minimumJacobian: number; volumeRatio: number; totalMassKg: number;
  contactForceN: Vec3; toolWorkJ: number; fractureDissipationJ: number;
  damagedAreaM2: number; separatedAreaM2: number; seamAreaM2: number; cohesiveAreaM2: number;
  maximumOpeningMm: number; maximumContactPenetrationMm: number;
  /** Numerical upper bound over the entire affine cap, null without a cap. */
  maximumSurfacePenetrationMm: number | null;
  fixtureEnergyJ: number; stationarityResidualN: number; lastError: string;
}

/** Closest inward distance of a convex finite blade. All plane normals have unit
 * length. Inside the prism, max(plane distances) is the exact signed distance.
 * A paired seam chooses its own bevel side only for the center-plane tie. */
export function scalpelContact(pointM: ArrayLike<number>, planeXM: number, pose: ScalpelPose, shape: ScalpelGeometry, side: -1 | 1) {
  return evaluateScalpelContact(pointM,planeXM,pose,shape,side,{penetrationM:0,normal:[0,0,0]});
}
/** Prepared interfaces retain their material side while the blade overlaps.
 * This directed barrier prevents a penetrated sample from changing escape side
 * at the center plane. The opposite side planes are omitted; finite tip/back/end
 * planes remain. It is a declared fixed-interface constraint, not a global SDF. */
export function preparedScalpelContact(pointM:ArrayLike<number>,planeXM:number,pose:ScalpelPose,shape:ScalpelGeometry,side:-1|1){
  return evaluateScalpelContact(pointM,planeXM,pose,shape,side,{penetrationM:0,normal:[0,0,0]},true);
}
/** A material point may pass around a finite blade tip/end. Change its contact
 * side only at a contact-free accepted state: both old and new potentials are
 * zero, so this history transfer releases neither stored energy nor force.
 * A 1 pm tie band retains the reference side of coincident seam samples. */
export function transferredScalpelContactSide(pointM:ArrayLike<number>,planeXM:number,pose:ScalpelPose,shape:ScalpelGeometry,side:-1|1): -1|1 {
  return transferContactSide(pointM,planeXM,pose,shape,side,{penetrationM:0,normal:[0,0,0]},scalpelContactConstants(shape));
}
type ContactResult = {penetrationM:number;normal:Vec3};
type ScalpelContactConstants={slope:number;norm:number;halfThicknessM:number;heightM:number;halfLengthM:number;endBevel:number;ex:number;ez:number};
function scalpelContactConstants(shape:ScalpelGeometry):ScalpelContactConstants{
  const slope=Math.tan(shape.halfAngleRadians),endBevel=shape.endBevelMm??0,endNorm=Math.hypot(endBevel,shape.halfThicknessMm);
  return{slope,norm:Math.hypot(1,slope),halfThicknessM:shape.halfThicknessMm*.001,heightM:shape.heightMm*.001,halfLengthM:shape.halfLengthMm*.001,endBevel,ex:endBevel/endNorm,ez:shape.halfThicknessMm/endNorm};
}
function evaluateScalpelContact(pointM:ArrayLike<number>,planeXM:number,pose:ScalpelPose,shape:ScalpelGeometry,side:-1|1,result:ContactResult,preserveSide=false,constants=scalpelContactConstants(shape)):ContactResult {
  const x = pointM[0]! - planeXM, y = pointM[1]! - pose.tipYMm * .001, z = pointM[2]! - pose.centerZMm * .001;
  const {slope,norm}=constants;
  let nearest=(side*x-slope*y)/norm,nx=side/norm,ny=-slope/norm,nz=0,gap;
  gap=(-side*x-slope*y)/norm;if(!preserveSide&&gap>nearest+1e-14){nearest=gap;nx=-side/norm;ny=-slope/norm;nz=0;}
  gap=side*x-constants.halfThicknessM;if(gap>nearest+1e-14){nearest=gap;nx=side;ny=0;nz=0;}
  gap=-side*x-constants.halfThicknessM;if(!preserveSide&&gap>nearest+1e-14){nearest=gap;nx=-side;ny=0;nz=0;}
  // Optional sharp longitudinal ends. Their half-width decreases continuously
  // to zero at |z|=L, instead of ploughing with a full-thickness vertical face.
  // These are the same half-spaces used by the visible convex blade mesh.
  const endBevel=constants.endBevel;
  if(endBevel>0){
    const {ex,ez}=constants,length=constants.halfLengthM;
    gap=side*x*ex+ez*(z-length);if(gap>nearest+1e-14){nearest=gap;nx=side*ex;ny=0;nz=ez;}
    gap=side*x*ex+ez*(-z-length);if(gap>nearest+1e-14){nearest=gap;nx=side*ex;ny=0;nz=-ez;}
    gap=-side*x*ex+ez*(z-length);if(!preserveSide&&gap>nearest+1e-14){nearest=gap;nx=-side*ex;ny=0;nz=ez;}
    gap=-side*x*ex+ez*(-z-length);if(!preserveSide&&gap>nearest+1e-14){nearest=gap;nx=-side*ex;ny=0;nz=-ez;}
  }
  gap=-y;if(preserveSide&&gap>nearest+1e-14){nearest=gap;nx=0;ny=-1;nz=0;}
  gap=y-constants.heightM;if(gap>nearest+1e-14){nearest=gap;nx=0;ny=1;nz=0;}
  gap=z-constants.halfLengthM;if(gap>nearest+1e-14){nearest=gap;nx=0;ny=0;nz=1;}
  gap=-z-constants.halfLengthM;if(gap>nearest+1e-14){nearest=gap;nx=0;ny=0;nz=-1;}
  result.penetrationM=pose.active?Math.max(0,-nearest):0;result.normal[0]=nx;result.normal[1]=ny;result.normal[2]=nz;
  return result;
}
function transferContactSide(pointM:ArrayLike<number>,planeXM:number,pose:ScalpelPose,shape:ScalpelGeometry,side:-1|1,result:ContactResult,constants:ScalpelContactConstants): -1|1 {
  if(side*(pointM[0]!-planeXM)>=-CUTTING_NUMERICS.contactSideTieM)return side;
  if(evaluateScalpelContact(pointM,planeXM,pose,shape,side,result,true,constants).penetrationM!==0)return side;
  if(evaluateScalpelContact(pointM,planeXM,pose,shape,side,result,false,constants).penetrationM!==0)return side;
  return side===1?-1:1;
}

/** Supported experiment: fixed cutting plane, finite blade contact and an
 * enclosing volumetric cage. Damage is driven by solved opening, never blade
 * height. The Mode-I law is extended isotropically to effective separation;
 * that mixed-mode assumption is not learned. Damage and deformation share an
 * incremental potential. SI dynamics; material history publishes atomically. */
export class LiverCuttingSolver {
  readonly positionsMm: Float64Array;
  readonly damage: Float64Array;
  readonly maximumOpeningM: Float64Array;
  readonly masses: Float64Array;
  readonly dtSeconds: number;
  readonly equilibriumModel: NonNullable<CuttingOptions["equilibriumModel"]>;
  private readonly reference: Float64Array;
  private readonly positions: Float64Array;
  private readonly velocities: Float64Array;
  private readonly inverseMass: Float64Array;
  private readonly cells: Cell[];
  private readonly volumeAdjacent: {cell:Cell;corner:number}[][];
  private readonly volumeCorrection: ReturnType<typeof createLogVolumeCorrection> | null;
  private readonly volumeEvaluation={energyDensity:0,firstDerivativePa:0,secondDerivativePa:0};
  private readonly volumeDeformation=new Float64Array(9);
  private readonly volumeCofactor=new Float64Array(9);
  private readonly volumeGradient=new Float64Array(3);
  private readonly continuum: TetContinuumMaterial;
  private readonly pairOfNode: Int32Array;
  private readonly sideOfNode: Int8Array;
  private readonly fixture: Set<number>;
  private readonly shape: ScalpelGeometry;
  private readonly contactConstants:ScalpelContactConstants;
  private readonly contactSurface: ContactSurfaceValidator | null;
  private readonly integratedContact: IntegratedContactAssembly | null;
  private readonly bulk: PhysicsParameters;
  private readonly trialContinuum: CuttingContinuumEvaluator;
  private readonly trialDeformation = new Float64Array(9);
  private readonly trialResponse: CuttingContinuumEvaluation = {energyDensity:0,jacobian:1,stress:new Float64Array(9)};
  private readonly initialPose: ScalpelPose;
  private acceptedPose: ScalpelPose;
  private targetPose: ScalpelPose;
  private trialPose: ScalpelPose;
  private readonly referenceVolume: number;
  private readonly cohesiveK: number;
  private readonly contactQuadrature: ContactQuadrature;
  private readonly contactSides: Int8Array;
  private readonly trialExternalGradient: Float64Array;
  private readonly trialContactPenetration: Float64Array;
  private readonly trialContactNormals: Float64Array;
  private readonly cohesiveAreas: Float64Array;
  private readonly seamToughnessAreas: Float64Array;
  private readonly contactPoint = new Float64Array(3);
  private readonly contactResult: ContactResult = {penetrationM:0,normal:[0,0,0]};
  private result: CuttingMetrics;
  private readonly contactStiffnessPaPerM = CUTTING_NUMERICS.contactPenaltyPaPerM;
  private readonly fixtureStiffnessNPerM = CUTTING_NUMERICS.fixtureStiffnessNPerM;
  private readonly capsuleRetractionPa: number;
  private readonly shearCouplingBeta: number;
  private readonly shearWeight: number;

  constructor(private readonly mesh: CuttingReference, private readonly options: CuttingOptions) {
    // Retained mechanical metadata must not alias a caller's mutable import.
    // Embedded surface evaluators separately snapshot their interpolation data.
    this.mesh={...mesh,positionsMm:mesh.positionsMm.slice(),tets:mesh.tets.slice(),seamPairs:mesh.seamPairs.map(pair=>({...pair})),fixedNodes:mesh.fixedNodes.slice()};
    this.options = { ...options, bulk: { ...options.bulk }, cohesive: { ...options.cohesive }, ...(options.scalpel ? { scalpel: { ...options.scalpel } } : {}) };
    this.capsuleRetractionPa = options.capsuleRetractionPa ?? 0;
    if (!Number.isFinite(this.capsuleRetractionPa) || this.capsuleRetractionPa < 0) throw new Error("Capsule retraction tension must be finite and nonnegative");
    this.shearCouplingBeta = options.shearCouplingBeta ?? 1;
    if (!Number.isFinite(this.shearCouplingBeta) || !(this.shearCouplingBeta > 0)) throw new Error("Shear coupling beta must be finite and positive");
    this.shearWeight = this.shearCouplingBeta === 1 ? 1 : this.shearCouplingBeta * this.shearCouplingBeta;
    this.dtSeconds = options.dtSeconds ?? CUTTING_NUMERICS.defaultDtSeconds;
    if (!Number.isFinite(this.dtSeconds) || this.dtSeconds <= 0 || this.dtSeconds > CUTTING_NUMERICS.maximumStepSeconds) throw new Error("Cutting step must be positive and at most 1/30 s");
    if (mesh.positionsMm.length % 3 || mesh.tets.length % 4 || !mesh.positionsMm.length || !mesh.seamPairs.length) throw new Error("Invalid cutting reference layout");
    if (!mesh.positionsMm.every(Number.isFinite)) throw new Error("Finite reference positions required");
    this.bulk = { ...options.bulk }; this.shape = options.scalpel ? { ...options.scalpel, endBevelMm: options.scalpel.endBevelMm ?? 0 } : { ...DEFAULT_SCALPEL };
    if (!Object.values(this.bulk).every(Number.isFinite) || this.bulk.young_pa <= 0 || this.bulk.poisson < 0 || this.bulk.poisson >= .5 || this.bulk.relaxation_fraction < 0 || this.bulk.relaxation_fraction >= 1 || this.bulk.relaxation_time_s <= 0 || this.bulk.density_kg_m3 <= 0) throw new Error("Invalid bulk mechanical parameters");
    this.trialContinuum = new CuttingContinuumEvaluator(this.bulk,this.dtSeconds);
    const equilibriumModel=options.equilibriumModel??CUTTING_NUMERICS.defaultEquilibriumModel;
    if(equilibriumModel!=="stable-neo-hookean"&&equilibriumModel!=="log-neo-hookean")throw new Error("Unknown cutting equilibrium material law");
    this.equilibriumModel=equilibriumModel;
    this.volumeCorrection=equilibriumModel==="log-neo-hookean"?createLogVolumeCorrection(this.bulk):null;
    if (!Number.isFinite(mesh.planeXMm) || !Number.isFinite(mesh.floorYMm)) throw new Error("Finite plane and floor required");
    if (![this.shape.halfThicknessMm, this.shape.halfLengthMm, this.shape.heightMm, this.shape.halfAngleRadians].every(v => Number.isFinite(v) && v > 0) || this.shape.halfAngleRadians >= Math.PI / 2) throw new Error("Invalid finite scalpel dimensions");
    const endBevel=this.shape.endBevelMm??0;
    if(!Number.isFinite(endBevel)||endBevel<0||endBevel>=this.shape.halfLengthMm||this.shape.halfThicknessMm/Math.tan(this.shape.halfAngleRadians)>=this.shape.heightMm)throw new Error("Invalid finite scalpel bevel dimensions");
    this.contactConstants=scalpelContactConstants(this.shape);
    this.contactSurface=mesh.cap?new ContactSurfaceValidator(mesh,this.shape):null;
    this.integratedContact=mesh.cap?new IntegratedContactAssembly(mesh,this.shape,this.contactStiffnessPaPerM):null;
    const zero = cohesiveResponse(0, 0, options.cohesive);
    this.cohesiveK = zero.tangentPaPerM;
    if (!(this.cohesiveK > 0) || !Number.isFinite(this.cohesiveK)) throw new Error("Invalid cohesive stiffness");
    this.reference = Float64Array.from(mesh.positionsMm, v => v * .001);
    this.positions = this.reference.slice(); this.positionsMm = Float64Array.from(mesh.positionsMm);
    this.velocities = new Float64Array(this.positions.length);
    this.masses = new Float64Array(this.positions.length / 3);
    this.cells = [];
    this.volumeAdjacent=Array.from({length:this.masses.length},()=>[]);
    for (let offset = 0; offset < mesh.tets.length; offset += 4) {
      const ids = mesh.tets.slice(offset, offset + 4);
      if (new Set(ids).size !== 4 || ids.some(id => !Number.isInteger(id) || id < 0 || id >= this.masses.length)) throw new Error("Invalid tetrahedron indices");
      const D = new Float64Array(9);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) D[3 * r + c] = this.reference[3 * ids[c + 1]! + r]! - this.reference[3 * ids[0]! + r]!;
      const det = determinant(D), volume = det / 6, cof = cofactor(D), gradients = new Float64Array(12);
      if (!(volume > 1e-18)) throw new Error("Positive finite tetrahedron volume required");
      for (let j = 1; j < 4; j++) for (let k = 0; k < 3; k++) { const value = cof[3 * k + j - 1]! / det; gradients[3 * j + k] = value; gradients[k]! -= value; }
      for (const id of ids) this.masses[id]! += volume * this.bulk.density_kg_m3 / 4;
      const cell={ ids, volume, gradients, state: emptyMaxwellState() };
      this.cells.push(cell);ids.forEach((id,corner)=>this.volumeAdjacent[id]!.push({cell,corner}));
    }
    if (this.masses.some(m => !(m > 0) || !Number.isFinite(m))) throw new Error("Every mechanical node requires positive mass");
    this.inverseMass = Float64Array.from(this.masses, m => 1 / m);
    this.referenceVolume = this.cells.reduce((sum, cell) => sum + cell.volume, 0);
    this.continuum = new TetContinuumMaterial(this.reference, this.cells);
    this.damage = new Float64Array(mesh.seamPairs.length); this.maximumOpeningM = new Float64Array(mesh.seamPairs.length);
    this.pairOfNode = new Int32Array(this.masses.length).fill(-1); this.sideOfNode = new Int8Array(this.masses.length);
    for (let i = 0; i < mesh.seamPairs.length; i++) {
      const pair = mesh.seamPairs[i]!;
      if (!(pair.areaM2 > 0) || !Number.isFinite(pair.areaM2) || pair.left === pair.right) throw new Error("Positive one-sided interface quadrature required");
      for (const [id, side] of [[pair.left, -1], [pair.right, 1]] as const) {
        if (!Number.isInteger(id) || id < 0 || id >= this.masses.length || this.pairOfNode[id] !== -1) throw new Error("Each interface node must have one pair");
        this.pairOfNode[id] = i; this.sideOfNode[id] = side;
      }
    }
    this.contactQuadrature=buildContactQuadrature(mesh,options.contactSpacingMm??CUTTING_NUMERICS.defaultContactSpacingMm);
    this.contactSides=Int8Array.from(this.contactQuadrature.samples,sample=>sample.side);
    this.trialExternalGradient=new Float64Array(this.positions.length);
    this.trialContactPenetration=new Float64Array(this.contactQuadrature.samples.length);
    this.trialContactNormals=new Float64Array(3*this.contactQuadrature.samples.length);
    this.cohesiveAreas=Float64Array.from(mesh.seamPairs,pair=>pair.areaM2);
    if(mesh.cap){
      const left=new Float64Array(mesh.seamPairs.length),right=new Float64Array(mesh.seamPairs.length);
      for(const sample of this.contactQuadrature.samples)sample.ids.forEach((id,j)=>{
        const pair=this.pairOfNode[id]!;
        if(pair<0)throw new Error("Source cap must interpolate paired interface nodes");
        (sample.side<0?left:right)[pair]!+=sample.areaM2*sample.weights[j]!;
      });
      for(let i=0;i<left.length;i++){
        if(Math.abs(left[i]!-right[i]!)>1e-8*this.contactQuadrature.oneSidedAreaM2)throw new Error("Source cohesive area differs between interface sides");
        // ∫source N_i dA: retain nodal lumping while removing phantom bonds in
        // the enclosure-only cross-section. Zero area outside the source is valid.
        this.cohesiveAreas[i]=.5*(left[i]!+right[i]!);
      }
    }
    if (options.seamToughnessMultipliers) {
      if (options.seamToughnessMultipliers.length !== mesh.seamPairs.length) throw new Error("Seam toughness multipliers must match seamPairs length");
      const multipliers = Float64Array.from(options.seamToughnessMultipliers);
      if (multipliers.some(m => !Number.isFinite(m) || !(m > 0))) throw new Error("Positive finite seam toughness multipliers required");
      this.seamToughnessAreas = Float64Array.from(this.cohesiveAreas, (area, i) => area * multipliers[i]!);
    } else {
      this.seamToughnessAreas = this.cohesiveAreas;
    }
    this.fixture = new Set(mesh.fixedNodes);
    if ([...this.fixture].some(id => !Number.isInteger(id) || id < 0 || id >= this.masses.length)) throw new Error("Invalid fixture nodes");
    let top = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (const pair of mesh.seamPairs) { top = Math.max(top, mesh.positionsMm[3 * pair.left + 1]!); zmin = Math.min(zmin, mesh.positionsMm[3 * pair.left + 2]!); zmax = Math.max(zmax, mesh.positionsMm[3 * pair.left + 2]!); }
    this.initialPose = { tipYMm: top + 2, centerZMm: (zmin + zmax) / 2, active: false };
    this.acceptedPose = { ...this.initialPose }; this.targetPose = { ...this.initialPose }; this.trialPose = { ...this.initialPose };
    this.result = this.initialMetrics();
  }

  private initialMetrics(): CuttingMetrics {
    return { timeSeconds: 0, acceptedSteps: 0, rejectedSteps: 0, lastStepSeconds: 0, lastStepSweeps: 0, lastGlobalIterations: 0, timeStepRetries: 0, minimumJacobian: 1, volumeRatio: 1,
      totalMassKg: this.masses.reduce((a, b) => a + b, 0), contactForceN: [0, 0, 0], toolWorkJ: 0,
      fractureDissipationJ: 0, damagedAreaM2: 0, separatedAreaM2: 0,
      seamAreaM2: this.mesh.seamPairs.reduce((sum, pair) => sum + pair.areaM2, 0), maximumOpeningMm: 0,
      cohesiveAreaM2: this.cohesiveAreas.reduce((sum,area)=>sum+area,0),
      maximumContactPenetrationMm: 0, maximumSurfacePenetrationMm: this.contactSurface ? 0 : null, fixtureEnergyJ: 0, stationarityResidualN: 0, lastError: "" };
  }
  metrics(): CuttingMetrics { return { ...this.result, contactForceN: [...this.result.contactForceN] }; }
  scalpelPose(): ScalpelPose { return { ...this.acceptedPose }; }
  setScalpelTarget(pose: ScalpelPose): void {
    if (![pose.tipYMm, pose.centerZMm].every(Number.isFinite) || typeof pose.active !== "boolean") throw new Error("Finite scalpel target required");
    this.targetPose = { ...pose };
  }
  reset(): void {
    this.positions.set(this.reference); this.positionsMm.set(this.mesh.positionsMm); this.velocities.fill(0);
    this.maximumOpeningM.fill(0); this.damage.fill(0); this.continuum.reset();
    for(const sample of this.contactQuadrature.samples)this.contactSides[sample.index]=sample.side;
    for (const cell of this.cells) cell.state = emptyMaxwellState();
    this.acceptedPose = { ...this.initialPose }; this.targetPose = { ...this.initialPose }; this.trialPose = { ...this.initialPose };
    this.result = this.initialMetrics();
  }

  private external(id: number, gradient?: Float64Array, hessian?: Float64Array, includeContact=true, includeVolumeCorrection=true): number {
    const offset = 3 * id, pairIndex = this.pairOfNode[id]!;
    let energy = 0;
    if(includeVolumeCorrection&&this.volumeCorrection)for(const {cell,corner} of this.volumeAdjacent[id]!){
      const F=this.deformation(cell,this.volumeDeformation),J=determinant(F);
      if(!(J>0))return Infinity;
      const response=this.volumeCorrection.evaluate(J,this.volumeEvaluation);
      energy+=cell.volume*response.energyDensity;
      if(gradient||hessian){
        cofactor(F,this.volumeCofactor);const g=this.volumeGradient;
        for(let axis=0;axis<3;axis++)g[axis]=this.volumeCofactor[3*axis]!*cell.gradients[3*corner]!+this.volumeCofactor[3*axis+1]!*cell.gradients[3*corner+1]!+this.volumeCofactor[3*axis+2]!*cell.gradients[3*corner+2]!;
        for(let r=0;r<3;r++){
          if(gradient)gradient[r]!+=cell.volume*response.firstDerivativePa*g[r]!;
          // J is affine in one node. Positive curvature adds the exact rank-one
          // term; negative correction curvature is omitted from the majorizer.
          if(hessian)for(let c=0;c<3;c++)hessian[3*r+c]!+=cell.volume*Math.max(0,response.secondDerivativePa)*g[r]!*g[c]!;
        }
      }
    }
    if (this.fixture.has(id)) for (let axis = 0; axis < 3; axis++) {
      const d = this.positions[offset + axis]! - this.reference[offset + axis]!;
      energy += .5 * this.fixtureStiffnessNPerM * d * d;
      if (gradient) gradient[axis]! += this.fixtureStiffnessNPerM * d;
      if (hessian) hessian[4 * axis]! += this.fixtureStiffnessNPerM;
    }
    if (pairIndex >= 0) {
    const pair = this.mesh.seamPairs[pairIndex]!, side = this.sideOfNode[id]! as -1 | 1;
    const cohesiveArea=this.seamToughnessAreas[pairIndex]!;
    const other = side < 0 ? pair.right : pair.left;
    // Mixed-mode effective-opening extension of the calibrated Mode-I law.
    // The incremental potential includes dissipation, so its derivative remains
    // traction during damage evolution. No history mutates during line search.
    const gapX = this.positions[3 * pair.right]! - this.positions[3 * pair.left]!, gapY = this.positions[3 * pair.right + 1]! - this.positions[3 * pair.left + 1]!, gapZ = this.positions[3 * pair.right + 2]! - this.positions[3 * pair.left + 2]!;
    const effectiveOpening = cohesiveEffectiveOpening(gapX, gapY, gapZ, this.shearCouplingBeta);
    const response = cohesiveResponse(effectiveOpening, this.maximumOpeningM[pairIndex]!, this.options.cohesive);
    const previous = cohesiveResponse(0, this.maximumOpeningM[pairIndex]!, this.options.cohesive);
    const retractForce = this.cohesiveAreas[pairIndex]! * this.damage[pairIndex]! * this.capsuleRetractionPa;
    energy += cohesiveArea * (response.storedEnergyJm2 + response.dissipatedEnergyJm2 - previous.dissipatedEnergyJm2) - retractForce * gapX;
    if (gapX < 0) energy += .5 * cohesiveArea * this.cohesiveK * gapX ** 2;
    if (gradient && retractForce !== 0) gradient[0]! -= side * retractForce;
    for (let axis = 0; axis < 3; axis++) {
      const d = this.positions[offset + axis]! - this.positions[3 * other + axis]!;
      const modeScale = axis === 0 ? (gapX < 0 ? 1 : 1 - response.damage) : this.shearWeight === 1 ? 1 - response.damage : (1 - response.damage) * this.shearWeight;
      const k = cohesiveArea * this.cohesiveK * modeScale;
      if (gradient) gradient[axis]! += k * d;
      // Secant stiffness majorizes the negative radial softening tangent;
      // exact energy backtracking decides whether the trial is acceptable.
      if (hessian) hessian[4 * axis]! += k;
    }
    }
    if(includeContact){
      if(this.integratedContact)energy+=this.integratedContact.evaluateNode(id,this.positions,this.trialPose,gradient,hessian);
      else {
    if(this.trialPose.active) for(const {sample,weight} of this.contactQuadrature.adjacent[id]!) {
      const contact=this.sampleContact(sample);
      if (contact.penetrationM > 0) {
        const k = sample.areaM2 * this.contactStiffnessPaPerM;
        energy += .5 * k * contact.penetrationM ** 2;
        for (let r = 0; r < 3; r++) {
          if (gradient) gradient[r]! -= weight * k * contact.penetrationM * contact.normal[r]!;
          if (hessian) for (let c = 0; c < 3; c++) hessian[3 * r + c]! += weight * weight * k * contact.normal[r]! * contact.normal[c]!;
        }
      }
    }
      }
    }
    return energy;
  }

  private sampleContact(sample:ContactSample):ContactResult {
    this.contactPoint.fill(0);
    for(let j=0;j<sample.ids.length;j++)for(let axis=0;axis<3;axis++)this.contactPoint[axis]!+=sample.weights[j]!*this.positions[3*sample.ids[j]!+axis]!;
    return evaluateScalpelContact(this.contactPoint,this.mesh.planeXMm*.001,this.trialPose,this.shape,this.integratedContact?sample.side:this.contactSides[sample.index] as -1|1,this.contactResult,!this.integratedContact,this.contactConstants);
  }

  private nextContactSides():Int8Array {
    if(this.integratedContact)return this.contactSides.slice();
    const next=this.contactSides.slice();
    for(const sample of this.contactQuadrature.samples){
      this.contactPoint.fill(0);
      for(let j=0;j<sample.ids.length;j++)for(let axis=0;axis<3;axis++)this.contactPoint[axis]!+=sample.weights[j]!*this.positions[3*sample.ids[j]!+axis]!;
      next[sample.index]=transferContactSide(this.contactPoint,this.mesh.planeXMm*.001,this.trialPose,this.shape,this.contactSides[sample.index] as -1|1,this.contactResult,this.contactConstants);
    }
    return next;
  }


  /** Global trial assembly visits each shared contact sample once. Contributions
   * retain the per-node fixture/pair/sample addition order of external(); the
   * original callback remains in the authoritative final gate and vertex solve. */
  private assembleTrialExternalGradient():void {
    const gradient=this.trialExternalGradient;gradient.fill(0);
    for(const id of this.fixture)for(let axis=0;axis<3;axis++){
      const index=3*id+axis;gradient[index]!+=this.fixtureStiffnessNPerM*(this.positions[index]!-this.reference[index]!);
    }
    for(let i=0;i<this.mesh.seamPairs.length;i++){
      const pair=this.mesh.seamPairs[i]!,gapX=this.positions[3*pair.right]!-this.positions[3*pair.left]!;
      const opening=cohesiveEffectiveOpening(gapX,this.positions[3*pair.right+1]!-this.positions[3*pair.left+1]!,this.positions[3*pair.right+2]!-this.positions[3*pair.left+2]!,this.shearCouplingBeta);
      const response=cohesiveResponse(opening,this.maximumOpeningM[i]!,this.options.cohesive);
      const retractForce=this.cohesiveAreas[i]!*this.damage[i]!*this.capsuleRetractionPa;
      if(retractForce!==0){gradient[3*pair.left]!+=retractForce;gradient[3*pair.right]!-=retractForce;}
      const toughnessArea=this.seamToughnessAreas[i]!;
      for(let axis=0;axis<3;axis++){
        const left=3*pair.left+axis,right=3*pair.right+axis;
        const modeScale=axis===0?(gapX<0?1:1-response.damage):this.shearWeight===1?1-response.damage:(1-response.damage)*this.shearWeight;
        const k=toughnessArea*this.cohesiveK*modeScale;
        gradient[left]!+=k*(this.positions[left]!-this.positions[right]!);
        gradient[right]!+=k*(this.positions[right]!-this.positions[left]!);
      }
    }
      if(!this.integratedContact){
    if(this.trialPose.active)for(let i=0;i<this.contactQuadrature.samples.length;i++){
      const sample=this.contactQuadrature.samples[i]!,contact=this.sampleContact(sample),k=sample.areaM2*this.contactStiffnessPaPerM;
      this.trialContactPenetration[i]=contact.penetrationM;
      for(let axis=0;axis<3;axis++)this.trialContactNormals[3*i+axis]=contact.normal[axis]!;
      if(contact.penetrationM>0)for(let j=0;j<sample.ids.length;j++)for(let axis=0;axis<3;axis++){
        gradient[3*sample.ids[j]!+axis]!-=sample.weights[j]!*k*contact.penetrationM*contact.normal[axis]!;
      }
    }
    }
  }

  private deformation(cell: Cell, F = new Float64Array(9)): Float64Array {
    F.fill(0);
    for (let j = 1; j < 4; j++) for (let r = 0; r < 3; r++) {
      const difference = this.positions[3 * cell.ids[j]! + r]! - this.positions[3 * cell.ids[0]! + r]!;
      for (let c = 0; c < 3; c++) F[3 * r + c]! += difference * cell.gradients[3 * j + c]!;
    }
    return F;
  }

  private evaluateCandidate(prediction: Float64Array, dtSeconds: number, includeHistory=true) {
  const residual = new Float64Array(this.positions.length), nextStates: MaxwellState[] = [];
  let minimumJacobian = Infinity, volume = 0, energy = 0;
  this.trialContinuum.setTimeStep(dtSeconds);
  for (const cell of this.cells) {
    const F=this.deformation(cell,this.trialDeformation);
    // Trial evaluations need no new material histories. The original evaluator
    // remains authoritative for the final residual gate and state publication.
    let response:CuttingContinuumEvaluation;
    if(includeHistory){const committed=continuumResponse(F,this.bulk,cell.state,dtSeconds);response=committed;nextStates.push(committed.state);}
    else{this.trialContinuum.evaluate(F,cell.state,this.trialResponse);response=this.trialResponse;}
    minimumJacobian = Math.min(minimumJacobian, response.jacobian); volume += cell.volume * response.jacobian;
    energy += cell.volume * response.energyDensity;
    if(this.volumeCorrection){
      if(!(response.jacobian>0))energy=Infinity;
      else{
        const correction=this.volumeCorrection.evaluate(response.jacobian,this.volumeEvaluation);
        energy+=cell.volume*correction.energyDensity;cofactor(F,this.volumeCofactor);
        for(let i=0;i<9;i++)response.stress[i]!+=correction.firstDerivativePa*this.volumeCofactor[i]!;
      }
    }
    for (let j = 0; j < 4; j++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) residual[3 * cell.ids[j]! + r]! += cell.volume * response.stress[3 * r + c]! * cell.gradients[3 * j + c]!;
  }
  let stationarityResidualN = 0, fixtureEnergyJ = 0, maximumContactPenetrationMm = 0;
  const contactForceN: Vec3 = [0, 0, 0];
  const integrated=this.integratedContact?.evaluateAll(this.positions,this.trialPose);
  if(!includeHistory)this.assembleTrialExternalGradient();
  for (let id = 0; id < this.masses.length; id++) {
    const g = includeHistory?new Float64Array(3):null;if(g)this.external(id,g,undefined,!this.integratedContact,false);
    for (let axis = 0; axis < 3; axis++) {
      const displacement=this.positions[3*id+axis]!-prediction[3*id+axis]!;
      residual[3 * id + axis]! += (g?g[axis]!:this.trialExternalGradient[3*id+axis]!)+(integrated?.gradient[3*id+axis]??0) + this.masses[id]! / dtSeconds ** 2 * displacement;
      energy += .5*this.masses[id]!/dtSeconds**2*displacement**2;
    }
    if (this.positions[3 * id + 1]! <= this.mesh.floorYMm * .001 + 1e-9) residual[3 * id + 1] = Math.min(0, residual[3 * id + 1]!);
    stationarityResidualN = Math.max(stationarityResidualN, Math.hypot(...residual.subarray(3 * id, 3 * id + 3)));
    if (this.fixture.has(id)) for (let axis = 0; axis < 3; axis++) fixtureEnergyJ += .5 * this.fixtureStiffnessNPerM * (this.positions[3 * id + axis]! - this.reference[3 * id + axis]!) ** 2;
  }
  if(integrated){
  // Point diagnostics remain informational; the whole-cap gate is authoritative.
  if(includeHistory&&this.trialPose.active) for(const sample of this.contactQuadrature.samples)
    maximumContactPenetrationMm=Math.max(maximumContactPenetrationMm,1000*this.sampleContact(sample).penetrationM);
  energy+=integrated.energyJ;
  for(let axis=0;axis<3;axis++)contactForceN[axis]=integrated.contactForceN[axis]!;
  }else{
  if(this.trialPose.active) for(let i=0;i<this.contactQuadrature.samples.length;i++) {
      const sample=this.contactQuadrature.samples[i]!;
      const contact = includeHistory?this.sampleContact(sample):this.contactResult;
      if(!includeHistory){contact.penetrationM=this.trialContactPenetration[i]!;for(let axis=0;axis<3;axis++)contact.normal[axis]=this.trialContactNormals[3*i+axis]!;}
      maximumContactPenetrationMm = Math.max(maximumContactPenetrationMm, contact.penetrationM * 1000);
      const magnitude = sample.areaM2 * this.contactStiffnessPaPerM * contact.penetrationM;
      energy += .5*magnitude*contact.penetrationM;
      for (let axis = 0; axis < 3; axis++) contactForceN[axis]! -= magnitude * contact.normal[axis]!;
  }
  }
  energy += fixtureEnergyJ;
  for(let i=0;i<this.mesh.seamPairs.length;i++){
    const pair=this.mesh.seamPairs[i]!,gapX=this.positions[3*pair.right]!-this.positions[3*pair.left]!;
    const opening=cohesiveEffectiveOpening(gapX,this.positions[3*pair.right+1]!-this.positions[3*pair.left+1]!,this.positions[3*pair.right+2]!-this.positions[3*pair.left+2]!,this.shearCouplingBeta);
    const response=cohesiveResponse(opening,this.maximumOpeningM[i]!,this.options.cohesive),previous=cohesiveResponse(0,this.maximumOpeningM[i]!,this.options.cohesive);
    const retractForce=this.cohesiveAreas[i]!*this.damage[i]!*this.capsuleRetractionPa;
    energy+=this.seamToughnessAreas[i]!*(response.storedEnergyJm2+response.dissipatedEnergyJm2-previous.dissipatedEnergyJm2+.5*this.cohesiveK*Math.min(0,gapX)**2)-retractForce*gapX;
  }
    return { nextStates, minimumJacobian, volume, stationarityResidualN, fixtureEnergyJ, maximumContactPenetrationMm, contactForceN,energy,gradient:residual };
  }

  private preconditioner(dt:number) {
    const diagonal=Float64Array.from(this.positions,(_,i)=>this.masses[Math.floor(i/3)]!/dt**2);
    const terms:RankOneTerm[]=[];
    for(let i=0;i<this.mesh.seamPairs.length;i++){
      const pair=this.mesh.seamPairs[i]!,gapX=this.positions[3*pair.right]!-this.positions[3*pair.left]!;
      const opening=cohesiveEffectiveOpening(gapX,this.positions[3*pair.right+1]!-this.positions[3*pair.left+1]!,this.positions[3*pair.right+2]!-this.positions[3*pair.left+2]!,this.shearCouplingBeta);
      const response=cohesiveResponse(opening,this.maximumOpeningM[i]!,this.options.cohesive);
      const toughnessArea=this.seamToughnessAreas[i]!;
      for(let axis=0;axis<3;axis++){
        const modeScale=axis===0?(gapX<0?1:1-response.damage):this.shearWeight===1?1-response.damage:(1-response.damage)*this.shearWeight;
        terms.push({indices:[3*pair.left+axis,3*pair.right+axis],coefficients:new Float64Array([1,-1]),stiffness:toughnessArea*this.cohesiveK*modeScale});
      }
    }
    for(const id of this.fixture)for(let axis=0;axis<3;axis++)diagonal[3*id+axis]!+=this.fixtureStiffnessNPerM;
    if(this.integratedContact)terms.push(...this.integratedContact.evaluateAll(this.positions,this.trialPose,true).gramTerms);
    else {
    if(this.trialPose.active)for(const sample of this.contactQuadrature.samples){
      const contact=this.sampleContact(sample);if(contact.penetrationM<=0)continue;
      const indices:number[]=[],coefficients:number[]=[];
      sample.ids.forEach((id,j)=>{for(let axis=0;axis<3;axis++)if(contact.normal[axis]!==0){indices.push(3*id+axis);coefficients.push(sample.weights[j]!*contact.normal[axis]!);}});
      terms.push({indices,coefficients:Float64Array.from(coefficients),stiffness:sample.areaM2*this.contactStiffnessPaPerM});
    }
    }
    return sparseBlockPreconditioner(diagonal, continuumBlocks(this.positions, this.cells, this.bulk, dt, this.equilibriumModel), terms);
  }

  step(dtSeconds = this.dtSeconds): boolean {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || dtSeconds > CUTTING_NUMERICS.maximumStepSeconds) throw new Error("Invalid cutting timestep");
    const previousPose = this.acceptedPose, previousMetrics = this.result;
    const dy = this.targetPose.tipYMm - previousPose.tipYMm, dz = this.targetPose.centerZMm - previousPose.centerZMm;
    const length = Math.hypot(dy, dz), fraction = length > 0 ? Math.min(1, CUTTING_NUMERICS.maximumToolSpeedMmS * dtSeconds / length) : 1;
    // A nominal request is a maximum time advance. Retry the same uncommitted
    // initial-value problem at a shorter duration when contact cannot converge.
    // Tool travel scales by exactly the same fraction, preserving requested
    // speed; failed candidates publish neither deformation nor material history.
    for (let retry = 0; retry <= CUTTING_NUMERICS.maximumStepRetries; retry++) {
      const scale = 2 ** -retry, h = dtSeconds * scale;
      this.result = previousMetrics;
      const trialPose = { tipYMm: previousPose.tipYMm + fraction * dy * scale,
        centerZMm: previousPose.centerZMm + fraction * dz * scale, active: this.targetPose.active };
      if (this.attemptStep(h, trialPose)) {
        this.result = { ...this.result, timeStepRetries: previousMetrics.timeStepRetries + retry };
        return true;
      }
      const error = this.result.lastError;
      if (retry === CUTTING_NUMERICS.maximumStepRetries || !/^(Mechanical residual|Tetrahedron inversion guard|Blade contact penetration|Blade surface penetration)/.test(error)) {
        this.result = { ...previousMetrics, rejectedSteps: previousMetrics.rejectedSteps + 1,
          timeStepRetries: previousMetrics.timeStepRetries + retry, lastError: error };
        return false;
      }
    }
    return false;
  }

  private attemptStep(dtSeconds: number, trialPose: ScalpelPose): boolean {
    const old = this.positions.slice(), previousPose = this.acceptedPose;
    this.trialPose = trialPose;
    const prediction = old.slice();
    for (let id = 0; id < this.masses.length; id++) for (let axis = 0; axis < 3; axis++) prediction[3 * id + axis]! += dtSeconds * this.velocities[3 * id + axis]! + (axis === 1 && this.options.gravity !== false ? -9.81 * dtSeconds ** 2 : 0);
    try {
      this.continuum.beginStep(this.bulk, dtSeconds, prediction);
      const iterations = this.options.iterations ?? CUTTING_NUMERICS.maximumVertexSweeps;
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > CUTTING_NUMERICS.maximumVertexSweeps) throw new Error("Cutting solver requires 1–128 sweeps");
      let completedSweeps = 0, globalIterations = 0;
      for (let sweep = 0; sweep < iterations; sweep++) {
        this.continuum.solveVertices(this.positions, this.inverseMass, this.mesh.floorYMm * .001, (id, g, h) => this.external(id, g, h));
        completedSweeps++;
        if (!this.positions.every(Number.isFinite)) throw new Error("Nonfinite tissue state");
        // Small updates alone can indicate stagnation at a contact feature.
        // Every exit therefore requires the independently assembled residual.
        if ((sweep + 1) % 8 === 0 || (sweep >= 3 && this.continuum.diagnostics().lastSweepDisplacement < 2e-8)) {
          let residual = this.evaluateCandidate(prediction, dtSeconds, false).stationarityResidualN;
          if(sweep===CUTTING_NUMERICS.globalStartSweep-1&&residual>=CUTTING_NUMERICS.vertexTargetResidualN){
            const preconditioner=this.preconditioner(dtSeconds);
            globalIterations+=minimizeIncremental(this.positions,()=>this.evaluateCandidate(prediction,dtSeconds,false),preconditioner.diagonal,this.mesh.floorYMm*.001,CUTTING_NUMERICS.maximumGlobalIterations,preconditioner.applyInverse);
            residual=this.evaluateCandidate(prediction,dtSeconds,false).stationarityResidualN;
          }
          if (residual < CUTTING_NUMERICS.vertexTargetResidualN || (sweep >= CUTTING_NUMERICS.lateVertexSweep-1 && residual < CUTTING_NUMERICS.lateVertexTargetResidualN)) break;
        }
      }
      if (!this.positions.every(Number.isFinite)) throw new Error("Nonfinite tissue state");
      const { nextStates, minimumJacobian, volume, stationarityResidualN, fixtureEnergyJ, maximumContactPenetrationMm, contactForceN } = this.evaluateCandidate(prediction, dtSeconds, true);
      if (!(minimumJacobian > CUTTING_NUMERICS.minimumAcceptedJacobian) || !Number.isFinite(volume)) throw new Error("Tetrahedron inversion guard");
      if (!Number.isFinite(stationarityResidualN) || stationarityResidualN > CUTTING_NUMERICS.maximumNodalResidualN) throw new Error(`Mechanical residual ${stationarityResidualN.toPrecision(3)} N exceeds ${CUTTING_NUMERICS.maximumNodalResidualN} N gate`);
      // A converged penalty equilibrium can still interpenetrate substantially.
      // Require overlap below10% of the declared half thickness (0.06mm for the
      // default blade). This is a numerical quality tolerance, not tissue data.
      const penetrationLimitMm=CUTTING_NUMERICS.maximumPenetrationHalfThicknessFraction*this.shape.halfThicknessMm;
      if(maximumContactPenetrationMm>penetrationLimitMm)throw new Error(`Blade contact penetration ${maximumContactPenetrationMm.toPrecision(3)} mm exceeds ${penetrationLimitMm.toPrecision(3)} mm gate`);
      // Point quadrature can miss an affine face crossing the blade between
      // samples. Validate every source-cap triangle before publishing history.
      // This bounds the accepted state, not the swept path between time steps.
      const maximumSurfacePenetrationMm=this.contactSurface?.evaluate(this.positions,this.trialPose).upperMm??null;
      if(maximumSurfacePenetrationMm!==null&&(!Number.isFinite(maximumSurfacePenetrationMm)||maximumSurfacePenetrationMm>penetrationLimitMm))throw new Error(`Blade surface penetration ${maximumSurfacePenetrationMm.toPrecision(3)} mm exceeds ${penetrationLimitMm.toPrecision(3)} mm gate`);
      const nextOpening = this.maximumOpeningM.slice(), nextDamage = this.damage.slice();
      let fractureDissipationJ = 0, damagedAreaM2 = 0, separatedAreaM2 = 0, maximumOpeningMm = 0;
      for (let i = 0; i < this.mesh.seamPairs.length; i++) {
        const pair = this.mesh.seamPairs[i]!, opening = this.positions[3 * pair.right]! - this.positions[3 * pair.left]!;
        const effectiveOpening = cohesiveEffectiveOpening(opening, this.positions[3 * pair.right + 1]! - this.positions[3 * pair.left + 1]!, this.positions[3 * pair.right + 2]! - this.positions[3 * pair.left + 2]!, this.shearCouplingBeta);
        const response = cohesiveResponse(effectiveOpening, nextOpening[i]!, this.options.cohesive);
        nextOpening[i] = response.maximumOpeningM; nextDamage[i] = response.damage;
        const cohesiveArea=this.cohesiveAreas[i]!;
        fractureDissipationJ += this.seamToughnessAreas[i]! * response.dissipatedEnergyJm2;
        maximumOpeningMm = Math.max(maximumOpeningMm, opening * 1000);
        if (response.damage > 0) damagedAreaM2 += cohesiveArea;
        if (response.damage >= 1 - 1e-10) separatedAreaM2 += cohesiveArea;
      }
      if (![fractureDissipationJ, damagedAreaM2, separatedAreaM2, maximumOpeningMm].every(Number.isFinite)) throw new Error("Invalid cohesive candidate");
      // Side transfer is evaluated only after all gates. Old/new contact energy
      // and force are zero wherever a side changes; trials and retries retain
      // the same accepted contact-side history throughout their optimization.
      const nextContactSides=this.nextContactSides();
      const increment = -.5 * ((this.result.contactForceN[1] + contactForceN[1]) * (this.trialPose.tipYMm - previousPose.tipYMm) + (this.result.contactForceN[2] + contactForceN[2]) * (this.trialPose.centerZMm - previousPose.centerZMm)) * .001;
      // All validation precedes mutation of history, velocity and accepted time.
      this.continuum.commit(this.positions);
      this.cells.forEach((cell, i) => { cell.state = nextStates[i]!; });
      for (let i = 0; i < this.positions.length; i++) { this.velocities[i] = (this.positions[i]! - old[i]!) / dtSeconds; this.positionsMm[i] = this.positions[i]! * 1000; }
      this.maximumOpeningM.set(nextOpening); this.damage.set(nextDamage); this.acceptedPose = { ...this.trialPose };
      this.contactSides.set(nextContactSides);
      this.result = { ...this.result, timeSeconds: this.result.timeSeconds + dtSeconds, acceptedSteps: this.result.acceptedSteps + 1,
        lastStepSeconds: dtSeconds, lastStepSweeps: completedSweeps, lastGlobalIterations: globalIterations,
        minimumJacobian, volumeRatio: volume / this.referenceVolume, contactForceN, toolWorkJ: this.result.toolWorkJ + increment,
        fractureDissipationJ,
        damagedAreaM2, separatedAreaM2, maximumOpeningMm, maximumContactPenetrationMm, maximumSurfacePenetrationMm,
        fixtureEnergyJ, stationarityResidualN, lastError: "" };
      return true;
    } catch (error) {
      this.positions.set(old); this.trialPose = { ...previousPose };
      this.result = { ...this.result, rejectedSteps: this.result.rejectedSteps + 1, lastError: error instanceof Error ? error.message : String(error) };
      return false;
    }
  }
}
