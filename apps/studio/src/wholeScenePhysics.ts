/** Coupled reduced-order viscoelastic preview, SI integration / mm rendering.
 * Material estimates come from synthetic SLS histories. Anatomical attachments,
 * modal mass/stiffness, damping and loading are authored; not surgical FEM.
 * Registered attachment components share a displacement lattice. Independent
 * components retain their own contact fields; no implicit adhesion through air.
 */
import type { WholeSceneCategory } from "./wholeSceneModel";
import { solveStrainStiffening, type SceneTissueResponse } from "./sceneTissueResponse";
export interface SceneLearnedMaterial {
  id: string; young_pa: number; relaxation_fraction: number; relaxation_time_s: number;
  density_kg_m3: number; accepted_for_application: true; observation_origin: "synthetic-design-history";
}
export interface LearnedSceneMaterials {
  schema_version: "whole-scene-materials-1.0.0"; model_id: string; scope: string; materials: SceneLearnedMaterial[];
}
export function readLearnedSceneMaterials(value: unknown): LearnedSceneMaterials {
  const data = value as Partial<LearnedSceneMaterials> | null;
  if (!data || data.schema_version !== "whole-scene-materials-1.0.0" || !/^[a-f0-9]{64}$/.test(data.model_id ?? "") || typeof data.scope !== "string" || !Array.isArray(data.materials) || !data.materials.length) throw new Error("Learned scene materials are missing or unsupported.");
  const ids = new Set<string>();
  for (const m of data.materials) {
    if (!m || typeof m.id !== "string" || !m.id || ids.has(m.id) || m.accepted_for_application !== true || m.observation_origin !== "synthetic-design-history" ||
      ![m.young_pa, m.relaxation_fraction, m.relaxation_time_s, m.density_kg_m3].every(Number.isFinite) ||
      m.young_pa < 500 || m.young_pa > 20000 || m.relaxation_fraction < .05 || m.relaxation_fraction > .75 || m.relaxation_time_s < .05 || m.relaxation_time_s > 2 || m.density_kg_m3 < 900 || m.density_kg_m3 > 1200) throw new Error("A learned organ material failed its application checks.");
    ids.add(m.id);
  }
  return data as LearnedSceneMaterials;
}
export interface ScenePhysicsOrgan { id: string; category: WholeSceneCategory; bounds: { min: number[]; max: number[] } }
export interface ScenePhysicsAttachment { a: string; b: string }
export interface ScenePhysicsBinding { indices: Uint16Array; weights: Float32Array; vertices: number; organId?: string | undefined }
interface Mode {
  id: string; category: WholeSceneCategory; center: number[]; radius: number; mass: number; k: number; fraction: number; tau: number;
  q: Float64Array; v: Float64Array; memory: Float64Array; material: SceneLearnedMaterial;
  characteristicLength: number; response?: SceneTissueResponse | undefined;
}
export interface SceneToolContactInput {
  mode: "push" | "grasp"; organId: string; restPointMm: number[]; normal: number[];
  targetPointMm: number[]; radiusMm: number; strength?: number;
  attachment?: { verticesMm: [number[], number[], number[]]; barycentric: number[] } | undefined;
}
interface LocalToolMode {
  input: SceneToolContactInput; active: boolean; radius: number; anchorFactor: number;
  q: Float64Array; v: Float64Array; memory: Float64Array; force: Float64Array;
  mass: number; k: number; fraction: number; tau: number; materialMode: number;
  limits: number; clamped: boolean;
  cubic: number; dampingRatio: number;
  coarseWeights: Float64Array;
}
const H = 1 / 120;
const MAX_FRAME_TIME = .1;
const NX = 9, NY = 15, NZ = 7, N = NX * NY * NZ;
const nodeId = (x: number, y: number, z: number) => (y * NZ + z) * NX + x;
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
const compactWeight = (distance: number, radius: number) => { const r = distance / radius; return r >= 1 ? 0 : (1 - r) ** 4 * (1 + 4 * r); };
const validPoint = (p: number[]) => p.length === 3 && p.every(Number.isFinite);
export class WholeScenePhysics {
  private modes: Mode[];
  private minimum: number[];
  private spacing: number[];
  private lattice = new Float64Array(N * 3);
  private weights: Float64Array;
  private couplings: { a: number; b: number; k: number }[] = [];
  private anatomicalAttachments: ScenePhysicsAttachment[] | undefined;
  private components: number[] = [];
  private componentLattices = new Map<number, Float64Array>();
  private componentWeights: Float64Array | null = null;
  private componentScales = new Map<number, number>();
  private pulseMode = -1;
  private pulseUntil = 0;
  private time = 0;
  private accumulator = 0;
  private dropped = 0;
  private limits = 0;
  private gradientBound = 0;
  private peakDisplacement = 0;
  private maxDisplacement = 0;
  private maxSpeed = 0;
  private tools: LocalToolMode[] = [];
  private selectedTool: LocalToolMode | null = null;
  private localScale = 1;
  private localScales = new Map<number, number>();
  // A contact's rest-space footprint does not change during its hold/recovery.
  // Cache its exact Float64 weights per binding, instead of evaluating sqrt/pow
  // for every displayed vertex every frame. Sliding replaces the contact object.
  private contactWeights = new WeakMap<ScenePhysicsBinding, { rest: Float32Array; weights: Map<LocalToolMode, Float64Array> }>();
  readonly modelId: string;
  constructor(organs: ScenePhysicsOrgan[], source: LearnedSceneMaterials, responses: Record<string, SceneTissueResponse> = {}, attachments?: ScenePhysicsAttachment[]) {
    const materials = readLearnedSceneMaterials(source);
    if (!organs.length || organs.some(o => o.bounds.min.length !== 3 || o.bounds.max.length !== 3 || ![...o.bounds.min, ...o.bounds.max].every(Number.isFinite) || o.bounds.min.some((v, a) => v >= o.bounds.max[a]!))) throw new Error("Physics requires finite, nonempty anatomical bounds.");
    this.modelId = materials.model_id;
    const soft = organs.filter(o => o.category !== "skeleton");
    if (!soft.length) throw new Error("No soft organs are available for physics.");
    const map = new Map(materials.materials.map(m => [m.id, m]));
    for (const [id, response] of Object.entries(responses)) {
      if (!soft.some(o => o.id === id) || ![response.strainStiffening, response.localDampingRatio, response.supportRadiusRatio].every(Number.isFinite) || response.strainStiffening < 0 || response.strainStiffening > 80 || response.localDampingRatio < .5 || response.localDampingRatio > 1.5 || response.supportRadiusRatio < .2 || response.supportRadiusRatio > 2 || (response.fixedGlobalSupport !== undefined && typeof response.fixedGlobalSupport !== "boolean")) throw new Error("Invalid authored tissue-response parameters.");
    }
    this.modes = soft.map(organ => {
      const material = map.get(organ.id); if (!material) throw new Error(`No accepted learned material for ${organ.id}; no partial assignment was applied.`);
      const extent = organ.bounds.max.map((v, a) => v - organ.bounds.min[a]!);
      const length = Math.max(20, Math.cbrt(extent[0]! * extent[1]! * extent[2]!));
      const mass = Math.max(.025, Math.min(2.5, material.density_kg_m3 * extent[0]! * extent[1]! * extent[2]! * 1e-9 * .35));
      return { id: organ.id, category: organ.category, center: extent.map((v, a) => organ.bounds.min[a]! + v / 2), radius: Math.max(55, Math.hypot(...extent) * .65), mass,
        k: material.young_pa * length * .001 * .35, fraction: material.relaxation_fraction, tau: material.relaxation_time_s,
        q: new Float64Array(3), v: new Float64Array(3), memory: new Float64Array(3), material, characteristicLength: length, response: responses[organ.id] ? { ...responses[organ.id]! } : undefined };
    });
    // An explicit empty graph intentionally means no permanent joins. The
    // omitted graph retains the generic atlas' legacy spatial approximation.
    this.anatomicalAttachments = attachments?.map(edge => ({ ...edge }));
    this.components = this.modes.map((_, i) => i);
    const root = (i: number): number => this.components[i] === i ? i : root(this.components[i]!);
    for (const edge of attachments ?? []) {
      const a = this.modes.findIndex(m => m.id === edge.a), b = this.modes.findIndex(m => m.id === edge.b);
      if (a < 0 || b < 0 || a === b) throw new Error("Invalid anatomical physics attachment.");
      this.components[root(b)] = root(a);
    }
    this.components = this.components.map((_, i) => root(i));
    if (attachments) for (const component of new Set(this.components)) {
      this.componentLattices.set(component, new Float64Array(N * 3));
      this.componentScales.set(component, 1);
    }
    this.minimum = [0, 1, 2].map(a => Math.min(...organs.map(o => o.bounds.min[a]!)) - 5);
    const maximum = [0, 1, 2].map(a => Math.max(...organs.map(o => o.bounds.max[a]!)) + 5);
    this.spacing = [NX, NY, NZ].map((n, a) => (maximum[a]! - this.minimum[a]!) / (n - 1));
    this.weights = new Float64Array(N * this.modes.length);
    if (attachments) this.componentWeights = new Float64Array(this.weights.length);
    for (let y = 0; y < NY; y++) for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
      const id = nodeId(x, y, z); const p = [x, y, z].map((v, a) => this.minimum[a]! + v * this.spacing[a]!);
      let sum = 0;
      this.modes.forEach((mode, i) => {
        const d2 = p.reduce((sum, v, a) => sum + ((v - mode.center[a]!) / mode.radius) ** 2, 0);
        const w = Math.exp(-2 * d2); this.weights[id * this.modes.length + i] = w; sum += w;
      });
      if (this.componentWeights) {
        const sums = new Map<number, number>();
        this.modes.forEach((_, i) => sums.set(this.components[i]!, (sums.get(this.components[i]!) ?? 0) + this.weights[id * this.modes.length + i]!));
        this.modes.forEach((_, i) => { this.componentWeights![id * this.modes.length + i] = this.weights[id * this.modes.length + i]! / Math.max(sums.get(this.components[i]!)!, 1e-12); });
      }
      // Authored posterior support and end taper. This is not a reconstructed ligament map.
      const support = smooth(z / (NZ - 1) * 2.2) * (.45 + .55 * Math.sin(Math.PI * y / (NY - 1)));
      for (let i = 0; i < this.modes.length; i++) {
        this.weights[id * this.modes.length + i]! *= support / Math.max(sum, 1e-12);
        if (this.componentWeights) this.componentWeights[id * this.modes.length + i]! *= support;
      }
    }
    for (let a = 0; a < this.modes.length; a++) {
      const mode = this.modes[a]!;
      const neighbors = attachments ? attachments.filter(e => e.a === mode.id || e.b === mode.id).map(e => ({ b: this.modes.findIndex(m => m.id === (e.a === mode.id ? e.b : e.a)) })) : this.modes.map((other, b) => ({ b, d: Math.hypot(...mode.center.map((v, axis) => v - other.center[axis]!)) })).filter(n => n.b !== a).sort((u, v) => u.d - v.d).slice(0, 3);
      for (const { b } of neighbors) {
        if (this.couplings.some(c => (c.a === a && c.b === b) || (c.a === b && c.b === a))) continue;
        this.couplings.push({ a, b, k: .06 * 2 * mode.k * this.modes[b]!.k / (mode.k + this.modes[b]!.k) });
      }
    }
  }
  private modeIndex(organId?: string) {
    if (organId === undefined) return -1;
    const index = this.modes.findIndex(mode => mode.id === organId);
    if (index < 0) throw new Error(`Unknown soft-tissue binding ${organId}.`);
    return index;
  }
  private toolScale(tool: LocalToolMode) { return this.anatomicalAttachments ? (this.localScales.get(this.components[tool.materialMode]!) ?? 1) : this.localScale; }
  private localAffects(tool: LocalToolMode, organId?: string) {
    const index = this.modeIndex(organId);
    return !this.anatomicalAttachments || index < 0 || this.components[index] === this.components[tool.materialMode];
  }
  private field(organId?: string) {
    const index = this.modeIndex(organId);
    return this.anatomicalAttachments && index >= 0 ? this.componentLattices.get(this.components[index]!)! : this.lattice;
  }
  bind(rest: Float32Array, organId?: string): ScenePhysicsBinding {
    this.modeIndex(organId);
    if (rest.length % 3 || !rest.every(Number.isFinite)) throw new Error("Cannot bind invalid anatomy positions.");
    const vertices = rest.length / 3, indices = new Uint16Array(vertices * 8), weights = new Float32Array(vertices * 8);
    for (let v = 0; v < vertices; v++) {
      const cell = [0, 1, 2].map(a => Math.max(0, Math.min([NX, NY, NZ][a]! - 1.000001, (rest[3 * v + a]! - this.minimum[a]!) / this.spacing[a]!)));
      const base = cell.map(Math.floor), f = cell.map((u, a) => u - base[a]!);
      for (let corner = 0; corner < 8; corner++) {
        const dx = corner & 1, dy = (corner >> 1) & 1, dz = (corner >> 2) & 1;
        indices[v * 8 + corner] = nodeId(base[0]! + dx, base[1]! + dy, base[2]! + dz);
        weights[v * 8 + corner] = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
      }
    }
    return { vertices, indices, weights, organId };
  }
  deform(rest: Float32Array, out: Float32Array, binding: ScenePhysicsBinding) {
    if (rest.length !== out.length || rest.length !== binding.vertices * 3) throw new Error("Physics binding no longer matches the scene.");
    let cache = this.contactWeights.get(binding);
    if (!cache || cache.rest !== rest) {
      cache = { rest, weights: new Map() }; this.contactWeights.set(binding, cache);
    }
    for (const tool of cache.weights.keys()) if (!this.tools.includes(tool)) cache.weights.delete(tool);
    const local = this.tools.filter(tool => this.localAffects(tool, binding.organId) && tool.q.some(q => q !== 0)).map(tool => {
      let weights = cache.weights.get(tool);
      if (!weights) {
        weights = new Float64Array(binding.vertices);
        const p = tool.input.restPointMm;
        for (let v = 0; v < binding.vertices; v++) weights[v] = compactWeight(Math.hypot(rest[v * 3]! - p[0]!, rest[v * 3 + 1]! - p[1]!, rest[v * 3 + 2]! - p[2]!), tool.radius) * 1000;
        cache.weights.set(tool, weights);
      }
      return { weights, x: tool.q[0]! * this.toolScale(tool), y: tool.q[1]! * this.toolScale(tool), z: tool.q[2]! * this.toolScale(tool) };
    });
    const field = this.field(binding.organId);
    // Accumulate in registers, then store each Float32 coordinate once. This is
    // the same shared trilinear field, with less roundoff and memory traffic.
    for (let v = 0; v < binding.vertices; v++) {
      const position = v * 3, corner = v * 8;
      let x = rest[position]!, y = rest[position + 1]!, z = rest[position + 2]!;
      for (let c = 0; c < 8; c++) {
        const id = binding.indices[corner + c]! * 3, w = binding.weights[corner + c]!;
        x += field[id]! * w;
        y += field[id + 1]! * w;
        z += field[id + 2]! * w;
      }
      for (const tool of local) {
        const w = tool.weights[v]!;
        x += tool.x * w; y += tool.y * w; z += tool.z * w;
      }
      out[position] = x; out[position + 1] = y; out[position + 2] = z;
    }
  }
  /** Continuous field within each registered attachment component. Supply the
   * owner to distinguish unjoined surfaces at the same spatial coordinate. */
  samplePoint(rest: number[], organId?: string): number[] {
    if (!validPoint(rest)) throw new Error("Invalid physics sample coordinate.");
    const out = [...rest], field = this.field(organId);
    const cell = rest.map((v, a) => Math.max(0, Math.min([NX, NY, NZ][a]! - 1.000001, (v - this.minimum[a]!) / this.spacing[a]!)));
    const base = cell.map(Math.floor), f = cell.map((v, a) => v - base[a]!);
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const id = nodeId(base[0]! + dx, base[1]! + dy, base[2]! + dz) * 3;
      const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
      for (let a = 0; a < 3; a++) out[a]! += field[id + a]! * w;
    }
    for (const tool of this.tools) {
      if (!this.localAffects(tool, organId)) continue;
      const w = compactWeight(Math.hypot(...rest.map((v, a) => v - tool.input.restPointMm[a]!)), tool.radius) * 1000 * this.toolScale(tool);
      for (let a = 0; a < 3; a++) out[a]! += tool.q[a]! * w;
    }
    return out;
  }
  private toolAnchor(tool: LocalToolMode): number[] {
    const attachment = tool.input.attachment;
    if (!attachment) return this.samplePoint(tool.input.restPointMm, tool.input.organId);
    const out = [0, 0, 0];
    attachment.verticesMm.forEach((p, i) => { const deformed = this.samplePoint(p, tool.input.organId); for (let a = 0; a < 3; a++) out[a]! += deformed[a]! * attachment.barycentric[i]!; });
    return out;
  }
  beginToolContact(input: SceneToolContactInput) {
    const modeIndex = this.modes.findIndex(m => m.id === input.organId);
    if (modeIndex < 0 || !["push", "grasp"].includes(input.mode) || !validPoint(input.restPointMm) || !validPoint(input.targetPointMm) || !validPoint(input.normal) || Math.hypot(...input.normal) < 1e-8 || !Number.isFinite(input.radiusMm) || input.radiusMm < .5 || input.radiusMm > 25 || (input.strength !== undefined && (!Number.isFinite(input.strength) || input.strength <= 0 || input.strength > 3))) throw new Error("Invalid anatomical tool contact.");
    const attachment = input.attachment;
    if (attachment && (attachment.verticesMm.length !== 3 || !attachment.verticesMm.every(validPoint) || attachment.barycentric.length !== 3 || !attachment.barycentric.every(v => Number.isFinite(v) && v >= -1e-6 && v <= 1 + 1e-6) || Math.abs(attachment.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-5)) throw new Error("Invalid surface attachment weights.");
    this.releaseToolContact();
    const normalLength = Math.hypot(...input.normal);
    const copy: SceneToolContactInput = { ...input, restPointMm: [...input.restPointMm], targetPointMm: [...input.targetPointMm], normal: input.normal.map(v => v / normalLength), attachment: attachment ? { verticesMm: attachment.verticesMm.map(p => [...p]) as [number[], number[], number[]], barycentric: [...attachment.barycentric] } : undefined };
    const mode = this.modes[modeIndex]!, response = mode.response;
    const legacySupport = input.mode === "grasp" ? 85 : Math.max(38, input.radiusMm * 7);
    const minimumSupport = response ? Math.min(legacySupport, Math.max(input.radiusMm * 3, mode.characteristicLength * response.supportRadiusRatio)) : legacySupport;
    const vertexRadius = attachment ? Math.max(...attachment.verticesMm.map(p => Math.hypot(...p.map((v, a) => v - input.restPointMm[a]!)))) : 0;
    const radius = Math.max(minimumSupport, vertexRadius * 2 + input.radiusMm);
    const anchorFactor = attachment ? attachment.verticesMm.reduce((sum, p, i) => sum + attachment.barycentric[i]! * compactWeight(Math.hypot(...p.map((v, a) => v - input.restPointMm[a]!)), radius), 0) : 1;
    const material = mode.material, k = material.young_pa * radius * .001 * .22;
    const tool: LocalToolMode = { input: copy, active: true, radius, anchorFactor, q: new Float64Array(3), v: new Float64Array(3), memory: new Float64Array(3), force: new Float64Array(3), mass: Math.max(response ? .001 : .015, Math.min(.3, material.density_kg_m3 * (radius * .001) ** 3 * .3)), k, fraction: material.relaxation_fraction, tau: material.relaxation_time_s, materialMode: modeIndex, limits: 0, clamped: false,
      cubic: k * (1 - material.relaxation_fraction) * (response?.strainStiffening ?? 0) / (radius * .001) ** 2, dampingRatio: response?.localDampingRatio ?? .9, coarseWeights: new Float64Array(this.modes.length) };
    this.setCoarseLoadWeights(tool);
    // Released local modes keep recovering instead of disappearing at a new grab.
    this.tools.push(tool); this.selectedTool = tool;
    this.moveToolTarget(copy.targetPointMm);
  }
  private setCoarseLoadWeights(tool: LocalToolMode) {
    if (!this.componentWeights) { tool.coarseWeights[tool.materialMode] = .1; return; }
    const points = tool.input.attachment?.verticesMm ?? [tool.input.restPointMm];
    const barycentric = tool.input.attachment?.barycentric ?? [1];
    points.forEach((point, vertex) => {
      const cell = point.map((v, a) => Math.max(0, Math.min([NX, NY, NZ][a]! - 1.000001, (v - this.minimum[a]!) / this.spacing[a]!)));
      const base = cell.map(Math.floor), f = cell.map((v, a) => v - base[a]!);
      for (let c = 0; c < 8; c++) {
        const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
        const id = nodeId(base[0]! + dx, base[1]! + dy, base[2]! + dz);
        const w = barycentric[vertex]! * (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
        for (let i = 0; i < this.modes.length; i++) if (this.components[i] === this.components[tool.materialMode] && !this.modes[i]!.response?.fixedGlobalSupport) tool.coarseWeights[i]! += this.componentWeights![id * this.modes.length + i]! * w;
      }
    });
  }
  moveToolTarget(targetPointMm: number[], normal?: number[]) {
    const tool = this.selectedTool; if (!tool?.active) return;
    if (!validPoint(targetPointMm) || (normal && (!validPoint(normal) || Math.hypot(...normal) < 1e-8))) throw new Error("Invalid tool target.");
    const delta = targetPointMm.map((v, a) => v - tool.input.restPointMm[a]!); const distance = Math.hypot(...delta), maximum = 45;
    tool.clamped = distance > maximum;
    if (tool.clamped) tool.limits++;
    tool.input.targetPointMm = delta.map((v, a) => tool.input.restPointMm[a]! + v * Math.min(1, maximum / Math.max(distance, 1e-12)));
    if (normal) { const size = Math.hypot(...normal); tool.input.normal = normal.map(v => v / size); }
  }
  slideToolContact(input: SceneToolContactInput) {
    const previous = this.selectedTool;
    const carry = previous?.active && previous.input.mode === "push" && input.mode === "push" && previous.input.organId === input.organId && Math.hypot(...input.restPointMm.map((v, a) => v - previous.input.restPointMm[a]!)) <= previous.radius * .5;
    this.beginToolContact(input);
    if (carry && previous && this.selectedTool) {
      this.selectedTool.q.set(previous.q); this.selectedTool.v.set(previous.v); this.selectedTool.memory.set(previous.memory);
      this.tools = this.tools.filter(mode => mode !== previous);
    }
  }
  releaseToolContact() { if (this.selectedTool) { this.selectedTool.active = false; this.selectedTool.force.fill(0); } }
  /** Rendering sleep only: the fixed-step material history keeps integrating.
   * Sub-micrometre residuals need no repeated GPU upload or shadow redraw. */
  get motionActive() {
    return this.time < this.pulseUntil || this.tools.some(tool => tool.active) || this.maxDisplacement > 1e-4 || this.maxSpeed > 1e-7;
  }
  toolSnapshot() {
    const tool = this.selectedTool; if (!tool) return null;
    const actual = this.toolAnchor(tool), residual = tool.input.targetPointMm.map((v, a) => v - actual[a]!);
    return { active: tool.active, mode: tool.input.mode, organId: tool.input.organId, restPointMm: [...tool.input.restPointMm], normal: [...tool.input.normal], targetPointMm: [...tool.input.targetPointMm], actualSurfacePointMm: actual, forceN: Array.from(tool.force), normalForceN: Math.max(0, -tool.force.reduce((sum, v, a) => sum + v * tool.input.normal[a]!, 0)), displacementMm: actual.map((v, a) => v - tool.input.restPointMm[a]!), residualMm: Math.hypot(...residual), requestedPenetrationMm: tool.input.mode === "push" ? Math.max(0, -residual.reduce((sum, v, a) => sum + v * tool.input.normal[a]!, 0)) : 0, clamped: tool.clamped || this.toolScale(tool) < .999999, supportRadiusMm: tool.radius, limitCount: tool.limits, anchorKernelWeight: tool.anchorFactor, projectionScale: this.toolScale(tool), forceLimitN: 3 * (tool.input.strength ?? 1), coarseLoadWeights: Array.from(tool.coarseWeights, (weight, i) => ({ organId: this.modes[i]!.id, weight })).filter(entry => entry.weight > 0), forceEvaluation: "bounded spring at final rendered barycentric anchor; implicit step uses prior shared-field projection" };
  }
  pulse(id?: string | null) {
    const selected = id ? this.modes.findIndex(m => m.id === id) : -1;
    this.pulseMode = selected >= 0 ? selected : Math.max(0, this.modes.findIndex(m => /liver/i.test(m.id)));
    this.pulseUntil = this.time + .35;
  }
  reset() {
    for (const mode of this.modes) { mode.q.fill(0); mode.v.fill(0); mode.memory.fill(0); }
    this.lattice.fill(0); for (const field of this.componentLattices.values()) field.fill(0); this.time = 0; this.accumulator = 0; this.dropped = 0; this.limits = 0; this.pulseUntil = 0; this.pulseMode = -1; this.peakDisplacement = 0; this.maxDisplacement = 0; this.maxSpeed = 0; this.gradientBound = 0;
    this.tools = []; this.selectedTool = null; this.localScale = 1; this.localScales.clear();
    this.contactWeights = new WeakMap();
  }
  step(dt: number, breathing: boolean) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("Invalid physics time step.");
    // Admit up to twelve unchanged 120 Hz steps so 10–20 FPS rendering does not
    // slow the physical clock. Longer stalls remain bounded and explicitly lost.
    const admitted = Math.min(dt, MAX_FRAME_TIME); this.dropped += dt - admitted; this.accumulator += admitted;
    const localFieldNeeded = this.tools.length > 0;
    let integrated = false;
    while (this.accumulator + 1e-12 >= H) {
      this.integrate(breathing); this.time += H; this.accumulator -= H;
      // Local attachment forces read the projected shared field. Refresh that
      // physical state at H, independently of how substeps are batched for draw.
      if (localFieldNeeded) this.updateField();
      integrated = true;
    }
    if (!localFieldNeeded || !integrated) this.updateField();
  }
  private integrate(breathing: boolean) {
    this.integrateTools();
    const count = this.modes.length;
    const previous = this.modes.map(m => m.q.slice());
    const denominator = new Float64Array(count), rhs = new Float64Array(count * 3), branch = new Float64Array(count), decay = new Float64Array(count);
    const phase = breathing ? .5 - .5 * Math.cos(this.time * Math.PI * 2 / 4.8) : 0;
    this.modes.forEach((m, i) => {
      const damping = 2 * .65 * Math.sqrt(m.k * m.mass);
      decay[i] = Math.exp(-H / m.tau); branch[i] = m.k * m.fraction * m.tau * (1 - decay[i]!) / H;
      denominator[i] = m.mass / H ** 2 + damping / H + m.k * (1 - m.fraction) + branch[i]!;
      const amplitude = m.category === "respiratory" ? .0035 : m.category === "digestive" || m.category === "connective" ? .0017 : .0007;
      for (let a = 0; a < 3; a++) {
        const force = a === 1 ? -m.k * amplitude * phase : a === 2 ? m.k * amplitude * .35 * phase : 0;
        const pulse = i === this.pulseMode && this.time < this.pulseUntil && a === 2 ? -1.5 * Math.sin(Math.PI * (this.pulseUntil - this.time) / .35) : 0;
        // JᵀF uses the same interpolated basis as the displayed anchor. This
        // replaces an arbitrary 10% force transfer for registered anatomy.
        const localReaction = this.tools.reduce((sum, tool) => sum + tool.force[a]! * tool.coarseWeights[i]! * (this.componentScales.get(this.components[i]!) ?? 1), 0);
        rhs[i * 3 + a] = m.mass / H ** 2 * (m.q[a]! + H * m.v[a]!) + (damping / H + branch[i]!) * m.q[a]! - decay[i]! * m.memory[a]! + force + pulse + localReaction;
      }
    });
    for (const c of this.couplings) { denominator[c.a]! += c.k; denominator[c.b]! += c.k; }
    // Implicit positive-definite coupled linear system; mass dominates at 120 Hz.
    for (let sweep = 0; sweep < 7; sweep++) this.modes.forEach((m, i) => {
      for (let a = 0; a < 3; a++) {
        let coupled = 0;
        for (const c of this.couplings) { if (c.a === i) coupled += c.k * this.modes[c.b]!.q[a]!; else if (c.b === i) coupled += c.k * this.modes[c.a]!.q[a]!; }
        m.q[a] = m.response?.fixedGlobalSupport ? 0 : (rhs[3 * i + a]! + coupled) / denominator[i]!;
      }
    });
    this.maxSpeed = 0;
    this.modes.forEach((m, i) => {
      const norm = Math.hypot(...m.q);
      if (norm > .008) { for (let a = 0; a < 3; a++) m.q[a]! *= .008 / norm; this.limits++; }
      for (let a = 0; a < 3; a++) {
        const delta = m.q[a]! - previous[i]![a]!;
        m.memory[a] = decay[i]! * m.memory[a]! + branch[i]! * delta;
        m.v[a] = delta / H;
        if (!Number.isFinite(m.q[a]) || !Number.isFinite(m.v[a]) || !Number.isFinite(m.memory[a])) throw new Error("Physics state became non-finite; reset the scene.");
      }
      this.maxSpeed = Math.max(this.maxSpeed, Math.hypot(...m.v));
    });
    this.maxSpeed += this.tools.reduce((sum, tool) => sum + Math.hypot(...tool.v) * this.toolScale(tool), 0);
  }
  private integrateTools() {
    for (const tool of this.tools) {
      const previous = tool.q.slice(), decay = Math.exp(-H / tool.tau);
      const branch = tool.k * tool.fraction * tool.tau * (1 - decay) / H;
      const damping = 2 * tool.dampingRatio * Math.sqrt(tool.k * tool.mass);
      const denominator = tool.mass / H ** 2 + damping / H + tool.k * (1 - tool.fraction) + branch;
      const rhs = Array.from(tool.q, (q, a) => tool.mass / H ** 2 * (q + H * tool.v[a]!) + (damping / H + branch) * q - decay * tool.memory[a]!);
      const g = tool.anchorFactor * this.toolScale(tool);
      const anchor = this.toolAnchor(tool), target = tool.input.targetPointMm;
      let desired = target.map((v, a) => (v - anchor[a]!) * .001 + g * tool.q[a]!);
      const stiffness = 180 * (tool.input.strength ?? 1);
      const forceCap = 3 * (tool.input.strength ?? 1);
      const requested = desired.map((v, a) => v - g * tool.q[a]!);
      const requestLength = tool.input.mode === "push" ? Math.max(0, -requested.reduce((sum, v, a) => sum + v * tool.input.normal[a]!, 0)) : Math.hypot(...requested);
      if (requestLength * stiffness > forceCap) {
        const factor = forceCap / (requestLength * stiffness);
        desired = desired.map((_, a) => g * tool.q[a]! + requested[a]! * factor);
        tool.clamped = true; tool.limits++;
      }
      tool.force.fill(0);
      if (tool.active && tool.input.mode === "grasp") {
        for (let a = 0; a < 3; a++) tool.q[a] = (rhs[a]! + stiffness * g * desired[a]!) / (denominator + stiffness * g * g);
      } else if (tool.active) {
        const n = tool.input.normal, desiredNormal = desired.reduce((sum, v, a) => sum + v * n[a]!, 0);
        const free = rhs.map(v => v / denominator), freeNormal = free.reduce((sum, v, a) => sum + v * n[a]!, 0);
        const force = Math.min(0, stiffness * (desiredNormal - g * freeNormal) / (1 + stiffness * g * g / denominator));
        for (let a = 0; a < 3; a++) tool.q[a] = free[a]! + g * force * n[a]! / denominator;
      } else for (let a = 0; a < 3; a++) tool.q[a] = rhs[a]! / denominator;
      if (tool.cubic > 0) solveStrainStiffening(tool.q, rhs, denominator, tool.cubic, tool.active ? tool.input.mode : "none", stiffness, g, desired, tool.input.normal);
      const norm = Math.hypot(...tool.q), max = Math.min(tool.input.mode === "grasp" ? .018 : .010, tool.radius * .001 * .36 / 2.109375);
      if (norm > max) { for (let a = 0; a < 3; a++) tool.q[a]! *= max / norm; tool.clamped = true; tool.limits++; }
      if (tool.active) {
        let force = desired.map((v, a) => stiffness * (v - g * tool.q[a]!));
        if (tool.input.mode === "push") { const signed = Math.min(0, force.reduce((sum, v, a) => sum + v * tool.input.normal[a]!, 0)); force = tool.input.normal.map(v => signed * v); }
        const magnitude = Math.hypot(...force), cap = 3 * (tool.input.strength ?? 1);
        if (magnitude > cap) { force = force.map(v => v * cap / magnitude); tool.clamped = true; tool.limits++; }
        tool.force.set(force);
      }
      for (let a = 0; a < 3; a++) { const delta = tool.q[a]! - previous[a]!; tool.memory[a] = decay * tool.memory[a]! + branch * delta; tool.v[a] = delta / H; }
      if (![...tool.q, ...tool.v, ...tool.memory, ...tool.force].every(Number.isFinite)) throw new Error("Local contact state became non-finite.");
    }
    this.tools = this.tools.filter(tool => tool === this.selectedTool || tool.active || Math.hypot(...tool.q, ...tool.v, ...tool.memory) > 1e-8);
  }
  private updateField() {
    this.lattice.fill(0);
    for (const field of this.componentLattices.values()) field.fill(0);
    for (let id = 0; id < N; id++) for (let i = 0; i < this.modes.length; i++) {
      const w = this.weights[id * this.modes.length + i]! * 1000;
      for (let a = 0; a < 3; a++) {
        this.lattice[id * 3 + a]! += this.modes[i]!.q[a]! * w;
        if (this.componentWeights) this.componentLattices.get(this.components[i]!)![id * 3 + a]! += this.modes[i]!.q[a]! * this.componentWeights[id * this.modes.length + i]! * 1000;
      }
    }
    // Row-sum bound of the spatial displacement gradient. <1 protects orientation
    // for the shared interpolant. A .25 cap limits authored preview strain.
    const clampField = (field: Float64Array) => {
      const derivative = new Float64Array(9);
      for (let y = 0; y < NY; y++) for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
        const id = nodeId(x, y, z);
        const neighbors = [x < NX - 1 ? nodeId(x + 1, y, z) : -1, y < NY - 1 ? nodeId(x, y + 1, z) : -1, z < NZ - 1 ? nodeId(x, y, z + 1) : -1];
        for (let direction = 0; direction < 3; direction++) if (neighbors[direction]! >= 0) for (let a = 0; a < 3; a++) derivative[a * 3 + direction] = Math.max(derivative[a * 3 + direction]!, Math.abs(field[neighbors[direction]! * 3 + a]! - field[id * 3 + a]!) / this.spacing[direction]!);
      }
      const bound = Math.max(...[0, 1, 2].map(a => derivative[a * 3]! + derivative[a * 3 + 1]! + derivative[a * 3 + 2]!));
      const scale = bound > .25 ? .25 / bound : 1;
      if (scale < 1) { for (let i = 0; i < field.length; i++) field[i]! *= scale; this.limits++; }
      return { bound: Math.min(bound, .25), scale };
    };
    let sharedBound = clampField(this.lattice).bound;
    const componentBounds = new Map<number, number>();
    for (const [component, field] of this.componentLattices) {
      const result = clampField(field); this.componentScales.set(component, result.scale); componentBounds.set(component, result.bound);
      sharedBound = Math.max(sharedBound, result.bound);
    }
    // Wendland C2 |d phi/dr| <= 2.109375/R. This sum is a conservative
    // infinity-norm derivative bound for the superposed continuous local fields.
    const localDerivative = (tool: LocalToolMode) => Math.max(...Array.from(tool.q, Math.abs)) * 1000 * 2.109375 * Math.sqrt(3) / tool.radius;
    const localBound = this.tools.reduce((sum, tool) => sum + localDerivative(tool), 0);
    this.localScale = localBound > 0 ? Math.min(1, Math.max(0, .45 - sharedBound) / localBound) : 1;
    if (this.localScale < 1) this.limits++;
    this.gradientBound = sharedBound + localBound * this.localScale;
    if (this.anatomicalAttachments) {
      this.gradientBound = 0;
      for (const [component, bound] of componentBounds) {
        const local = this.tools.reduce((sum, tool) => sum + (this.components[tool.materialMode] === component ? localDerivative(tool) : 0), 0);
        const scale = local > 0 ? Math.min(1, Math.max(0, .45 - bound) / local) : 1;
        this.localScales.set(component, scale);
        this.gradientBound = Math.max(this.gradientBound, bound + local * scale);
      }
    }
    this.maxDisplacement = 0;
    for (let i = 0; i < N; i++) this.maxDisplacement = Math.max(this.maxDisplacement, Math.hypot(this.lattice[i * 3]!, this.lattice[i * 3 + 1]!, this.lattice[i * 3 + 2]!));
    for (const field of this.componentLattices.values()) for (let i = 0; i < N; i++) this.maxDisplacement = Math.max(this.maxDisplacement, Math.hypot(field[i * 3]!, field[i * 3 + 1]!, field[i * 3 + 2]!));
    for (const tool of this.tools) this.maxDisplacement = Math.max(this.maxDisplacement, Math.hypot(...this.samplePoint(tool.input.restPointMm, tool.input.organId).map((v, a) => v - tool.input.restPointMm[a]!)));
    for (const tool of this.tools) {
      if (!tool.active) { tool.force.fill(0); continue; }
      const anchor = this.toolAnchor(tool), stiffness = 180 * (tool.input.strength ?? 1);
      let force = tool.input.targetPointMm.map((v, a) => stiffness * .001 * (v - anchor[a]!));
      if (tool.input.mode === "push") { const normal = tool.input.normal, signed = Math.min(0, force.reduce((sum, v, a) => sum + v * normal[a]!, 0)); force = normal.map(v => signed * v); }
      const magnitude = Math.hypot(...force), cap = 3 * (tool.input.strength ?? 1);
      tool.force.set(force.map(v => v * Math.min(1, cap / Math.max(magnitude, 1e-12))));
    }
    this.peakDisplacement = Math.max(this.peakDisplacement, this.maxDisplacement);
  }
  private storedEnergy() {
    let energy = 0;
    for (const mode of [...this.modes, ...this.tools]) {
      const q2 = mode.q.reduce((sum, q) => sum + q * q, 0);
      energy += .5 * mode.k * (1 - mode.fraction) * q2;
      energy += mode.memory.reduce((sum, force) => sum + force * force, 0) / (2 * mode.k * mode.fraction);
      energy += .5 * mode.mass * mode.v.reduce((sum, speed) => sum + speed * speed, 0);
      if ("cubic" in mode) energy += .25 * mode.cubic * q2 * q2;
    }
    for (const edge of this.couplings) energy += .5 * edge.k * this.modes[edge.a]!.q.reduce((sum, value, axis) => sum + (value - this.modes[edge.b]!.q[axis]!) ** 2, 0);
    return energy;
  }
  snapshot() {
    return { solver: "coupled-modal-SLS-anatomical-contact-3.0.0", scope: "Synthetic material estimates; authored supports, registered attachment coupling, local strain stiffening and tool compliance. Triangle tool contact is separate; no resolved organ-organ collision, fluid pressure, cutting or validated surgical mechanics.",
      contact_topology: this.anatomicalAttachments ? "registered attachment components; no proximity adhesion" : "legacy shared spatial atlas field",
      attachment_edges: this.anatomicalAttachments ?? null,
      attachment_components: this.anatomicalAttachments ? [...new Set(this.components)].map(component => this.modes.filter((_, i) => this.components[i] === component).map(m => m.id)) : null,
      stored_energy_j: this.storedEnergy(), energy_scope: "Reduced modal elastic, Maxwell-branch and kinetic energy; excludes virtual tool and projection work, not tissue strain-energy validation.",
      model_id: this.modelId, time_s: this.time, fixed_step_s: H, dropped_time_s: this.dropped, displacement_mm: this.maxDisplacement, peak_displacement_mm: this.peakDisplacement, maximum_speed_m_s: this.maxSpeed, speed_scope: "Sum bound of coarse modal and local modal velocities; excludes repositioning of a sliding pressure footprint and projection-scale changes.", maximum_local_mode_speed_m_s: this.tools.reduce((sum, tool) => sum + Math.hypot(...tool.v) * this.toolScale(tool), 0), displacement_gradient_bound: this.gradientBound, stabilization_count: this.limits,
      finite: this.modes.every(m => [...m.q, ...m.v, ...m.memory].every(Number.isFinite)) && this.tools.every(m => [...m.q, ...m.v, ...m.memory].every(Number.isFinite)), tool: this.toolSnapshot(), local_modes: this.tools.length,
      organs: this.modes.map(m => ({ id: m.id, parameters: m.material, response: m.response ?? null, response_provenance: m.response ? "authored nonlinear extension; not inverse-fit or patient calibrated" : "linear SLS", displacement_mm: Array.from(m.q, q => q * 1000), mass_kg: m.mass, effective_stiffness_n_m: m.k })),
    };
  }
}
