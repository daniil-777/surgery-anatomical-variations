import type { LiverCutGeometry, LiverDrainageEvent, LiverFilmSnapshot, LiverSurface } from "./types";
import type { VesselLandingEvent, VesselVector } from "../experiments/vesselSolver";
import type { LiverAttachmentFootprint } from "./sourceFootprint";

export interface LiverSurfaceFlowConfig {
  fixedDtSeconds: number;
  densityKgM3: number;
  viscosityPaS: number;
  surfaceTensionNM: number;
  gravityMS2: VesselVector;
  /** Explicit reduced-model guard, not a physiological blood-film limit. */
  maximumDepthM: number;
  maxSubsteps: number;
  /** Reject flow into missing source-mesh support instead of treating scan
   * boundaries as impermeable anatomy or as a fabricated organ outlet. */
  rejectOpenBoundaryContact: boolean;
  /** Legacy explicit drainage boundary, or an experimental retained hanging
   * film with signed hydrostatic energy. Retain does not predict pinch-off,
   * contact angles, adhesion or curved-substrate capillary pressure. */
  undersideBoundary: "drain" | "retain";
  /** Blood viscosity law: classical Newtonian or Carreau-Yasuda shear-thinning
   * whole-blood rheology (Cho & Kensey 1991). Defaults to "newtonian". */
  rheologyModel: "newtonian" | "carreau-yasuda";
  /** Low-shear (rouleaux-aggregated) dynamic viscosity mu_0 in Pa*s. */
  zeroShearViscosityPaS: number;
  /** Carreau-Yasuda relaxation time lambda in seconds. */
  relaxationTimeS: number;
  /** Carreau-Yasuda power-law index n (dimensionless, 0 < n <= 1). */
  powerLawIndex: number;
  /** Carreau-Yasuda transition exponent a (dimensionless, a > 0). */
  yasudaExponent: number;
  /** Contact-line hysteresis / capillary pinning thickness threshold in metres. */
  wettingPinningDepthM: number;
  /** Include substrate mean-curvature capillary pressure sigma * (div_S n). */
  includeSubstrateCurvature: boolean;
  /** Subgrid rivulet mobility factor (>= 0.1). Compensates for coarse-mesh area dilution of narrow rivulets. Defaults to 1. */
  mobilityScale: number;
}
export interface LiverFilmTelemetry {
  acceptedSubsteps: number;
  attachmentSubsteps: number;
  activeVertices: number;
  clippedNegativeConductances: number;
  viscousEnergyLossJ: number;
  impactKineticEnergyRemovedJ: number;
  cutRedistributedVolumeM3: number;
  undersideDrainedVolumeM3: number;
  maximumFilmReynolds: number;
  /** Largest algebraic edge estimate during the latest accepted fixed step. */
  stepMaximumFilmReynolds: number;
  maximumDepthEdgeRatio: number;
  sourceBoundaryVertices: number;
  sourceBoundaryContactVolumeM3: number;
}
interface Edge { a: number; b: number; w: number; lengthM: number; }
interface EventBatch { ids: number[]; previous: EventBatch | null; }
interface FilmState {
  volume: Float64Array; wet: Set<number>; timeSeconds: number; stepIndex: number;
  input: number; escaped: number; history: EventBatch | null; telemetry: LiverFilmTelemetry;
  drainageEvents: LiverDrainageEvent[]; nextDrainageId: number;
}
declare const surfaceCheckpoint: unique symbol;
export interface LiverSurfaceCheckpoint { readonly [surfaceCheckpoint]: true; }
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: VesselVector, b: VesselVector): VesselVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: VesselVector, b: VesselVector): VesselVector =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3 = (p: ArrayLike<number>, i: number): VesselVector => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
const blankTelemetry = (): LiverFilmTelemetry => ({ acceptedSubsteps: 0, activeVertices: 0,
  attachmentSubsteps: 0,
  clippedNegativeConductances: 0, viscousEnergyLossJ: 0, impactKineticEnergyRemovedJ: 0,
  cutRedistributedVolumeM3: 0, undersideDrainedVolumeM3: 0, maximumFilmReynolds: 0, stepMaximumFilmReynolds: 0, maximumDepthEdgeRatio: 0,
  sourceBoundaryVertices: 0, sourceBoundaryContactVolumeM3: 0 });

/** Identity mapping for an intact canonical surface. */
export function intactLiverFilmGeometry(surface: LiverSurface): LiverCutGeometry {
  const positions: number[] = [], normals: number[] = [], triangles: number[] = [], barycentric: number[] = [];
  for (let t = 0; t < surface.indices.length / 3; t++) for (let j = 0; j < 3; j++) {
    const i = surface.indices[3 * t + j]!;
    positions.push(...v3(surface.positionsM, i)); normals.push(...v3(surface.normals, i));
    triangles.push(t); barycentric.push(j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0);
  }
  return { surface: { positionsM: Float64Array.from(positions), normals: Float32Array.from(normals),
    indices: Uint32Array.from({ length: triangles.length }, (_, i) => i) },
    cavity: { positionsM: new Float64Array(), normals: new Float32Array(), indices: new Uint32Array() },
    sourceTriangles: Uint32Array.from(triangles), sourceBarycentrics: Float64Array.from(barycentric), removedAreaM2: 0 };
}

/** Conservative creeping-film approximation on barycentric dual control cells.
 *
 * V_i=A_i h_i. Across an edge, q_ij=w_ij h_upwind³/(3μ_eff) (p_i−p_j).
 * p is the derivative of discrete gravitational/hydrostatic/capillary energy.
 * Every internal transfer is equal and opposite. Positive cotangent weights
 * are used; negative weights are clipped and reported, not called exact FEM.
 * Optional Carreau-Yasuda shear-thinning rheology, contact-line pinning depth,
 * and discrete substrate mean-curvature Laplace pressure preserve exact energy
 * descent.
 */
export class LiverSurfaceFlow {
  readonly config: Readonly<LiverSurfaceFlowConfig>;
  private readonly positions: Float64Array;
  private readonly normals: Float64Array;
  private readonly indices: Uint32Array;
  private readonly normalGravity: Float64Array;
  private readonly potential: Float64Array;
  private readonly substrateCurvature: Float64Array;
  private readonly originalTriangleArea: Float64Array;
  private readonly baseEdges: { a: number; b: number; contributions: [number, number][]; lengthM: number }[];
  private readonly edgeAdjacency: number[][];
  private areas: Float64Array;
  private edges: Edge[] = [];
  private state: FilmState;
  private acceptedEventIds = new Set<number>();
  private readonly edgeMarks: Uint32Array;
  private edgeEpoch = 0;
  private readonly vertexMarks: Uint32Array;
  private vertexEpoch = 0;
  private readonly pressureScratch: Float64Array;
  private readonly outgoingScratch: Float64Array;
  private readonly deltaScratch: Float64Array;
  private readonly rateScratch: Float64Array;
  private readonly sourceBoundary: Set<number>;
  private drainageEligibility: Uint8Array | undefined;
  private drainageEligibilityVersion = 0;
  private cachedEffectiveOutlets: number | undefined;
  private readonly checkpoints = new WeakMap<LiverSurfaceCheckpoint, { state: FilmState; areas: Float64Array; edges: Edge[];
    drainageEligibility: Uint8Array | undefined; drainageEligibilityVersion: number }>();

  constructor(surface: LiverSurface, config: Partial<LiverSurfaceFlowConfig> = {}) {
    this.config = Object.freeze({ fixedDtSeconds: .002, densityKgM3: 1060, viscosityPaS: .00345,
      surfaceTensionNM: .055, gravityMS2: [0, -9.81, 0] as VesselVector,
      maximumDepthM: .005, maxSubsteps: 128, rejectOpenBoundaryContact: false, undersideBoundary: "drain",
      rheologyModel: "newtonian", zeroShearViscosityPaS: .056, relaxationTimeS: 3.313,
      powerLawIndex: .3568, yasudaExponent: 2, wettingPinningDepthM: 0, includeSubstrateCurvature: false,
      mobilityScale: 1, ...config });
    const c = this.config;
    if (![c.fixedDtSeconds, c.densityKgM3, c.viscosityPaS, c.surfaceTensionNM, c.maximumDepthM,
      c.zeroShearViscosityPaS, c.relaxationTimeS, c.powerLawIndex, c.yasudaExponent, c.wettingPinningDepthM, c.mobilityScale, ...c.gravityMS2].every(Number.isFinite)
      || c.fixedDtSeconds < .0001 || c.fixedDtSeconds > .01 || c.viscosityPaS < .001 || c.viscosityPaS > .1
      || c.densityKgM3 < 500 || c.densityKgM3 > 2000 || c.surfaceTensionNM < 0 || c.surfaceTensionNM > .2
      || c.maximumDepthM <= 0 || c.maximumDepthM > .02 || !Number.isInteger(c.maxSubsteps) || c.maxSubsteps < 1 || c.maxSubsteps > 512
      || c.undersideBoundary !== "drain" && c.undersideBoundary !== "retain"
      || c.rheologyModel !== "newtonian" && c.rheologyModel !== "carreau-yasuda"
      || c.zeroShearViscosityPaS < c.viscosityPaS || c.zeroShearViscosityPaS > 1
      || c.relaxationTimeS < 0 || c.relaxationTimeS > 60 || c.powerLawIndex <= 0 || c.powerLawIndex > 1
      || c.yasudaExponent <= 0 || c.yasudaExponent > 10 || c.wettingPinningDepthM < 0 || c.wettingPinningDepthM >= c.maximumDepthM
      || c.mobilityScale < .1 || c.mobilityScale > 50)
      throw new RangeError("Invalid liver film parameters");
    const count = surface.positionsM.length / 3, triangles = surface.indices.length / 3;
    if (!Number.isInteger(count) || count < 3 || count > 100000 || !Number.isInteger(triangles) || triangles < 1
      || surface.normals.length !== surface.positionsM.length || !surface.positionsM.every(Number.isFinite))
      throw new RangeError("Invalid metre-scale liver mesh");
    this.positions = surface.positionsM.slice(); this.normals = new Float64Array(surface.normals.length); this.indices = surface.indices.slice();
    this.areas = new Float64Array(count); this.originalTriangleArea = new Float64Array(triangles);
    this.normalGravity = new Float64Array(count); this.potential = new Float64Array(count);
    this.substrateCurvature = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const n = v3(surface.normals, i), size = Math.hypot(...n);
      if (!Number.isFinite(size) || size < .5) throw new RangeError("Surface normals must be finite and oriented");
      for (let k = 0; k < 3; k++) this.normals[3 * i + k] = n[k]! / size;
      this.normalGravity[i] = -dot(c.gravityMS2, n) / size;
      this.potential[i] = -c.densityKgM3 * dot(c.gravityMS2, v3(this.positions, i));
    }
    const graph = new Map<string, { a: number; b: number; contributions: [number, number][]; lengthM: number }>();
    for (let t = 0; t < triangles; t++) {
      const ids = Array.from(this.indices.subarray(3 * t, 3 * t + 3));
      if (ids.some(i => i >= count) || new Set(ids).size !== 3) throw new RangeError("Invalid surface triangle index");
      const a = v3(this.positions, ids[0]!), b = v3(this.positions, ids[1]!), d = v3(this.positions, ids[2]!);
      const twiceArea = Math.hypot(...cross(sub(b, a), sub(d, a)));
      if (!(twiceArea > 1e-16)) throw new RangeError("Degenerate surface triangle");
      this.originalTriangleArea[t] = twiceArea / 2;
      for (const i of ids) this.areas[i] = this.areas[i]! + twiceArea / 6;
      for (let k = 0; k < 3; k++) {
        const u = ids[k]!, v = ids[(k + 1) % 3]!, opposite = ids[(k + 2) % 3]!;
        const lo = Math.min(u, v), hi = Math.max(u, v), key = `${lo}:${hi}`;
        const U = v3(this.positions, u), V = v3(this.positions, v), O = v3(this.positions, opposite);
        const edge = graph.get(key) ?? { a: lo, b: hi, contributions: [], lengthM: Math.hypot(...sub(U, V)) };
        edge.contributions.push([t, .5 * dot(sub(U, O), sub(V, O)) / twiceArea]); graph.set(key, edge);
      }
    }
    this.baseEdges = [...graph.values()];
    for (const e of this.baseEdges) {
      const w = Math.max(0, e.contributions.reduce((s, [, weight]) => s + weight, 0));
      if (!(w > 0)) continue;
      const dx = sub(v3(this.positions, e.a), v3(this.positions, e.b));
      const dn = sub(v3(this.normals, e.a), v3(this.normals, e.b));
      const term = .5 * w * dot(dn, dx);
      this.substrateCurvature[e.a] = this.substrateCurvature[e.a]! + term;
      this.substrateCurvature[e.b] = this.substrateCurvature[e.b]! + term;
    }
    let minPotential = Infinity;
    for (let i = 0; i < count; i++) {
      this.substrateCurvature[i] = this.areas[i]! > 0 ? this.substrateCurvature[i]! / this.areas[i]! : 0;
      if (c.includeSubstrateCurvature) {
        this.potential[i] = this.potential[i]! + c.surfaceTensionNM * this.substrateCurvature[i]!;
      }
      minPotential = Math.min(minPotential, this.potential[i]!);
    }
    for (let i = 0; i < count; i++) this.potential[i] = this.potential[i]! - minPotential;
    this.sourceBoundary = new Set(this.baseEdges.filter(e => e.contributions.length === 1).flatMap(e => [e.a, e.b]));
    this.edgeMarks = new Uint32Array(this.baseEdges.length); this.vertexMarks = new Uint32Array(count);
    this.pressureScratch = new Float64Array(count); this.outgoingScratch = new Float64Array(count);
    this.deltaScratch = new Float64Array(count); this.rateScratch = new Float64Array(this.baseEdges.length);
    this.edgeAdjacency = Array.from({ length: count }, () => []);
    this.baseEdges.forEach((e, i) => { this.edgeAdjacency[e.a]!.push(i); this.edgeAdjacency[e.b]!.push(i); });
    this.state = { volume: new Float64Array(count), wet: new Set(), timeSeconds: 0, stepIndex: 0,
      input: 0, escaped: 0, history: null, telemetry: blankTelemetry(), drainageEvents: [], nextDrainageId: 0 };
    this.state.telemetry.sourceBoundaryVertices = this.sourceBoundary.size;
    this.updateEdges(Float64Array.from(this.originalTriangleArea, () => 1));
  }

  private updateEdges(fractions: Float64Array) {
    let clipped = 0;
    this.edges = this.baseEdges.map(e => {
      const w = e.contributions.reduce((s, [t, weight]) => s + fractions[t]! * weight, 0);
      if (w < -1e-12) clipped++;
      return { a: e.a, b: e.b, w: Math.max(0, w), lengthM: e.lengthM };
    });
    this.state.telemetry.clippedNegativeConductances = clipped;
  }
  private clone(s: FilmState): FilmState { return { ...s, volume: s.volume.slice(), wet: new Set(s.wet),
    telemetry: { ...s.telemetry }, drainageEvents: s.drainageEvents.map(e => ({ ...e, positionM: [...e.positionM], normal: [...e.normal] })) }; }
  checkpoint(): LiverSurfaceCheckpoint {
    const key = Object.freeze({}) as LiverSurfaceCheckpoint;
    this.checkpoints.set(key, { state: this.clone(this.state), areas: this.areas, edges: this.edges,
      drainageEligibility: this.drainageEligibility, drainageEligibilityVersion: this.drainageEligibilityVersion }); return key;
  }
  restore(key: LiverSurfaceCheckpoint): void {
    const saved = this.checkpoints.get(key); if (!saved) throw new Error("Film checkpoint belongs to another experiment");
    const { state } = saved;
    this.state = this.clone(state); this.areas = saved.areas; this.edges = saved.edges;
    this.drainageEligibility = saved.drainageEligibility; this.drainageEligibilityVersion = saved.drainageEligibilityVersion;
    this.cachedEffectiveOutlets = undefined;
    this.acceptedEventIds = new Set();
    for (let node = state.history; node; node = node.previous) for (const id of node.ids) this.acceptedEventIds.add(id);
  }
  /** Install the authored transfer boundary before stepping, with the same
   * canonical support as retained geometry. Ineligible underside locations
   * retain signed hydrostatic transport. A setter never removes blood: newly
   * admitted inventory transfers only during the next accepted timed step.
   * The caller checkpoints this together with its cut/runoff apparatus.
   */
  setDrainageEligibility(mask: Uint8Array | undefined): void {
    if (mask !== undefined && (!(mask instanceof Uint8Array) || mask.length !== this.areas.length
      || mask.some(value => value !== 0 && value !== 1)))
      throw new RangeError("Drainage eligibility requires a binary canonical vertex mask");
    const previous = this.drainageEligibility;
    if (mask === undefined && previous === undefined || mask !== undefined && previous !== undefined
      && mask.every((value, i) => value === previous[i])) return;
    if (!Number.isSafeInteger(this.drainageEligibilityVersion + 1))
      throw new Error("Drainage boundary version capacity exceeded");
    this.drainageEligibility = mask?.slice(); this.drainageEligibilityVersion++;
    this.cachedEffectiveOutlets = undefined;
  }

  /** Called only on a new cut, not every step. Keeps the same physical blood
   * inventory. Volume whose basis support disappears is displaced to the
   * nearest surviving graph neighbour; tissue cutting momentum is unresolved. */
  setRetainedGeometry(cut: LiverCutGeometry): void {
    const count = this.areas.length, areas = new Float64Array(count), retained = new Float64Array(this.originalTriangleArea.length);
    const mesh = cut.surface, mapping = cut.sourceTriangles, bary = cut.sourceBarycentrics;
    if (mapping.length !== mesh.positionsM.length / 3 || bary.length !== mesh.positionsM.length)
      throw new RangeError("Retained geometry requires canonical barycentric mappings");
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const ids = [mesh.indices[k]!, mesh.indices[k + 1]!, mesh.indices[k + 2]!], t = mapping[ids[0]!]!;
      if (t >= retained.length || ids.some(i => mapping[i] !== t)) throw new RangeError("Invalid retained source triangle");
      const a = v3(mesh.positionsM, ids[0]!), b = v3(mesh.positionsM, ids[1]!), d = v3(mesh.positionsM, ids[2]!);
      const area = Math.hypot(...cross(sub(b, a), sub(d, a))) / 2;
      if (!(area > 0) || !Number.isFinite(area)) throw new RangeError("Invalid retained triangle area");
      retained[t] = retained[t]! + area;
      for (const i of ids) {
        const weights = v3(bary, i);
        if (weights.some(x => !Number.isFinite(x) || x < -1e-8 || x > 1 + 1e-8)
          || Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 1e-7) throw new RangeError("Invalid retained barycentric weights");
        for (let j = 0; j < 3; j++) areas[this.indices[3 * t + j]!] = areas[this.indices[3 * t + j]!]! + area * Math.max(0, weights[j]!) / 3;
      }
    }
    const candidate = this.clone(this.state);
    for (const i of candidate.wet) if (areas[i]! < 1e-16 && candidate.volume[i]! > 0) {
      const seen = new Set([i]), queue = [i]; let recipient = -1;
      for (let q = 0; q < queue.length && recipient < 0; q++) for (const edge of this.edgeAdjacency[queue[q]!]!) {
        const e = this.baseEdges[edge]!, j = e.a === queue[q] ? e.b : e.a;
        if (seen.has(j)) continue;
        if (areas[j]! >= 1e-16) { recipient = j; break; }
        seen.add(j); queue.push(j);
      }
      if (recipient < 0) throw new Error("Cut removed all receiving support for existing blood");
      candidate.volume[recipient] = candidate.volume[recipient]! + candidate.volume[i]!;
      candidate.telemetry.cutRedistributedVolumeM3 += candidate.volume[i]!;
      candidate.volume[i] = 0; candidate.wet.delete(i); candidate.wet.add(recipient);
    }
    for (const i of candidate.wet) if (candidate.volume[i]! / areas[i]! > this.config.maximumDepthM)
      throw new Error("Cut would exceed the resolved thin-film depth; no geometry or inventory changed");
    this.areas = areas; this.state = candidate;
    this.cachedEffectiveOutlets = undefined;
    this.updateEdges(Float64Array.from(retained, (a, i) => Math.min(1, a / this.originalTriangleArea[i]!)));
  }

  private activeEdges(wet: Set<number>): number[] {
    if (++this.edgeEpoch >= 0xffffffff) { this.edgeMarks.fill(0); this.edgeEpoch = 1; }
    const ids: number[] = [];
    for (const i of wet) for (const e of this.edgeAdjacency[i]!)
      if (this.edges[e]!.w > 0 && this.edgeMarks[e] !== this.edgeEpoch) {
        this.edgeMarks[e] = this.edgeEpoch; ids.push(e);
      }
    return ids;
  }
  private energy(volume: Float64Array, wet: Set<number>, edges: number[]): number {
    let energy = 0;
    for (const i of wet) {
      const v = volume[i]!, h = v / this.areas[i]!;
      energy += this.potential[i]! * v + .5 * this.config.densityKgM3 * this.hydrostaticGravity(i) * h * v;
    }
    for (const k of edges) {
      const e = this.edges[k]!, ha = this.areas[e.a]! > 0 ? volume[e.a]! / this.areas[e.a]! : 0;
      const hb = this.areas[e.b]! > 0 ? volume[e.b]! / this.areas[e.b]! : 0;
      energy += .5 * this.config.surfaceTensionNM * e.w * (ha - hb) ** 2;
    }
    return energy;
  }
  /** With outward n, g_n=-g·n is negative under a horizontal ceiling.
   * Retaining its sign yields the hanging-film long-wave dispersion
   * ω=h0³ k²(ρ|g|−σk²)/(3μ), not immediate deletion of underside inventory.
   * This is the planar lubrication limit, not a detachment/contact-line law.
   * Lin & Kondic, Physics of Fluids22,052105(2010), Eq.(1):
   * https://arxiv.org/abs/0912.3306
   */
  private hydrostaticGravity(i: number): number {
    const value = this.normalGravity[i]!;
    return this.config.undersideBoundary === "retain" || this.drainageEligibility !== undefined && this.drainageEligibility[i] === 0
      ? value : Math.max(0, value);
  }
  private drains(i: number): boolean {
    return this.config.undersideBoundary === "drain" && this.normalGravity[i]! < -1e-8
      && (this.drainageEligibility === undefined || this.drainageEligibility[i] === 1);
  }
  private effectiveViscosityPaS(hM: number, absDeltaP: number, lengthM: number): number {
    const c = this.config;
    if (c.rheologyModel === "newtonian") return c.viscosityPaS;
    const muInf = c.viscosityPaS, mu0 = c.zeroShearViscosityPaS;
    const tauWall = .5 * hM * absDeltaP / Math.max(1e-9, lengthM);
    const evalCY = (gammaDot: number) =>
      muInf + (mu0 - muInf) * Math.pow(1 + Math.pow(c.relaxationTimeS * Math.max(0, gammaDot), c.yasudaExponent),
        (c.powerLawIndex - 1) / c.yasudaExponent);
    const mu1 = evalCY(tauWall / mu0);
    return evalCY(tauWall / Math.max(muInf, mu1));
  }
  private drain(s: FilmState, i: number, volumeM3: number, startTimeSeconds: number, endTimeSeconds: number) {
    if (!(volumeM3 > 0)) return;
    if (s.drainageEvents.length >= 65536 || !Number.isSafeInteger(s.nextDrainageId))
      throw new Error("Liver drainage transfer capacity exceeded; timestep rolled back");
    s.escaped += volumeM3; s.telemetry.undersideDrainedVolumeM3 += volumeM3;
    s.drainageEvents.push({ id: s.nextDrainageId++, stepIndex: s.stepIndex + 1, sourceVertex: i,
      startTimeSeconds, endTimeSeconds, volumeM3, positionM: [...v3(this.positions, i)], normal: [...v3(this.normals, i)] });
  }
  private advance(s: FilmState, duration: number, startTimeSeconds: number): void {
    const c = this.config; let remaining = duration;
    while (remaining > Math.max(1e-15, duration * 1e-12) && s.wet.size) {
      if (++s.telemetry.acceptedSubsteps > c.maxSubsteps) throw new Error("Liver film stability budget exceeded; timestep rolled back");
      const edgeIds = this.activeEdges(s.wet), involved: number[] = [];
      if (++this.vertexEpoch >= 0xffffffff) { this.vertexMarks.fill(0); this.vertexEpoch = 1; }
      const addVertex = (i: number) => {
        if (this.vertexMarks[i] !== this.vertexEpoch) { this.vertexMarks[i] = this.vertexEpoch; involved.push(i); }
      };
      for (const i of s.wet) addVertex(i);
      for (const k of edgeIds) { const e = this.edges[k]!; addVertex(e.a); addVertex(e.b); }
      const pressure = this.pressureScratch, outgoing = this.outgoingScratch;
      for (const i of involved) {
        pressure[i] = this.potential[i]! + c.densityKgM3 * this.hydrostaticGravity(i)
          * (this.areas[i]! > 0 ? s.volume[i]! / this.areas[i]! : 0);
        outgoing[i] = 0;
      }
      for (const k of edgeIds) {
        const e = this.edges[k]!;
        if (this.areas[e.a]! <= 0 || this.areas[e.b]! <= 0) continue;
        const difference = s.volume[e.a]! / this.areas[e.a]! - s.volume[e.b]! / this.areas[e.b]!;
        pressure[e.a] = pressure[e.a]! + c.surfaceTensionNM * e.w * difference / this.areas[e.a]!;
        pressure[e.b] = pressure[e.b]! - c.surfaceTensionNM * e.w * difference / this.areas[e.b]!;
      }
      const fluxes: number[] = [];
      let step = remaining;
      for (const k of edgeIds) {
        const e = this.edges[k]!;
        if (this.areas[e.a]! <= 0 || this.areas[e.b]! <= 0) continue;
        const delta = pressure[e.a]! - pressure[e.b]!, from = delta >= 0 ? e.a : e.b;
        const h = s.volume[from]! / this.areas[from]!;
        const hMobile = h - c.wettingPinningDepthM;
        if (hMobile <= 0) continue;
        const muEff = this.effectiveViscosityPaS(hMobile, Math.abs(delta), e.lengthM) / c.mobilityScale;
        const rate = e.w * hMobile ** 3 * Math.abs(delta) / (3 * muEff);
        if (!Number.isFinite(rate)) throw new Error("Nonfinite liver film flux");
        if (rate === 0) continue;
        fluxes.push(k); this.rateScratch[k] = delta >= 0 ? rate : -rate;
        outgoing[from] = outgoing[from]! + rate;
        const speed = hMobile * hMobile * Math.abs(delta) / (3 * muEff * e.lengthM);
        const reynolds = c.densityKgM3 * speed * h / muEff;
        s.telemetry.maximumFilmReynolds = Math.max(s.telemetry.maximumFilmReynolds, reynolds);
        s.telemetry.stepMaximumFilmReynolds = Math.max(s.telemetry.stepMaximumFilmReynolds, reynolds);
        s.telemetry.maximumDepthEdgeRatio = Math.max(s.telemetry.maximumDepthEdgeRatio, h / e.lengthM);
      }
      if (!fluxes.length) break;
      for (const i of involved) if (outgoing[i]! > 0) step = Math.min(step, .2 * s.volume[i]! / outgoing[i]!);
      if (!(step > 0) || !Number.isFinite(step)) throw new Error("Liver film timestep lost progress");
      const energyBefore = this.energy(s.volume, s.wet, edgeIds);
      let accepted = false;
      for (let retry = 0; retry < 24; retry++, step *= .5) {
        const changes = this.deltaScratch;
        for (const i of involved) changes[i] = 0;
        for (const k of fluxes) {
          const e = this.edges[k]!, v = this.rateScratch[k]! * step;
          changes[e.a] = changes[e.a]! - v; changes[e.b] = changes[e.b]! + v;
        }
        const wet = new Set<number>();
        for (const i of involved) { s.volume[i] = s.volume[i]! + changes[i]!; if (s.volume[i]! > 0) wet.add(i); }
        const afterEdges = this.activeEdges(wet), energyAfter = this.energy(s.volume, wet, afterEdges);
        if (Number.isFinite(energyAfter) && energyAfter <= energyBefore + Math.max(1e-24, Math.abs(energyBefore) * 1e-12)) {
          for (const i of wet) if (s.volume[i]! <= 0) wet.delete(i);
          s.wet = wet; s.telemetry.viscousEnergyLossJ += Math.max(0, energyBefore - energyAfter);
          remaining -= step; accepted = true; break;
        }
        for (const i of involved) s.volume[i] = s.volume[i]! - changes[i]!;
      }
      if (!accepted) throw new Error("Liver film energy descent failed; timestep rolled back");
      // This first model has no tissue adhesion law. Outward-gravity support is
      // an explicit drainage boundary, with volume retained in escaped ledger.
      for (const i of s.wet) if (this.drains(i)) {
        const end = startTimeSeconds + duration - remaining;
        // This explicit Euler flux is constant across its accepted substep.
        // Preserve that interval instead of releasing one artificial drop per packet.
        this.drain(s, i, s.volume[i]!, end - step, end);
        s.volume[i] = 0; s.wet.delete(i);
      }
    }
  }
  private deposit(s: FilmState, weights: readonly { i: number; w: number }[], volumeM3: number,
    startTimeSeconds: number, endTimeSeconds = startTimeSeconds): void {
    let deposited = 0;
    weights.forEach(({ i, w }, j) => {
      const volume = j === weights.length - 1 ? volumeM3 - deposited : volumeM3 * w;
      deposited += volume;
      if (this.drains(i)) {
        this.drain(s, i, volume, startTimeSeconds, endTimeSeconds);
      } else { s.volume[i] = s.volume[i]! + volume; s.wet.add(i); }
    });
  }
  /** Constant attachment flux integrated over its actual emission interval.
   * The source is split around the existing energy-descending transport step.
   * Source substeps limit added depth to 5% of the physical aperture radius;
   * this is an accuracy tolerance, not a height clamp or a wider footprint.
   * Existing positivity, depth, volume and total-substep rejection gates apply.
   */
  private advanceWithSources(s: FilmState, duration: number, startTimeSeconds: number,
    sources: readonly { weights: { i: number; w: number }[]; volumeRateM3S: number; energyRateW: number; radiusM: number }[]): void {
    if (!sources.length) { this.advance(s, duration, startTimeSeconds); return; }
    const rates = new Map<number, number>();
    let radius = Infinity;
    for (const source of sources) {
      radius = Math.min(radius, source.radiusM);
      for (const { i, w } of source.weights) if (!this.drains(i))
        rates.set(i, (rates.get(i) ?? 0) + source.volumeRateM3S * w);
    }
    let maximumDepthRateMS = 0;
    for (const [i, rate] of rates) maximumDepthRateMS = Math.max(maximumDepthRateMS, rate / this.areas[i]!);
    const maximumSourceStep = maximumDepthRateMS > 0 ? .05 * radius / maximumDepthRateMS : duration;
    let remaining = duration;
    const add = (dt: number, start: number) => {
      for (const source of sources) {
        const volume = source.volumeRateM3S * dt;
        this.deposit(s, source.weights, volume, start, start + dt);
        s.input += volume; s.telemetry.impactKineticEnergyRemovedJ += source.energyRateW * dt;
      }
    };
    while (remaining > Math.max(1e-15, duration * 1e-12)) {
      if (++s.telemetry.attachmentSubsteps > this.config.maxSubsteps)
        throw new Error("Liver attachment integration budget exceeded; timestep rolled back");
      const dt = Math.min(remaining, maximumSourceStep);
      if (!(dt > 0) || !Number.isFinite(dt)) throw new Error("Liver source integration lost progress");
      const start = startTimeSeconds + duration - remaining;
      add(dt / 2, start); this.advance(s, dt, start); add(dt / 2, start + dt / 2); remaining -= dt;
    }
  }
  private retainedReturnWeights(seeds: readonly { i: number; w: number }[], volumeM3: number, supportRadiusM: number): { i: number; w: number }[] {
    const targetDepth = .06 * this.config.maximumDepthM;
    const targetArea = Math.max(Math.PI * supportRadiusM * supportRadiusM, volumeM3 / Math.max(1e-9, targetDepth));
    if (seeds.every(({ i, w }) => !this.drains(i) && !this.sourceBoundary.has(i) && this.areas[i]! >= 1e-16
      && volumeM3 * w / this.areas[i]! <= targetDepth)) return [...seeds];
    const seen = new Set<number>(), queue: number[] = [], patch: number[] = [];
    let areaSum = 0;
    for (const { i } of [...seeds].sort((a, b) => a.i - b.i)) if (!seen.has(i)) { seen.add(i); queue.push(i); }
    for (let q = 0; q < queue.length && (areaSum < targetArea || patch.length < 8); q++) {
      const u = queue[q]!;
      if (this.areas[u]! >= 1e-16 && !this.drains(u) && !this.sourceBoundary.has(u)) {
        patch.push(u); areaSum += this.areas[u]!;
      }
      for (const edge of this.edgeAdjacency[u]!) {
        const e = this.baseEdges[edge]!, v = e.a === u ? e.b : e.a;
        if (!seen.has(v) && this.areas[v]! >= 1e-16) { seen.add(v); queue.push(v); }
      }
    }
    if (!(areaSum > 0) || !patch.length) return [...seeds];
    return patch.map(i => ({ i, w: this.areas[i]! / areaSum }));
  }
  step(events: readonly VesselLandingEvent[] = [],
    attachmentFootprints: ReadonlyMap<string, LiverAttachmentFootprint> = new Map()): LiverFilmSnapshot {
    const before = this.state, candidate = this.clone(before), end = (before.stepIndex + 1) * this.config.fixedDtSeconds;
    candidate.drainageEvents = [];
    candidate.telemetry.acceptedSubsteps = 0; candidate.telemetry.attachmentSubsteps = 0; candidate.telemetry.stepMaximumFilmReynolds = 0;
    // A newly accepted cut/apparatus may admit a previously retained wet
    // location. Account that transfer at the current boundary, even if a
    // uniform film has no internal flux. Rollback restores its original owner.
    for (const i of candidate.wet) if (this.drains(i)) {
      this.drain(candidate, i, candidate.volume[i]!, before.timeSeconds, before.timeSeconds);
      candidate.volume[i] = 0; candidate.wet.delete(i);
    }
    const seen = new Set<number>();
    const prepared: { event: VesselLandingEvent; time: number; start: number; end: number;
      weights: { i: number; w: number }[]; energyJ: number; radiusM: number }[] = [];
    const boundaries = new Set([before.timeSeconds, end]);
    for (const event of events) {
      if (!Number.isSafeInteger(event.id) || seen.has(event.id) || this.acceptedEventIds.has(event.id) || !Number.isFinite(event.volumeM3) || event.volumeM3 <= 0
        || !Number.isFinite(event.timeSeconds) || event.timeSeconds < before.timeSeconds - 1e-12 || event.timeSeconds > end + 1e-12
        || !event.velocityMS.every(Number.isFinite))
        throw new RangeError("Invalid or duplicate liver impact");
      seen.add(event.id);
      const time = Math.max(before.timeSeconds, Math.min(end, event.timeSeconds));
      let weights: { i: number; w: number }[] = [], sourceStart = time, sourceEnd = time, radiusM = 0;
      if (event.surface) {
        const { triangle, barycentric } = event.surface;
        if (!Number.isInteger(triangle) || triangle < 0 || triangle >= this.originalTriangleArea.length
          || barycentric.some(v => !Number.isFinite(v) || v < -1e-10) || Math.abs(barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-8)
          throw new RangeError("Invalid liver impact coordinates");
        const ids = Array.from(this.indices.subarray(3 * triangle, 3 * triangle + 3));
        const values = ids.map((i, j) => this.areas[i]! > 0 ? Math.max(0, barycentric[j]!) : 0);
        const total = values.reduce((a, b) => a + b, 0);
        if (!(total > 0)) throw new Error("Impact has no retained surface support");
        weights = ids.map((i, j) => ({ i, w: values[j]! / total })).filter(v => v.w > 0);
        if (event.holeId === "runoff") {
          weights = this.retainedReturnWeights(weights, event.volumeM3, event.supportRadiusM ?? 0);
        }
      }
      if (event.sourceAttachment) {
        const source = event.sourceAttachment, footprint = attachmentFootprints.get(event.holeId);
        if (!event.surface || !footprint || ![source.startTimeSeconds, source.endTimeSeconds, source.radiusM].every(Number.isFinite)
          || source.startTimeSeconds < before.timeSeconds - 1e-12 || source.endTimeSeconds > end + 1e-12
          || source.endTimeSeconds <= source.startTimeSeconds
          || Math.abs(time - (source.startTimeSeconds + source.endTimeSeconds) / 2) > 1e-12
          || Math.abs(footprint.radiusM - source.radiusM) > 1e-12
          || footprint.indices.length !== footprint.weights.length || footprint.indices.length < 1 || footprint.indices.length > 2048)
          throw new RangeError("Invalid finite-duration liver attachment source");
        weights = Array.from(footprint.indices, (i, j) => ({ i, w: footprint.weights[j]! }));
        if (weights.some(({ i, w }) => i >= this.areas.length || !(this.areas[i]! > 0) || !Number.isFinite(w) || w < 0)
          || Math.abs(weights.reduce((sum, p) => sum + p.w, 0) - 1) > 1e-10)
          throw new RangeError("Attachment footprint has invalid retained support");
        sourceStart = Math.max(before.timeSeconds, source.startTimeSeconds);
        sourceEnd = Math.min(end, source.endTimeSeconds); radiusM = source.radiusM;
        boundaries.add(sourceStart); boundaries.add(sourceEnd);
      } else boundaries.add(time);
      prepared.push({ event, time, start: sourceStart, end: sourceEnd, weights, radiusM,
        energyJ: .5 * this.config.densityKgM3 * event.volumeM3 * dot(event.velocityMS, event.velocityMS) });
    }
    const timeline = [...boundaries].sort((a, b) => a - b);
    for (let j = 0; j < timeline.length; j++) {
      const clock = timeline[j]!;
      for (const p of prepared) if (p.start === p.end && p.time === clock) {
        candidate.input += p.event.volumeM3; candidate.telemetry.impactKineticEnergyRemovedJ += p.energyJ;
        if (!p.event.surface) candidate.escaped += p.event.volumeM3;
        else this.deposit(candidate, p.weights, p.event.volumeM3, clock, p.event.holeId === "runoff" ? end : clock);
      }
      if (j + 1 >= timeline.length) break;
      const next = timeline[j + 1]!, midpoint = (clock + next) / 2;
      const active = prepared.filter(p => p.end > p.start && p.start <= midpoint && p.end >= midpoint)
        .map(p => ({ weights: p.weights, volumeRateM3S: p.event.volumeM3 / (p.end - p.start),
          energyRateW: p.energyJ / (p.end - p.start), radiusM: p.radiusM }));
      this.advanceWithSources(candidate, next - clock, clock, active);
    }
    let total = 0, boundaryContactVolume = 0;
    const hasBoundary = this.sourceBoundary.size > 0;
    for (const i of candidate.wet) {
      const v = candidate.volume[i]!;
      if (!Number.isFinite(v) || v < 0 || v / this.areas[i]! > this.config.maximumDepthM)
        throw new Error("Resolved liver film depth exceeded; whole step rolled back");
      total += v;
      if (hasBoundary && this.sourceBoundary.has(i)) boundaryContactVolume += v;
    }
    candidate.telemetry.sourceBoundaryContactVolumeM3 = boundaryContactVolume;
    if (this.config.rejectOpenBoundaryContact
      && candidate.telemetry.sourceBoundaryContactVolumeM3 > Math.max(1e-15, candidate.input * 1e-8))
      throw new Error("Blood reached an open boundary of the source liver mesh; physical continuation is unresolved. Step rolled back.");
    if (Math.abs(total + candidate.escaped - candidate.input) > Math.max(1e-19, candidate.input * 1e-10))
      throw new Error("Liver surface inventory invariant failed");
    candidate.timeSeconds = end; candidate.stepIndex++; candidate.telemetry.activeVertices = candidate.wet.size;
    if (seen.size) { candidate.history = { ids: [...seen], previous: candidate.history }; for (const id of seen) this.acceptedEventIds.add(id); }
    this.state = candidate; return this.snapshot();
  }
  /** Read-only accepted heights for a private collision adapter. */
  depthAtVertex(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.areas.length) throw new RangeError("Invalid liver film vertex");
    return this.areas[i]! > 0 ? this.state.volume[i]! / this.areas[i]! : 0;
  }
  /** Captures the immutable accepted arrays, so later candidate commits cannot
   * alter collision against the previous accepted surface. No full copy. */
  acceptedDepthSampler(): (i: number) => number {
    const volume = this.state.volume, areas = this.areas;
    return i => {
      if (!Number.isInteger(i) || i < 0 || i >= areas.length) throw new RangeError("Invalid liver film vertex");
      return areas[i]! > 0 ? volume[i]! / areas[i]! : 0;
    };
  }
  /** Read-only complete nonzero support for sparse accepted-state diagnostics. */
  activeVertexIndices(): IterableIterator<number> { return this.state.wet.values(); }
  diagnostics(): LiverFilmTelemetry & { drainageBoundary: {
    eligibilityMaskEnabled: boolean; version: number; effectiveOutletVertices: number;
    model: "legacy-outward-gravity-drain" | "authored-pinning-outlets-with-retained-remainder" | "retained-hanging-film";
  } } {
    if (this.cachedEffectiveOutlets === undefined) {
      let outlets = 0;
      for (let i = 0; i < this.areas.length; i++) if (this.areas[i]! > 0 && this.drains(i)) outlets++;
      this.cachedEffectiveOutlets = outlets;
    }
    return { ...this.state.telemetry, drainageBoundary: { eligibilityMaskEnabled: this.drainageEligibility !== undefined,
      version: this.drainageEligibilityVersion, effectiveOutletVertices: this.cachedEffectiveOutlets,
      model: this.config.undersideBoundary === "retain" ? "retained-hanging-film"
        : this.drainageEligibility === undefined ? "legacy-outward-gravity-drain" : "authored-pinning-outlets-with-retained-remainder" } };
  }
  snapshot(): LiverFilmSnapshot {
    const depthM = new Float64Array(this.areas.length); let maxDepthM = 0, filmVolumeM3 = 0;
    for (const i of this.state.wet) {
      const v = this.state.volume[i]!, h = v / this.areas[i]!;
      depthM[i] = h; filmVolumeM3 += v; maxDepthM = Math.max(maxDepthM, h);
    }
    return { timeSeconds: this.state.timeSeconds, depthM, vertexAreaM2: this.areas.slice(),
      inputVolumeM3: this.state.input, filmVolumeM3, escapedVolumeM3: this.state.escaped,
      volumeErrorM3: filmVolumeM3 + this.state.escaped - this.state.input, maxDepthM,
      drainageEvents: this.state.drainageEvents.map(e => ({ ...e, positionM: [...e.positionM], normal: [...e.normal] })) };
  }
}
