import type { PhysicsParameters } from "./atlasPhysics";
import { closestTrianglePoint } from "./liverProbeGeometry";
import { applyFloorFriction, estimateFloorNormalReaction } from "./liverFloorFriction";
import { TetContinuumMaterial } from "./liverContinuumMaterial";

/** Interactive finite-strain continuum with objective Green-Maxwell memory,
 * solved by four vertex-block-descent sweeps at 120 Hz. The legacy option keeps
 * the earlier edge/volume XPBD model for comparison. Fixed iteration dynamics,
 * room damping and finite-iteration augmented contact are approximations, not
 * calibrated surgery. Closest-triangle contact has no full continuous collision
 * detection; reported initialization and motion limits protect interior probes.
 * All internal distances are metres, masses kg, time seconds. */
export interface PlaygroundMesh {
  reference_positions_mm: number[];
  tets: number[];
  surface_indices: number[];
  embedding?: { tet_indices: number[]; weights: number[] };
}
export interface PlaygroundOptions { floorYmm?: number; gravity?: boolean; iterations?: number; materialModel?: "legacy" | "continuum"; contactModel?: "penalty" | "augmented"; floorFrictionModel?: "legacy" | "reaction"; contactGeometry?: "quadrature" | "triangles" }
export interface PlaygroundInteractionState {
  readonly probe: { readonly centerMm: readonly [number, number, number]; readonly radiusMm: number; readonly targetMm: readonly [number, number, number] } | null;
  readonly grab: { readonly handleMm: readonly [number, number, number]; readonly targetMm: readonly [number, number, number]; readonly attachmentMm: readonly [number, number, number] } | null;
}
export interface PlaygroundMetrics {
  material_model: "legacy" | "continuum";
  contact_model: "penalty" | "augmented"; contact_geometry: "quadrature" | "triangles"; maximum_probe_surface_penetration_mm: number;
  probe_center_inside: boolean; probe_inside_initializations: number; probe_initial_inside_overlap_mm: number; probe_initialization_adjustment_mm: number; probe_motion_clamped_steps: number; probe_containment_limits: number;
  floor_friction_model: "legacy" | "reaction"; floor_normal_reaction_n: number; floor_friction_dissipated_j: number;
  probe_reaction_n: [number, number, number]; probe_normal_force_n: number; probe_work_j: number;
  probe_active_samples: number; probe_complementarity_n_mm: number; probe_max_active_gap_mm: number;
  probe_activation_count: number; probe_removal_count: number; contact_augmented_updates: number;
  fixed_step_s: number; nonlinear_iterations: number; continuum_volume_limits: number; line_search_backtracks: number; rejected_vertex_updates: number; final_sweep_max_displacement_mm: number;
  simulation_time_s: number; volume_change_pct: number; minimum_jacobian: number;
  floor_penetration_mm: number; maximum_speed_m_s: number; rejected_steps: number;
  limited_steps: number; dropped_time_s: number; rejected_time_s: number; last_step_ms: number; mean_step_ms: number;
  node_count: number; tet_count: number; finite_state: boolean;
  center_of_mass_mm: [number, number, number]; maximum_probe_penetration_mm: number;
  minimum_volume_projections: number;
}
type Vec = [number, number, number];
type Edge = { a: number; b: number; rest: number; share: number; previous: number; memory: number; lambda: number; restStep: number; alpha: number };
type Tet = { ids: [number, number, number, number]; volume: number; lambda: number };
type Anchor = { ids: number[]; weights: number[]; offset: Vec; strength: number; lambda: Vec };
type Grab = { target: Vec; current: Vec; anchors: Anchor[] };
type ProbeFace = { ids: [number, number, number]; weights: Float64Array; lambda: Float64Array; area: number; supportGap: number };
const STEP = 1 / 240;
const vector = (v: readonly number[], scale = 1): Vec => {
  if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error("Expected a finite 3D vector");
  return [v[0]! * scale, v[1]! * scale, v[2]! * scale];
};
const point = (x: Float64Array, i: number): Vec => [x[3 * i]!, x[3 * i + 1]!, x[3 * i + 2]!];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec) => Math.hypot(...a);
function tetVolume(x: Float64Array, ids: readonly number[]) {
  const o = point(x, ids[0]!);
  return dot(sub(point(x, ids[1]!), o), cross(sub(point(x, ids[2]!), o), sub(point(x, ids[3]!), o))) / 6;
}

export class LiverPlaygroundSolver {
  readonly referenceMm: Float32Array;
  readonly positionsMm: Float32Array;
  readonly positions: Float64Array;
  readonly velocities: Float64Array;
  readonly masses: Float64Array;
  readonly inverseMass: Float64Array;
  readonly floorYmm: number;
  readonly materialModel: "legacy" | "continuum";
  readonly fixedStepS: number;
  readonly contactModel: "penalty" | "augmented";
  readonly floorFrictionModel: "legacy" | "reaction";
  readonly contactGeometry: "quadrature" | "triangles";
  private readonly continuum: TetContinuumMaterial;
  private readonly reference: Float64Array;
  private readonly tets: Tet[] = [];
  private readonly edges: Edge[] = [];
  private readonly faces: number[];
  private readonly iterations: number;
  private parameters: PhysicsParameters;
  private gravity: boolean;
  private accumulator = 0;
  private simulationTime = 0;
  private droppedTime = 0;
  private rejected = 0;
  private rejectedTime = 0;
  private limited = 0;
  private lastStepMs = 0;
  private totalStepMs = 0;
  private attempted = 0;
  private grab: Grab | null = null;
  private probe: { target: Vec; current: Vec; radius: number; faces: ProbeFace[] } | null = null;
  private maxProbePenetration = 0; private surfaceProbePenetration = 0;
  private probeCenterInside = false; private probeInsideInitializations = 0; private probeInitialInsideOverlap = 0; private probeInitializationAdjustment = 0; private probeMotionClamped = 0; private probeContainmentLimits = 0;
  private floorReaction = 0; private floorFrictionDissipated = 0;
  private probeReaction: Vec = [0, 0, 0];
  private probeNormalForce = 0; private probeWork = 0; private probeActiveSamples = 0;
  private probeComplementarity = 0; private probeMaximumActiveGap = 0;
  private probeActivations = 0; private probeRemovals = 0; private contactUpdates = 0;
  private restVolume = 0;
  private minimumVolumeProjections = 0;

  constructor(mesh: PlaygroundMesh, parameters: PhysicsParameters, options: PlaygroundOptions = {}) {
    if (!mesh.reference_positions_mm.length || mesh.reference_positions_mm.length % 3 || !mesh.reference_positions_mm.every(Number.isFinite) || mesh.reference_positions_mm.length > 30000 || !mesh.tets.length || mesh.tets.length % 4 || mesh.surface_indices.length % 3) throw new Error("Invalid liver cage");
    this.referenceMm = Float32Array.from(mesh.reference_positions_mm);
    this.reference = Float64Array.from(mesh.reference_positions_mm, v => v * .001);
    this.positions = this.reference.slice();
    this.positionsMm = new Float32Array(this.reference.length);
    this.velocities = new Float64Array(this.reference.length);
    this.masses = new Float64Array(this.reference.length / 3);
    this.inverseMass = new Float64Array(this.masses.length);
    this.floorYmm = options.floorYmm ?? -100;
    this.materialModel = options.materialModel ?? "continuum";
    this.iterations = options.iterations ?? (this.materialModel === "continuum" ? 4 : 10);
    this.contactModel = options.contactModel ?? (this.materialModel === "continuum" ? "augmented" : "penalty");
    this.contactGeometry = options.contactGeometry ?? "triangles";
    if (!["quadrature", "triangles"].includes(this.contactGeometry)) throw new Error("Invalid contact geometry");
    this.floorFrictionModel = options.floorFrictionModel ?? (this.materialModel === "continuum" ? "reaction" : "legacy");
    if (!["legacy", "reaction"].includes(this.floorFrictionModel)) throw new Error("Invalid floor friction model");
    if (!["penalty", "augmented"].includes(this.contactModel)) throw new Error("Invalid contact model");
    if (this.materialModel === "legacy" && (this.contactModel !== "penalty" || this.floorFrictionModel !== "legacy")) throw new Error("Augmented contact and reaction floor friction require continuum material");
    this.fixedStepS = this.materialModel === "continuum" ? 1 / 120 : STEP;
    if (!["legacy", "continuum"].includes(this.materialModel)) throw new Error("Invalid material model");
    this.gravity = options.gravity ?? true;
    if (!Number.isFinite(this.floorYmm) || Math.abs(this.floorYmm) > 10000 || !Number.isInteger(this.iterations) || this.iterations < 4 || this.iterations > 30) throw new Error("Invalid playground options");
    const validId = (i: number) => Number.isInteger(i) && i >= 0 && i < this.masses.length;
    if (!mesh.tets.every(validId) || !mesh.surface_indices.every(validId)) throw new Error("Invalid cage index");
    this.faces = [...mesh.surface_indices];
    const shares = new Map<string, { a: number; b: number; share: number }>();
    for (let t = 0; t < mesh.tets.length; t += 4) {
      const ids = mesh.tets.slice(t, t + 4) as Tet["ids"];
      const volume = tetVolume(this.reference, ids);
      if (new Set(ids).size !== 4 || !Number.isFinite(volume) || volume <= 1e-15) throw new Error("Positive nondegenerate tetrahedra required");
      this.tets.push({ ids, volume, lambda: 0 }); this.restVolume += volume;
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
        const i = Math.min(ids[a]!, ids[b]!), j = Math.max(ids[a]!, ids[b]!);
        const key = `${i}:${j}`, edge = shares.get(key) ?? { a: i, b: j, share: 0 };
        edge.share += volume / 6; shares.set(key, edge);
      }
    }
    for (const edge of shares.values()) this.edges.push({ ...edge, rest: length(sub(point(this.reference, edge.a), point(this.reference, edge.b))), previous: 0, memory: 0, lambda: 0, restStep: 0, alpha: 0 });
    this.continuum = new TetContinuumMaterial(this.reference, this.tets);
    this.parameters = { ...parameters };
    this.setParameters(parameters);
    this.reset();
  }

  setParameters(parameters: PhysicsParameters): void {
    if (!Object.values(parameters).every(Number.isFinite) || !(parameters.young_pa >= 50 && parameters.young_pa <= 200000 && parameters.poisson >= 0 && parameters.poisson < .49 && parameters.relaxation_fraction >= 0 && parameters.relaxation_fraction <= .95 && parameters.relaxation_time_s > .005 && parameters.relaxation_time_s <= 30 && parameters.density_kg_m3 >= 500 && parameters.density_kg_m3 <= 2000 && parameters.contact_stiffness_n_m > 0 && parameters.indentation_stiffness_n_m > 0)) throw new Error("Invalid playground material parameters");
    this.parameters = { ...parameters };
    this.masses.fill(0);
    for (const tet of this.tets) for (const id of tet.ids) this.masses[id]! += tet.volume * parameters.density_kg_m3 / 4;
    for (let i = 0; i < this.masses.length; i++) {
      if (!(this.masses[i]! > 0)) throw new Error("Unconnected cage node has no physical mass");
      this.inverseMass[i] = 1 / this.masses[i]!;
    }
  }

  setGravity(enabled: boolean): void { this.gravity = Boolean(enabled); }
  /** Snapshot of actual mechanical tool positions, distinct from pointer targets.
   * Every tuple is a new copy; callers cannot mutate internal tool state. */
  interactionState(): PlaygroundInteractionState {
    const mm = (value: Vec): Vec => [value[0] * 1000, value[1] * 1000, value[2] * 1000];
    let grab: PlaygroundInteractionState["grab"] = null;
    if (this.grab) {
      const anchor = this.grab.anchors[0]!, attachment: Vec = [0, 0, 0];
      for (let j = 0; j < anchor.ids.length; j++) for (let k = 0; k < 3; k++) attachment[k]! += this.positions[3 * anchor.ids[j]! + k]! * anchor.weights[j]!;
      grab = { handleMm: mm(this.grab.current), targetMm: mm(this.grab.target), attachmentMm: mm(attachment) };
    }
    return { probe: this.probe ? { centerMm: mm(this.probe.current), radiusMm: this.probe.radius * 1000, targetMm: mm(this.probe.target) } : null, grab };
  }
  reset(): void { this.drop(75); }
  drop(heightMm = 100): void {
    if (!Number.isFinite(heightMm) || heightMm < 0 || heightMm > 1000) throw new Error("Drop height must be 0–1000 mm");
    let minY = Infinity, mx = 0, mz = 0, mass = 0;
    for (let i = 0; i < this.masses.length; i++) { minY = Math.min(minY, this.reference[3 * i + 1]!); mx += this.reference[3 * i]! * this.masses[i]!; mz += this.reference[3 * i + 2]! * this.masses[i]!; mass += this.masses[i]!; }
    for (let i = 0; i < this.masses.length; i++) { this.positions[3 * i] = this.reference[3 * i]! - mx / mass; this.positions[3 * i + 1] = this.reference[3 * i + 1]! + (this.floorYmm + heightMm) * .001 - minY; this.positions[3 * i + 2] = this.reference[3 * i + 2]! - mz / mass; }
    this.velocities.fill(0); this.grab = null; this.probe = null; this.accumulator = 0; this.simulationTime = 0; this.droppedTime = 0; this.rejected = 0; this.rejectedTime = 0; this.limited = 0; this.attempted = 0; this.totalStepMs = 0; this.lastStepMs = 0; this.minimumVolumeProjections = 0; this.maxProbePenetration = 0;
    for (const edge of this.edges) { edge.previous = 0; edge.memory = 0; edge.lambda = 0; }
    this.continuum.reset(); this.surfaceProbePenetration = 0; this.probeCenterInside = false; this.probeInsideInitializations = 0; this.probeInitialInsideOverlap = 0; this.probeInitializationAdjustment = 0; this.probeMotionClamped = 0; this.probeContainmentLimits = 0; this.floorReaction = 0; this.floorFrictionDissipated = 0;
    this.probeReaction = [0, 0, 0]; this.probeNormalForce = 0; this.probeWork = 0; this.probeActiveSamples = 0; this.probeComplementarity = 0; this.probeMaximumActiveGap = 0; this.probeActivations = 0; this.probeRemovals = 0; this.contactUpdates = 0;
    this.publish();
  }

  private publish() { for (let i = 0; i < this.positions.length; i++) this.positionsMm[i] = this.positions[i]! * 1000; }
  private anchorAt(p: Vec): Anchor {
    for (const tet of this.tets) {
      const o = point(this.positions, tet.ids[0]), a = sub(point(this.positions, tet.ids[1]), o), b = sub(point(this.positions, tet.ids[2]), o), c = sub(point(this.positions, tet.ids[3]), o), d = sub(p, o);
      const determinant = dot(a, cross(b, c));
      if (Math.abs(determinant) < 1e-16) continue;
      const u = dot(d, cross(b, c)) / determinant, v = dot(d, cross(c, a)) / determinant, w = dot(d, cross(a, b)) / determinant;
      const weights = [1 - u - v - w, u, v, w];
      if (Math.min(...weights) >= -1e-5) { const normalized = weights.map(x => Math.max(0, x)); const sum = normalized.reduce((a, b) => a + b, 0); return { ids: [...tet.ids], weights: normalized.map(x => x / sum), offset: [0, 0, 0], strength: 1, lambda: [0, 0, 0] }; }
    }
    let nearest = 0, distance = Infinity;
    for (let i = 0; i < this.masses.length; i++) { const d = length(sub(point(this.positions, i), p)); if (d < distance) { distance = d; nearest = i; } }
    return { ids: [nearest], weights: [1], offset: sub(point(this.positions, nearest), p), strength: 1, lambda: [0, 0, 0] };
  }

  beginGrab(pointMm: readonly number[], radiusMm = 25): boolean {
    const p = vector(pointMm, .001);
    if (!Number.isFinite(radiusMm) || radiusMm < 3 || radiusMm > 100) throw new Error("Invalid grab radius");
    const anchors = [this.anchorAt(p)];
    for (let i = 0; i < this.masses.length; i++) {
      const offset = sub(point(this.positions, i), p), distance = length(offset);
      if (distance < radiusMm * .001) anchors.push({ ids: [i], weights: [1], offset, strength: .35 * (1 - distance / (radiusMm * .001)) ** 2, lambda: [0, 0, 0] });
    }
    const sum = anchors.reduce((total, a) => total + a.strength, 0); for (const anchor of anchors) anchor.strength /= sum;
    this.grab = { target: [...p], current: [...p], anchors }; return true;
  }
  moveGrab(targetMm: readonly number[]): void { const target = vector(targetMm, .001); if (this.grab) this.grab.target = target.map(v => Math.max(-2, Math.min(2, v))) as Vec; }
  endGrab(): void { this.grab = null; }

  setProbe(centerMm: readonly number[] | null, radiusMm = 12): void {
    if (centerMm === null) { if (this.probe) this.probeRemovals++; this.probe = null; this.acceptedProbeResponse(); return; }
    const target = vector(centerMm, .001);
    if (!Number.isFinite(radiusMm) || radiusMm < 6 || radiusMm > 60) throw new Error("Probe radius must be 6–60 mm");
    if (this.probe && Math.abs(this.probe.radius * 1000 - radiusMm) < 1e-8) { this.probe.target = target; return; }
    const faces: ProbeFace[] = [], radius = radiusMm * .001;
    for (let face = 0; face < this.faces.length; face += 3) {
      const ids = this.faces.slice(face, face + 3) as ProbeFace["ids"];
      const a = point(this.reference, ids[0]), b = point(this.reference, ids[1]), c = point(this.reference, ids[2]);
      if (this.contactModel === "augmented" && this.contactGeometry === "triangles" && this.materialModel === "continuum") {
        faces.push({ ids, weights: new Float64Array(0), lambda: new Float64Array(1), area: length(cross(sub(b, a), sub(c, a))) / 2, supportGap: 0 }); continue;
      }
      const n = Math.min(64, Math.max(1, Math.ceil(Math.max(length(sub(a, b)), length(sub(a, c)), length(sub(b, c))) / (radius / 2))));
      const weights: number[] = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
        const u = (i + 1 / 3) / n, v = (j + 1 / 3) / n; weights.push(1 - u - v, u, v);
        if (i + j < n - 1) { const u2 = (i + 2 / 3) / n, v2 = (j + 2 / 3) / n; weights.push(1 - u2 - v2, u2, v2); }
      }
      faces.push({ ids, weights: Float64Array.from(weights), lambda: new Float64Array(weights.length / 3), area: length(cross(sub(b, a), sub(c, a))) / (2 * n * n), supportGap: 0 });
    }
    if (this.probe) this.probeRemovals++;
    let current: Vec = [...target]; this.probeInitialInsideOverlap = 0; this.probeInitializationAdjustment = 0;
    if (this.insideCage(target)) {
      const nearest = this.nearestBoundary(target); this.probeInsideInitializations++; this.probeInitialInsideOverlap = radius + nearest.distance;
      let clearance = radius + 1e-5;
      for (let attempt = 0; attempt < 8; attempt++) { current = nearest.point.map((value, k) => value + clearance * nearest.normal[k]!) as Vec; if (!this.insideCage(current)) break; clearance *= 2; }
      if (this.insideCage(current)) current[1] = Math.max(...Array.from(this.positions).filter((_, i) => i % 3 === 1)) + radius + 1e-5;
      this.probeInitializationAdjustment = length(sub(current, target));
    }
    this.probe = { target, current, radius, faces }; this.probeActivations++; this.acceptedProbeResponse();
  }

  punch(pointMm: readonly number[], direction: readonly number[], strengthMps = .8, radiusMm = 35): void {
    const p = vector(pointMm, .001), d = vector(direction), n = length(d);
    if (!(n > 1e-8) || !Number.isFinite(strengthMps) || strengthMps < 0 || strengthMps > 2 || !Number.isFinite(radiusMm) || radiusMm < 6 || radiusMm > 100) throw new Error("Invalid punch impulse");
    let changed = false;
    for (let i = 0; i < this.masses.length; i++) {
      const distance = length(sub(point(this.positions, i), p)), weight = Math.max(0, 1 - distance / (radiusMm * .001)) ** 2;
      if (!weight) continue; changed = true;
      for (let k = 0; k < 3; k++) this.velocities[3 * i + k]! += strengthMps * weight * d[k]! / n;
    }
    if (!changed) { const anchor = this.anchorAt(p); for (let j = 0; j < anchor.ids.length; j++) for (let k = 0; k < 3; k++) this.velocities[3 * anchor.ids[j]! + k]! += strengthMps * anchor.weights[j]! * d[k]! / n; }
  }

  advance(elapsedSeconds: number): number {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error("Invalid elapsed time");
    this.droppedTime += Math.max(0, elapsedSeconds - .1); this.accumulator += Math.min(elapsedSeconds, .1);
    let count = 0; const step = this.fixedStepS, maximum = Math.round(.05 / step);
    while (this.accumulator + 1e-12 >= step && count < maximum) { this.step(step); this.accumulator -= step; count++; }
    if (this.accumulator >= step) { const dropped = Math.floor(this.accumulator / step) * step; this.accumulator -= dropped; this.droppedTime += dropped; }
    return count;
  }

  step(h = this.fixedStepS): boolean {
    if (!Number.isFinite(h) || h <= 0 || h > 1 / 60) throw new Error("Timestep must be in (0,1/60]");
    const start = performance.now(), before = this.positions.slice(), oldVelocity = this.velocities.slice(), x = this.positions, im = this.inverseMass;
    const oldGrab = this.grab ? [...this.grab.current] as Vec : null, oldProbe = this.probe ? [...this.probe.current] as Vec : null, oldPenetration = this.maxProbePenetration;
    const oldReaction: Vec = [...this.probeReaction];
    const oldMultipliers = this.contactModel === "augmented" && this.probe ? this.probe.faces.map(face => ({ lambda: face.supportGap > 0 ? face.lambda.slice() : null, supportGap: face.supportGap })) : null;
    const { young_pa: E, poisson: nu, relaxation_fraction: g, relaxation_time_s: tau } = this.parameters;
    const bulk = E / (3 * (1 - 2 * nu)), mu = E / (2 * (1 + nu)), relaxedE = E * (1 - g), relaxedMu = 3 * bulk * relaxedE / (9 * bulk - relaxedE), shearTau = tau * (3 * bulk + relaxedMu) / (3 * bulk + mu);
    const decay = Math.exp(-h / shearTau), ramp = -Math.expm1(-h / shearTau) * shearTau / h;
    for (let i = 0; i < this.masses.length; i++) {
      const index = 3 * i;
      this.velocities[index + 1]! -= this.gravity ? 9.81 * h : 0;
      const speed = Math.hypot(this.velocities[index]!, this.velocities[index + 1]!, this.velocities[index + 2]!);
      const scale = speed > 4 ? 4 / speed : 1;
      for (let k = 0; k < 3; k++) { this.velocities[index + k]! *= scale; x[index + k]! += h * this.velocities[index + k]!; }
    }
    if (this.materialModel === "continuum") { this.continuum.beginStep(this.parameters, h, x);
      if (this.tets.every(t => tetVolume(x, t.ids) > .1 * t.volume)) { let lift = 0; for (let i = 1; i < x.length; i += 3) lift = Math.max(lift, this.floorYmm * .001 - x[i]!); if (lift > 0) for (let i = 1; i < x.length; i += 3) x[i]! += lift; }
      else x.set(before); }
    for (const edge of this.edges) {
      // Spring k=6*mu*Vshare/L²: equivalent E*A/L with A=Vshare/L,
      // using an explicit shear-network calibration factor. Mesh-dependent.
      const factor = 6 * edge.share / (edge.rest * edge.rest), equilibrium = factor * relaxedMu, branch = factor * (mu - relaxedMu), effective = equilibrium + branch * ramp;
      edge.restStep = edge.rest + branch * (ramp * edge.previous - decay * edge.memory) / effective;
      edge.alpha = 1 / (effective * h * h); edge.lambda = 0;
    }
    for (const tet of this.tets) tet.lambda = 0;
    const moveToward = (current: Vec, target: Vec, speed: number, maximumDistance = Infinity) => { const delta = sub(target, current), distance = length(delta), factor = Math.min(1, Math.min(speed * h, maximumDistance) / Math.max(distance, 1e-12)); for (let k = 0; k < 3; k++) current[k]! += delta[k]! * factor; };
    if (this.grab) { moveToward(this.grab.current, this.grab.target, .7); for (const anchor of this.grab.anchors) anchor.lambda = [0, 0, 0]; }
    if (this.probe) {
      if (this.insideCage(this.probe.current)) x.set(before);
      const boundary = this.nearestBoundary(this.probe.current), maximumDistance = Math.min(this.probe.radius / 3, .8 * boundary.distance);
      if (Math.min(.7 * h, length(sub(this.probe.target, this.probe.current))) > maximumDistance + 1e-12) this.probeMotionClamped++;
      moveToward(this.probe.current, this.probe.target, .7, maximumDistance); for (const face of this.probe.faces) { if (this.materialModel === "continuum" && this.contactModel === "augmented") { if (face.supportGap > 0) for (let i = 0; i < face.lambda.length; i++) face.lambda[i]! *= Math.pow(.99, h * 120); } else face.lambda.fill(0); } }
    this.maxProbePenetration = 0;
    for (let iteration = 0; iteration < this.iterations; iteration++) {
      if (this.materialModel === "continuum") {
        this.continuum.solveVertices(x, im, this.floorYmm * .001, (id, gradient, hessian) => this.continuumExternal(id, gradient, hessian));
        if (iteration + 1 < this.iterations && this.contactModel === "augmented") this.updateContactMultipliers();
      }
      else {
      for (const edge of this.edges) {
        const a = edge.a * 3, b = edge.b * 3, dx = x[b]! - x[a]!, dy = x[b + 1]! - x[a + 1]!, dz = x[b + 2]! - x[a + 2]!, distance = Math.hypot(dx, dy, dz);
        if (distance < 1e-12) continue;
        const dl = (-(distance - edge.restStep) - edge.alpha * edge.lambda) / (im[edge.a]! + im[edge.b]! + edge.alpha); edge.lambda += dl;
        const wa = im[edge.a]! * dl / distance, wb = im[edge.b]! * dl / distance;
        x[a]! -= wa * dx; x[a + 1]! -= wa * dy; x[a + 2]! -= wa * dz; x[b]! += wb * dx; x[b + 1]! += wb * dy; x[b + 2]! += wb * dz;
      }
      for (const tet of this.tets) {
        const ids = tet.ids, o = point(x, ids[0]), a = sub(point(x, ids[1]), o), b = sub(point(x, ids[2]), o), c = sub(point(x, ids[3]), o);
        const g1 = cross(b, c), g2 = cross(c, a), g3 = cross(a, b);
        const gradients = [[-g1[0] - g2[0] - g3[0], -g1[1] - g2[1] - g3[1], -g1[2] - g2[2] - g3[2]], g1, g2, g3];
        // C=V−Vrest [m³], so compliance=Vrest/K [m⁶/J].
        const alpha = tet.volume / (bulk * h * h); let denominator = alpha;
        for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) denominator += im[ids[j]!]! * (gradients[j]![k]! / 6) ** 2;
        const dl = (-(dot(a, g1) / 6 - tet.volume) - alpha * tet.lambda) / Math.max(denominator, 1e-30); tet.lambda += dl;
        for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) x[3 * ids[j]! + k]! += im[ids[j]!]! * dl * gradients[j]![k]! / 6;
      }
      if (this.grab) for (const anchor of this.grab.anchors) {
        const alpha = 1 / (this.parameters.contact_stiffness_n_m * anchor.strength * h * h);
        let denominator = alpha; for (let j = 0; j < anchor.ids.length; j++) denominator += im[anchor.ids[j]!]! * anchor.weights[j]! ** 2;
        for (let k = 0; k < 3; k++) {
          let current = 0; for (let j = 0; j < anchor.ids.length; j++) current += x[3 * anchor.ids[j]! + k]! * anchor.weights[j]!;
          const dl = (-(current - this.grab.current[k]! - anchor.offset[k]!) - alpha * anchor.lambda[k]!) / denominator; anchor.lambda[k]! += dl;
          for (let j = 0; j < anchor.ids.length; j++) x[3 * anchor.ids[j]! + k]! += im[anchor.ids[j]!]! * anchor.weights[j]! * dl;
        }
      }
      if (this.probe) this.solveProbe(h);
      const floor = this.floorYmm * .001;
      for (let i = 0; i < this.masses.length; i++) x[3 * i + 1] = Math.max(floor, x[3 * i + 1]!);
      this.projectMinimumVolumes(floor);
      }
    }
    // Coupled skinny floor cells need a converged unilateral rescue, not a
    // fixed pair of sweeps. Otherwise neighbor corrections can leave one cell
    // at the transactional guard and every subsequent step is rejected. The
    // .4 target / .36 convergence threshold are numerical volume barriers,
    // not learned tissue properties; all activations remain observable.
    for (let rescue = 0; this.materialModel === "legacy" && rescue < 64 && this.tets.some(t => tetVolume(x, t.ids) < .36 * t.volume); rescue++) this.projectMinimumVolumes(this.floorYmm * .001);
    if (this.probe && this.insideCage(this.probe.current)) this.probeContainmentLimits++;
    const safe = () => x.every(Number.isFinite) && (!this.probe || !this.insideCage(this.probe.current)) && this.tets.every(t => tetVolume(x, t.ids) > .08 * t.volume) && this.masses.every((_, i) => x[3 * i + 1]! >= this.floorYmm * .001 - 1e-10);
    if (!safe()) {
      const candidate = x.slice(); let factor = .5;
      while (factor >= 1 / 256) { for (let i = 0; i < x.length; i++) x[i] = before[i]! + factor * (candidate[i]! - before[i]!); if (safe()) break; factor *= .5; }
      if (factor < 1 / 256 || !safe()) {
        x.set(before); this.velocities.set(oldVelocity);
        if (this.grab && oldGrab) this.grab.current = oldGrab;
        if (this.probe && oldProbe) this.probe.current = oldProbe;
        if (this.probe && oldMultipliers) this.probe.faces.forEach((face, i) => { const old = oldMultipliers[i]!.lambda; if (old) face.lambda.set(old); else face.lambda.fill(0); face.supportGap = oldMultipliers[i]!.supportGap; });
        this.maxProbePenetration = oldPenetration; this.rejected++; this.rejectedTime += h;
        this.finishTiming(start); this.publish(); return false;
      }
      this.limited++;
    }
    const floorGradients = this.materialModel === "continuum" && this.floorFrictionModel === "reaction" ? this.continuum.floorIncrementalGradients(x, im, this.floorYmm * .001, (id, gradient, hessian) => this.continuumExternal(id, gradient, hessian)) : null;
    this.floorReaction = 0;
    if (this.materialModel === "continuum") this.continuum.commit(x);
    for (let i = 0; i < x.length; i++) this.velocities[i] = (x[i]! - before[i]!) / h;
    // Central pairwise damping preserves linear/angular momentum; air drag is
    // a small declared room effect, separate from learned material memory.
    const damping = 1 - Math.exp(-2 * h);
    for (const edge of this.edges) {
      const d = sub(point(x, edge.b), point(x, edge.a)), norm = length(d); if (norm < 1e-12) continue;
      const relative = dot(sub(point(this.velocities, edge.b), point(this.velocities, edge.a)), d) / norm;
      const impulse = damping * relative / (im[edge.a]! + im[edge.b]!);
      for (let k = 0; k < 3; k++) { this.velocities[3 * edge.a + k]! += im[edge.a]! * impulse * d[k]! / norm; this.velocities[3 * edge.b + k]! -= im[edge.b]! * impulse * d[k]! / norm; }
      const extension = norm - edge.rest; edge.memory = decay * edge.memory + ramp * (extension - edge.previous); edge.previous = extension;
    }
    for (let i = 0; i < this.masses.length; i++) {
      const a = 3 * i;
      if (floorGradients) {
        const normal = estimateFloorNormalReaction(x[a + 1]! - this.floorYmm * .001, floorGradients[i]!);
        const friction = applyFloorFriction(this.velocities[a]!, this.velocities[a + 2]!, normal, this.masses[i]!, h, .6);
        this.velocities[a] = friction.vxMps; this.velocities[a + 2] = friction.vzMps;
        this.floorReaction += normal; this.floorFrictionDissipated += friction.dissipatedEnergyJ;
        if (x[a + 1]! <= this.floorYmm * .001 + 1e-9) this.velocities[a + 1] = Math.max(0, this.velocities[a + 1]!);
      } else if (x[a + 1]! <= this.floorYmm * .001 + .0002) {
        const normal = Math.max(0, -oldVelocity[a + 1]!) + (this.gravity ? 9.81 * h : 0);
        const horizontal = Math.hypot(this.velocities[a]!, this.velocities[a + 2]!);
        const friction = Math.max(0, 1 - .6 * normal / Math.max(horizontal, 1e-12));
        this.velocities[a]! *= friction; this.velocities[a + 2]! *= friction; this.velocities[a + 1] = Math.max(0, this.velocities[a + 1]!);
      }
      for (let k = 0; k < 3; k++) this.velocities[a + k]! *= Math.exp(-.12 * h);
    }
    this.acceptedProbeResponse();
    // Work ON tissue by continuous tool translation. Tool creation/removal and
    // changes of the AL optimization state are not actuator work.
    if (this.probe && oldProbe) for (let k = 0; k < 3; k++) this.probeWork -= .5 * (oldReaction[k]! + this.probeReaction[k]!) * (this.probe.current[k]! - oldProbe[k]!);
    this.simulationTime += h; this.finishTiming(start); this.publish(); return true;
  }

  /** Tet-union containment makes a deep interior tool detectable even when no
   * boundary triangle intersects its sphere. Positive tet orientation is enforced. */
  private insideCage(p: Vec): boolean {
    if (!p.every(Number.isFinite)) return true;
    const x = this.positions, tolerance = 1e-10;
    for (let k = 0; k < 3; k++) { let lo = Infinity, hi = -Infinity; for (let i = k; i < x.length; i += 3) { lo = Math.min(lo, x[i]!); hi = Math.max(hi, x[i]!); } if (p[k]! < lo - tolerance || p[k]! > hi + tolerance) return false; }
    for (const tet of this.tets) {
      let outside = false;
      for (let k = 0; k < 3; k++) { let lo = Infinity, hi = -Infinity; for (const id of tet.ids) { lo = Math.min(lo, x[3 * id + k]!); hi = Math.max(hi, x[3 * id + k]!); } if (p[k]! < lo - tolerance || p[k]! > hi + tolerance) { outside = true; break; } }
      if (outside) continue;
      const o = point(x, tet.ids[0]), a = sub(point(x, tet.ids[1]), o), b = sub(point(x, tet.ids[2]), o), c = sub(point(x, tet.ids[3]), o), d = sub(p, o), determinant = dot(a, cross(b, c));
      if (!(determinant > 0)) continue;
      const u = dot(d, cross(b, c)) / determinant, v = dot(a, cross(d, c)) / determinant, w = dot(a, cross(b, d)) / determinant;
      if (Math.min(u, v, w, 1 - u - v - w) >= -1e-9) return true;
    }
    return false;
  }
  private faceOutwardNormal(ids: readonly number[]): Vec {
    const a = point(this.positions, ids[0]!), normal = cross(sub(point(this.positions, ids[1]!), a), sub(point(this.positions, ids[2]!), a));
    const tet = this.tets.find(cell => ids.every(id => cell.ids.includes(id))), opposite = tet?.ids.find(id => !ids.includes(id));
    const sign = opposite !== undefined && dot(normal, sub(point(this.positions, opposite), a)) > 0 ? -1 : 1, norm = Math.max(length(normal), 1e-30);
    return normal.map(value => sign * value / norm) as Vec;
  }
  private nearestBoundary(p: Vec): { point: Vec; normal: Vec; distance: number } {
    let best = { point: [0, 0, 0] as Vec, normal: [0, 1, 0] as Vec, distance: Infinity };
    for (let face = 0; face < this.faces.length; face += 3) {
      const ids = this.faces.slice(face, face + 3), vertices = ids.map(id => point(this.positions, id)); let lower = 0;
      for (let k = 0; k < 3; k++) lower += Math.max(Math.min(...vertices.map(v => v[k]!)) - p[k]!, 0, p[k]! - Math.max(...vertices.map(v => v[k]!))) ** 2;
      if (lower > best.distance ** 2) continue;
      const closest = closestTrianglePoint(p, vertices[0]!, vertices[1]!, vertices[2]!);
      if (closest.distance < best.distance) best = { point: closest.point, normal: this.faceOutwardNormal(ids), distance: closest.distance };
    }
    return best;
  }

  private probeSamples(face: ProbeFace): { weights: Vec; delta: Vec; distance: number }[] {
    const probe = this.probe!;
    if (face.weights.length === 0) {
      const closest = closestTrianglePoint(probe.current, point(this.positions, face.ids[0]), point(this.positions, face.ids[1]), point(this.positions, face.ids[2]));
      return [{ weights: closest.weights, delta: sub(closest.point, probe.current), distance: closest.distance }];
    }
    const samples: { weights: Vec; delta: Vec; distance: number }[] = [];
    for (let sample = 0; sample < face.lambda.length; sample++) {
      const weights: Vec = [face.weights[3 * sample]!, face.weights[3 * sample + 1]!, face.weights[3 * sample + 2]!], delta: Vec = [-probe.current[0], -probe.current[1], -probe.current[2]];
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) delta[k]! += this.positions[3 * face.ids[j]! + k]! * weights[j]!;
      samples.push({ weights, delta, distance: length(delta) });
    }
    return samples;
  }
  private sampleStiffness(face: ProbeFace): number {
    const ratio = face.area / (Math.PI * this.probe!.radius ** 2);
    // For triangle AL this is an optimization penalty, not a contact material.
    return this.parameters.indentation_stiffness_n_m * (face.weights.length === 0 ? Math.min(1, ratio) : ratio);
  }

  /** Projected normal-force multipliers, frozen throughout each primal sweep. */
  private updateContactMultipliers(): void {
    if (!this.probe) return;
    const probe = this.probe;
    for (const face of probe.faces) {
      let aabb = 0;
      for (let k = 0; k < 3; k++) { const coordinates = face.ids.map(id => this.positions[3 * id + k]!); aabb += Math.max(Math.min(...coordinates) - probe.current[k]!, 0, probe.current[k]! - Math.max(...coordinates)) ** 2; }
      if (aabb > (probe.radius + face.supportGap) ** 2) { if (face.supportGap > 0) face.lambda.fill(0); face.supportGap = 0; continue; }
      const stiffness = this.sampleStiffness(face);
      face.supportGap = 0;
      for (const [sample, contact] of this.probeSamples(face).entries()) {
        face.lambda[sample] = Math.max(0, face.lambda[sample]! + stiffness * (probe.radius - contact.distance)); this.contactUpdates++;
        face.supportGap = Math.max(face.supportGap, face.lambda[sample]! / stiffness);
      }
    }
  }

  private continuumExternal(id: number, gradient?: Float64Array, hessian?: Float64Array): number {
    const x = this.positions; let energy = 0;
    if (this.grab) for (const anchor of this.grab.anchors) {
      const index = anchor.ids.indexOf(id); if (index < 0) continue;
      const weight = anchor.weights[index]!, stiffness = this.parameters.contact_stiffness_n_m * anchor.strength;
      for (let k = 0; k < 3; k++) {
        let d = -this.grab.current[k]! - anchor.offset[k]!; for (let j = 0; j < anchor.ids.length; j++) d += x[3 * anchor.ids[j]! + k]! * anchor.weights[j]!;
        energy += .5 * stiffness * d * d;
        if (gradient && hessian) { gradient[k]! += stiffness * weight * d; hessian[4 * k]! += stiffness * weight * weight; }
      }
    }
    if (this.probe) for (const face of this.probe.faces) {
      const corner = face.ids.indexOf(id); if (corner < 0) continue;
      let aabb = 0;
      for (let k = 0; k < 3; k++) { const coordinates = face.ids.map(node => x[3 * node + k]!); aabb += Math.max(Math.min(...coordinates) - this.probe.current[k]!, 0, this.probe.current[k]! - Math.max(...coordinates)) ** 2; }
      if (aabb > (this.probe.radius + (this.contactModel === "augmented" ? face.supportGap : 0)) ** 2) continue;
      const stiffness = this.sampleStiffness(face);
      for (const [sample, contact] of this.probeSamples(face).entries()) {
        const d = contact.delta, distance = contact.distance, penetration = this.probe.radius - distance;
        const force = Math.max(0, stiffness * penetration + (this.contactModel === "augmented" ? face.lambda[sample]! : 0)); if (force <= 0) continue;
        energy += .5 * force * force / stiffness;
        if (!gradient || !hessian) continue;
        const weight = contact.weights[corner]!;
        if (distance < 1e-12) { const normal = this.faceOutwardNormal(face.ids); for (let k = 0; k < 3; k++) d[k] = -normal[k]!; } else for (let k = 0; k < 3; k++) d[k]! /= distance;
        for (let r = 0; r < 3; r++) { gradient[r]! -= weight * force * d[r]!; for (let c = 0; c < 3; c++) hessian[3 * r + c]! += stiffness * weight * weight * d[r]! * d[c]!; }
      }
    }
    return energy;
  }

  private projectMinimumVolumes(floor: number): void {
    const x = this.positions, im = this.inverseMass;
    for (let sweep = 0; sweep < 2; sweep++) for (const tet of this.tets) {
      const ids = tet.ids, o = point(x, ids[0]), a = sub(point(x, ids[1]), o), b = sub(point(x, ids[2]), o), c = sub(point(x, ids[3]), o);
      const g1 = cross(b, c), volume = dot(a, g1) / 6, target = .4 * tet.volume;
      if (volume >= target) continue;
      const g2 = cross(c, a), g3 = cross(a, b);
      const gradients = [[-g1[0] - g2[0] - g3[0], -g1[1] - g2[1] - g3[1], -g1[2] - g2[2] - g3[2]], g1, g2, g3];
      let denominator = 0;
      for (let j = 0; j < 4; j++) {
        // Contact is unilateral: a volume rescue may lift a node, but must not
        // push an already contacting corner through the floor. This prevents
        // skinny floor cells getting trapped at the transactional J guard.
        if (x[3 * ids[j]! + 1]! <= floor + 1e-10 && gradients[j]![1]! < 0) gradients[j]![1] = 0;
        for (let k = 0; k < 3; k++) denominator += im[ids[j]!]! * (gradients[j]![k]! / 6) ** 2;
      }
      if (denominator < 1e-30) continue;
      const dl = (target - volume) / denominator;
      for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) {
        const index = 3 * ids[j]! + k;
        let displacement = im[ids[j]!]! * dl * gradients[j]![k]! / 6;
        if (k === 1) displacement = Math.max(displacement, floor - x[index]!);
        x[index]! += displacement;
      }
      this.minimumVolumeProjections++;
    }
  }

  private solveProbe(h: number): void {
    const probe = this.probe!;
    for (const face of probe.faces) {
      const points = face.ids.map(id => point(this.positions, id));
      let aabbDistance = 0;
      for (let k = 0; k < 3; k++) { const lo = Math.min(points[0]![k]!, points[1]![k]!, points[2]![k]!), hi = Math.max(points[0]![k]!, points[1]![k]!, points[2]![k]!); aabbDistance += Math.max(lo - probe.current[k]!, 0, probe.current[k]! - hi) ** 2; }
      if (aabbDistance > probe.radius ** 2 && face.lambda.every(value => value === 0)) continue;
      const alpha = Math.PI * probe.radius ** 2 / (this.parameters.indentation_stiffness_n_m * face.area * h * h);
      for (let s = 0; s < face.lambda.length; s++) {
        const weights: Vec = [face.weights[3 * s]!, face.weights[3 * s + 1]!, face.weights[3 * s + 2]!];
        const delta: Vec = [-probe.current[0], -probe.current[1], -probe.current[2]];
        for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) delta[k]! += this.positions[3 * face.ids[j]! + k]! * weights[j]!;
        const distance = length(delta), c = distance - probe.radius;
        if (c >= 0 && face.lambda[s] === 0) continue;
        this.maxProbePenetration = Math.max(this.maxProbePenetration, -c);
        if (distance < 1e-10) { delta[0] = 0; delta[1] = 1; delta[2] = 0; } else for (let k = 0; k < 3; k++) delta[k]! /= distance;
        let denominator = alpha; for (let j = 0; j < 3; j++) denominator += this.inverseMass[face.ids[j]!]! * weights[j]! ** 2;
        const old = face.lambda[s]!, next = Math.max(0, old + (-c - alpha * old) / denominator), dl = next - old; face.lambda[s] = next;
        for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) this.positions[3 * face.ids[j]! + k]! += this.inverseMass[face.ids[j]!]! * dl * weights[j]! * delta[k]!;
      }
    }
  }

  /** Resultant force is on the tool; tissue receives the equal opposite force. */
  private acceptedProbeResponse(): void {
    this.maxProbePenetration = 0; this.surfaceProbePenetration = 0; this.probeCenterInside = false; this.probeReaction = [0, 0, 0]; this.probeNormalForce = 0; this.probeActiveSamples = 0; this.probeComplementarity = 0; this.probeMaximumActiveGap = 0;
    if (!this.probe) return;
    const probe = this.probe;
    for (const face of probe.faces) {
      let aabb = 0;
      for (let k = 0; k < 3; k++) { const coordinates = face.ids.map(id => this.positions[3 * id + k]!); aabb += Math.max(Math.min(...coordinates) - probe.current[k]!, 0, probe.current[k]! - Math.max(...coordinates)) ** 2; }
      if (aabb > (probe.radius + (this.contactModel === "augmented" ? face.supportGap : 0)) ** 2) continue;
      const stiffness = this.sampleStiffness(face);
      const exact = closestTrianglePoint(probe.current, point(this.positions, face.ids[0]), point(this.positions, face.ids[1]), point(this.positions, face.ids[2]));
      this.surfaceProbePenetration = Math.max(this.surfaceProbePenetration, probe.radius - exact.distance);
      for (const [sample, contact] of this.probeSamples(face).entries()) {
        const delta = contact.delta, distance = contact.distance, penetration = probe.radius - distance;
        this.maxProbePenetration = Math.max(this.maxProbePenetration, penetration);
        const force = Math.max(0, stiffness * penetration + (this.contactModel === "augmented" && this.materialModel === "continuum" ? face.lambda[sample]! : 0));
        if (force <= 1e-12) continue;
        this.probeNormalForce += force; this.probeActiveSamples++; this.probeComplementarity += force * Math.abs(penetration); this.probeMaximumActiveGap = Math.max(this.probeMaximumActiveGap, -penetration);
        if (distance < 1e-12) { const normal = this.faceOutwardNormal(face.ids); for (let k = 0; k < 3; k++) delta[k] = -normal[k]!; } else for (let k = 0; k < 3; k++) delta[k]! /= distance;
        for (let k = 0; k < 3; k++) this.probeReaction[k]! -= force * delta[k]!;
      }
    }
    this.probeCenterInside = this.insideCage(probe.current);
    if (this.probeCenterInside) this.surfaceProbePenetration = probe.radius + this.nearestBoundary(probe.current).distance;
  }

  private finishTiming(start: number) { this.lastStepMs = performance.now() - start; this.totalStepMs += this.lastStepMs; this.attempted++; }
  metrics(): PlaygroundMetrics {
    let volume = 0, minimum = Infinity, minY = Infinity, speed = 0, mass = 0; const center: Vec = [0, 0, 0];
    for (const tet of this.tets) { const v = tetVolume(this.positions, tet.ids); volume += v; minimum = Math.min(minimum, v / tet.volume); }
    for (let i = 0; i < this.masses.length; i++) { minY = Math.min(minY, this.positions[3 * i + 1]!); speed = Math.max(speed, length(point(this.velocities, i))); mass += this.masses[i]!; for (let k = 0; k < 3; k++) center[k]! += this.positions[3 * i + k]! * this.masses[i]!; }
    const continuum = this.continuum.diagnostics();
    return { material_model: this.materialModel, contact_model: this.contactModel, contact_geometry: this.contactModel === "augmented" ? this.contactGeometry : "quadrature", maximum_probe_surface_penetration_mm: this.surfaceProbePenetration * 1000, probe_center_inside: this.probeCenterInside, probe_inside_initializations: this.probeInsideInitializations, probe_initial_inside_overlap_mm: this.probeInitialInsideOverlap * 1000, probe_initialization_adjustment_mm: this.probeInitializationAdjustment * 1000, probe_motion_clamped_steps: this.probeMotionClamped, probe_containment_limits: this.probeContainmentLimits, floor_friction_model: this.floorFrictionModel, floor_normal_reaction_n: this.floorReaction, floor_friction_dissipated_j: this.floorFrictionDissipated, probe_reaction_n: [...this.probeReaction], probe_normal_force_n: this.probeNormalForce, probe_work_j: this.probeWork, probe_active_samples: this.probeActiveSamples, probe_complementarity_n_mm: this.probeComplementarity * 1000, probe_max_active_gap_mm: this.probeMaximumActiveGap * 1000, probe_activation_count: this.probeActivations, probe_removal_count: this.probeRemovals, contact_augmented_updates: this.contactUpdates, fixed_step_s: this.fixedStepS, nonlinear_iterations: this.iterations, continuum_volume_limits: continuum.volumeLimits, line_search_backtracks: continuum.lineSearchBacktracks, rejected_vertex_updates: continuum.rejectedVertexUpdates, final_sweep_max_displacement_mm: continuum.lastSweepDisplacement * 1000, simulation_time_s: this.simulationTime, volume_change_pct: (volume / this.restVolume - 1) * 100, minimum_jacobian: minimum, floor_penetration_mm: Math.max(0, this.floorYmm - minY * 1000), maximum_speed_m_s: speed, rejected_steps: this.rejected, limited_steps: this.limited, dropped_time_s: this.droppedTime, rejected_time_s: this.rejectedTime, last_step_ms: this.lastStepMs, mean_step_ms: this.totalStepMs / Math.max(1, this.attempted), node_count: this.masses.length, tet_count: this.tets.length, finite_state: this.positions.every(Number.isFinite) && this.velocities.every(Number.isFinite), center_of_mass_mm: center.map(v => v / mass * 1000) as Vec, maximum_probe_penetration_mm: this.maxProbePenetration * 1000, minimum_volume_projections: this.minimumVolumeProjections };
  }
}
