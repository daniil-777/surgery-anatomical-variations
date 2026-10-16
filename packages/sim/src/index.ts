/** SI tetrahedral XPBD interaction model. This is a heuristic preview,
 * not an implementation of the planned SNH VBD tissue solver. */
export interface TetModel {
  positions_mm: number[];
  tets: number[];
  pinned_nodes?: number[];
  density_kg_m3?: number;
}
export interface SolverOptions {
  youngPa: number;
  poisson: number;
  dampingRatio: number;
  iterations: number;
  gravity: readonly [number, number, number];
}
type Edge = {
  i: number;
  j: number;
  length: number;
  compliance: number;
  stiffness: number;
};
type Tet = {
  ids: readonly [number, number, number, number];
  volume: number;
  compliance: number;
};
type Vec = [number, number, number];
type GrabState = { ids: number[]; weights: number[]; targets: Vec[] };
export interface PreviewSnapshot {
  version: 1;
  modelKey: string;
  positions: number[];
  velocities: number[];
  time: number;
  rejectedSteps: number;
  grabbed: GrabState | null;
}
const copyGrab = (grab: GrabState | null): GrabState | null =>
  grab
    ? {
        ids: [...grab.ids],
        weights: [...grab.weights],
        targets: grab.targets.map((target) => [...target] as Vec),
      }
    : null;
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec) => Math.sqrt(dot(a, a));
const point = (x: Float64Array, i: number): Vec => [
  x[3 * i]!,
  x[3 * i + 1]!,
  x[3 * i + 2]!,
];
function volume(x: Float64Array, ids: readonly number[]): number {
  const x0 = point(x, ids[0]!);
  return (
    dot(
      sub(point(x, ids[1]!), x0),
      cross(sub(point(x, ids[2]!), x0), sub(point(x, ids[3]!), x0)),
    ) / 6
  );
}

export class TetPreview {
  readonly reference: Float64Array;
  readonly positions: Float64Array;
  readonly velocities: Float64Array;
  readonly inverseMass: Float64Array;
  readonly masses: Float64Array;
  readonly tets: Tet[] = [];
  readonly edges: Edge[] = [];
  readonly options: Readonly<SolverOptions>;
  rejectedSteps = 0;
  time = 0;
  private grabbed: GrabState | null = null;
  private readonly modelKey: string;

  constructor(model: TetModel, options: Partial<SolverOptions> = {}) {
    this.options = Object.freeze({
      youngPa: 6000,
      poisson: 0.45,
      dampingRatio: 0.12,
      iterations: 8,
      ...options,
      gravity: Object.freeze([...(options.gravity ?? [0, 0, 0])]) as readonly [
        number,
        number,
        number,
      ],
    });
    const { youngPa, poisson, dampingRatio, iterations } = this.options;
    if (
      !(
        Number.isFinite(youngPa) &&
        youngPa > 0 &&
        poisson >= 0 &&
        poisson < 0.4999 &&
        dampingRatio >= 0 &&
        dampingRatio <= 1 &&
        Number.isInteger(iterations) &&
        iterations >= 1 &&
        iterations <= 80
      ) ||
      this.options.gravity.length !== 3 ||
      !this.options.gravity.every(Number.isFinite)
    )
      throw new Error("Unsupported solver parameters");
    if (
      model.positions_mm.length % 3 ||
      model.tets.length % 4 ||
      model.positions_mm.length < 12 ||
      !model.positions_mm.every(Number.isFinite)
    )
      throw new Error("Invalid tetrahedral model");
    this.reference = Float64Array.from(model.positions_mm, (v) => v * 0.001);
    this.positions = this.reference.slice();
    this.velocities = new Float64Array(this.positions.length);
    this.masses = new Float64Array(this.positions.length / 3);
    this.inverseMass = new Float64Array(this.masses.length);
    const edgeVolumes = new Map<
      string,
      { i: number; j: number; volume: number }
    >();
    const bulk = youngPa / (3 * (1 - 2 * poisson));
    if (!Number.isFinite(bulk) || bulk <= 0)
      throw new Error("Unsupported numerical stiffness scale");
    const density = model.density_kg_m3 ?? 1060;
    if (!(density > 0 && Number.isFinite(density)))
      throw new Error("Invalid density");
    for (let t = 0; t < model.tets.length; t += 4) {
      const ids = model.tets.slice(t, t + 4) as [
        number,
        number,
        number,
        number,
      ];
      if (
        !ids.every(
          (i) => Number.isInteger(i) && i >= 0 && i < this.masses.length,
        ) ||
        new Set(ids).size !== 4
      )
        throw new Error("Invalid tet index");
      const v = volume(this.reference, ids);
      if (!(v > 1e-15) || !Number.isFinite(v))
        throw new Error("Inverted or degenerate reference tet");
      this.tets.push({ ids, volume: v, compliance: v / bulk });
      for (const i of ids) this.masses[i] = this.masses[i]! + (density * v) / 4;
      for (let a = 0; a < 4; a++)
        for (let b = a + 1; b < 4; b++) {
          const i = Math.min(ids[a]!, ids[b]!);
          const j = Math.max(ids[a]!, ids[b]!);
          const key = `${i}:${j}`;
          const item = edgeVolumes.get(key) ?? { i, j, volume: 0 };
          item.volume += v / 6;
          edgeVolumes.set(key, item);
        }
    }
    const pins = new Set(model.pinned_nodes ?? []);
    if (
      [...pins].some(
        (i) => i < 0 || i >= this.masses.length || !Number.isInteger(i),
      )
    )
      throw new Error("Invalid attachment index");
    this.masses.forEach((mass, i) => {
      if (!(mass > 0) || !Number.isFinite(mass) || !Number.isFinite(1 / mass))
        throw new Error("Unconnected node or unsupported numerical mass scale");
      this.inverseMass[i] = pins.has(i) ? 0 : 1 / mass;
    });
    for (const edge of edgeVolumes.values()) {
      const length = norm(
        sub(point(this.reference, edge.j), point(this.reference, edge.i)),
      );
      const stiffness = (youngPa * edge.volume) / (length * length);
      if (
        !(stiffness > 0) ||
        !Number.isFinite(stiffness) ||
        !Number.isFinite(1 / stiffness)
      )
        throw new Error("Unsupported numerical stiffness scale");
      this.edges.push({
        i: edge.i,
        j: edge.j,
        length,
        stiffness,
        compliance: 1 / stiffness,
      });
    }
    // Exact construction identity, not a lossy or security-sensitive hash.
    this.modelKey = JSON.stringify({
      positions: Array.from(this.reference),
      tets: this.tets.map((t) => t.ids),
      pins: [...pins].sort((a, b) => a - b),
      density,
      options: this.options,
    });
  }

  reset() {
    this.positions.set(this.reference);
    this.velocities.fill(0);
    this.grabbed = null;
    this.time = 0;
    this.rejectedSteps = 0;
  }
  /** Complete replay state, including an active interaction and rejection history. */
  snapshot(): PreviewSnapshot {
    return {
      version: 1,
      modelKey: this.modelKey,
      positions: Array.from(this.positions),
      velocities: Array.from(this.velocities),
      time: this.time,
      rejectedSteps: this.rejectedSteps,
      grabbed: copyGrab(this.grabbed),
    };
  }
  /** Restore atomically only onto the same reference mesh, supports and solver. */
  restore(state: PreviewSnapshot) {
    if (
      state.version !== 1 ||
      state.modelKey !== this.modelKey ||
      !Number.isSafeInteger(state.rejectedSteps) ||
      state.rejectedSteps < 0 ||
      !Number.isFinite(state.time) ||
      state.time < 0 ||
      state.positions.length !== this.positions.length ||
      state.velocities.length !== this.velocities.length ||
      !state.positions.every(Number.isFinite) ||
      !state.velocities.every(Number.isFinite)
    )
      throw new Error("Incompatible state");
    const candidate = Float64Array.from(state.positions);
    if (
      this.tets.some((t) => {
        const ratio = volume(candidate, t.ids) / t.volume;
        return !Number.isFinite(ratio) || ratio < 0.15;
      })
    )
      throw new Error("Invalid saved state");
    for (let i = 0; i < this.masses.length; i++)
      if (this.inverseMass[i] === 0)
        for (let k = 0; k < 3; k++)
          if (
            candidate[3 * i + k] !== this.reference[3 * i + k] ||
            state.velocities[3 * i + k] !== 0
          )
            throw new Error("Saved state violates fixed attachments");
    const grab = state.grabbed;
    if (
      grab &&
      (grab.ids.length !== grab.weights.length ||
        grab.ids.length !== grab.targets.length ||
        new Set(grab.ids).size !== grab.ids.length ||
        grab.ids.some(
          (id) =>
            !Number.isInteger(id) ||
            id < 0 ||
            id >= this.masses.length ||
            this.inverseMass[id] === 0,
        ) ||
        grab.weights.some((w) => !Number.isFinite(w) || w <= 0 || w > 1) ||
        grab.targets.some(
          (target) => target.length !== 3 || !target.every(Number.isFinite),
        ))
    )
      throw new Error("Invalid saved interaction");
    this.positions.set(candidate);
    this.velocities.set(state.velocities);
    this.time = state.time;
    this.rejectedSteps = state.rejectedSteps;
    this.grabbed = copyGrab(grab);
  }

  /** Distributed positional interaction; it is not a sphere-contact force test. */
  grab(
    centerMm: readonly number[],
    radiusMm: number,
    deltaMm: readonly number[],
  ) {
    if (
      !(Number.isFinite(radiusMm) && radiusMm > 0) ||
      centerMm.length !== 3 ||
      deltaMm.length !== 3 ||
      !centerMm.every(Number.isFinite) ||
      !deltaMm.every(Number.isFinite)
    )
      throw new Error("Invalid grab");
    const center: Vec = [
      centerMm[0]! * 0.001,
      centerMm[1]! * 0.001,
      centerMm[2]! * 0.001,
    ];
    const radius = radiusMm * 0.001;
    const ids: number[] = [];
    const weights: number[] = [];
    const targets: Vec[] = [];
    for (let i = 0; i < this.masses.length; i++) {
      const x = point(this.reference, i);
      const d = norm(sub(x, center));
      if (d >= radius || this.inverseMass[i] === 0) continue;
      const w = (1 - (d / radius) ** 2) ** 2;
      ids.push(i);
      weights.push(w);
      targets.push([
        x[0] + deltaMm[0]! * 0.001 * w,
        x[1] + deltaMm[1]! * 0.001 * w,
        x[2] + deltaMm[2]! * 0.001 * w,
      ]);
    }
    this.grabbed = { ids, weights, targets };
  }
  release() {
    this.grabbed = null;
  }

  step(h = 1 / 120): boolean {
    if (!(h > 0 && h <= 1 / 30))
      throw new Error("Use a physical timestep in (0,1/30] seconds");
    const before = this.positions.slice();
    const oldVelocity = this.velocities.slice();
    for (let i = 0; i < this.masses.length; i++)
      for (let k = 0; k < 3; k++) {
        if (!this.inverseMass[i]) continue;
        const index = i * 3 + k;
        this.velocities[index] =
          this.velocities[index]! + this.options.gravity[k]! * h;
        this.positions[index] =
          this.positions[index]! + this.velocities[index]! * h;
      }
    const edgeLambda = new Float64Array(this.edges.length);
    const volumeLambda = new Float64Array(this.tets.length);
    for (let iteration = 0; iteration < this.options.iterations; iteration++) {
      this.edges.forEach((edge, e) => {
        const d = sub(
          point(this.positions, edge.j),
          point(this.positions, edge.i),
        );
        const length = norm(d);
        if (length < 1e-12) return;
        const wi = this.inverseMass[edge.i]!;
        const wj = this.inverseMass[edge.j]!;
        const alpha = edge.compliance / (h * h);
        const change =
          (-(length - edge.length) - alpha * edgeLambda[e]!) /
          (wi + wj + alpha);
        edgeLambda[e] = edgeLambda[e]! + change;
        for (let k = 0; k < 3; k++) {
          const delta = (change * d[k]!) / length;
          this.positions[edge.i * 3 + k] =
            this.positions[edge.i * 3 + k]! - wi * delta;
          this.positions[edge.j * 3 + k] =
            this.positions[edge.j * 3 + k]! + wj * delta;
        }
      });
      this.tets.forEach((tet, t) => {
        const x0 = point(this.positions, tet.ids[0]);
        const a = sub(point(this.positions, tet.ids[1]), x0),
          b = sub(point(this.positions, tet.ids[2]), x0),
          c = sub(point(this.positions, tet.ids[3]), x0);
        const g1 = cross(b, c).map((v) => v / 6) as Vec;
        const g2 = cross(c, a).map((v) => v / 6) as Vec;
        const g3 = cross(a, b).map((v) => v / 6) as Vec;
        const gradients: Vec[] = [
          [
            -g1[0] - g2[0] - g3[0],
            -g1[1] - g2[1] - g3[1],
            -g1[2] - g2[2] - g3[2],
          ],
          g1,
          g2,
          g3,
        ];
        const alpha = tet.compliance / (h * h);
        let denominator = alpha;
        for (let a = 0; a < 4; a++)
          denominator +=
            this.inverseMass[tet.ids[a]!]! * dot(gradients[a]!, gradients[a]!);
        if (denominator <= 0) return;
        const change =
          (-(dot(a, cross(b, c)) / 6 - tet.volume) - alpha * volumeLambda[t]!) /
          denominator;
        volumeLambda[t] = volumeLambda[t]! + change;
        for (let a = 0; a < 4; a++)
          for (let k = 0; k < 3; k++) {
            const i = tet.ids[a]!;
            this.positions[3 * i + k] =
              this.positions[3 * i + k]! +
              this.inverseMass[i]! * change * gradients[a]![k]!;
          }
      });
      if (this.grabbed)
        this.grabbed.ids.forEach((id, j) => {
          const strength = 0.35 * this.grabbed!.weights[j]!;
          for (let k = 0; k < 3; k++) {
            const index = 3 * id + k;
            this.positions[index] =
              this.positions[index]! +
              strength *
                (this.grabbed!.targets[j]![k]! - this.positions[index]!);
          }
        });
    }
    if (
      !this.positions.every(Number.isFinite) ||
      this.tets.some((t) => {
        const ratio = volume(this.positions, t.ids) / t.volume;
        return !Number.isFinite(ratio) || ratio < 0.15;
      })
    ) {
      this.positions.set(before);
      this.velocities.set(oldVelocity);
      this.rejectedSteps++;
      return false;
    }
    for (let i = 0; i < this.positions.length; i++)
      this.velocities[i] = (this.positions[i]! - before[i]!) / h;
    // Pairwise central damping acts on relative extension rate, preserving free rigid translation.
    for (const edge of this.edges) {
      const wi = this.inverseMass[edge.i]!;
      const wj = this.inverseMass[edge.j]!;
      const sum = wi + wj;
      if (!sum) continue;
      const d = sub(
        point(this.positions, edge.j),
        point(this.positions, edge.i),
      );
      const length = norm(d);
      if (length < 1e-12) continue;
      const n = d.map((v) => v / length) as Vec;
      const rate = dot(
        sub(point(this.velocities, edge.j), point(this.velocities, edge.i)),
        n,
      );
      const damping =
        2 * this.options.dampingRatio * Math.sqrt(edge.stiffness / sum);
      const impulse = (damping * rate * h) / (1 + damping * h * sum);
      for (let k = 0; k < 3; k++) {
        this.velocities[3 * edge.i + k] =
          this.velocities[3 * edge.i + k]! + wi * impulse * n[k]!;
        this.velocities[3 * edge.j + k] =
          this.velocities[3 * edge.j + k]! - wj * impulse * n[k]!;
      }
    }
    if (!this.velocities.every(Number.isFinite)) {
      this.positions.set(before);
      this.velocities.set(oldVelocity);
      this.rejectedSteps++;
      return false;
    }
    this.time += h;
    return true;
  }

  metrics() {
    const rest = this.tets.reduce((sum, t) => sum + t.volume, 0);
    const current = this.tets.reduce(
      (sum, t) => sum + volume(this.positions, t.ids),
      0,
    );
    return {
      volume_ml: current * 1e6,
      volumeDrift: (current - rest) / rest,
      minJacobian: Math.min(
        ...this.tets.map((t) => volume(this.positions, t.ids) / t.volume),
      ),
      rejectedSteps: this.rejectedSteps,
      time: this.time,
    };
  }
}

export interface SurfaceEmbedding {
  tet_ids: number[];
  weights: number[];
  residuals_mm: number[];
}
/** Precompute affine-consistent effective weights, including exterior residuals. */
export function effectiveWeights(
  model: TetModel,
  mapping: SurfaceEmbedding,
): Float64Array {
  if (
    mapping.weights.length !== mapping.tet_ids.length * 4 ||
    mapping.residuals_mm.length !== mapping.tet_ids.length * 3
  )
    throw new Error("Invalid embedding");
  const x = Float64Array.from(model.positions_mm);
  const result = Float64Array.from(mapping.weights);
  mapping.tet_ids.forEach((t, v) => {
    if (!Number.isInteger(t) || t < 0 || 4 * t + 3 >= model.tets.length)
      throw new Error("Invalid embedding tet");
    const ids = model.tets.slice(4 * t, 4 * t + 4);
    const x0 = point(x, ids[0]!);
    const a = sub(point(x, ids[1]!), x0),
      b = sub(point(x, ids[2]!), x0),
      c = sub(point(x, ids[3]!), x0);
    const r: Vec = [
      mapping.residuals_mm[3 * v]!,
      mapping.residuals_mm[3 * v + 1]!,
      mapping.residuals_mm[3 * v + 2]!,
    ];
    const det = dot(a, cross(b, c));
    if (!(det > 0)) throw new Error("Invalid reference embedding frame");
    const beta = [
      dot(r, cross(b, c)) / det,
      dot(a, cross(r, c)) / det,
      dot(a, cross(b, r)) / det,
    ];
    result[4 * v] = result[4 * v]! - beta[0]! - beta[1]! - beta[2]!;
    for (let k = 0; k < 3; k++)
      result[4 * v + k + 1] = result[4 * v + k + 1]! + beta[k]!;
    const sum =
      result[4 * v]! +
      result[4 * v + 1]! +
      result[4 * v + 2]! +
      result[4 * v + 3]!;
    if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-4)
      throw new Error("Embedding weights must sum to one");
  });
  return result;
}
export function embeddedPositionsMm(
  model: TetModel,
  tetIds: number[],
  weights: Float64Array,
  positionsSi: Float64Array,
): Float32Array {
  const result = new Float32Array(tetIds.length * 3);
  tetIds.forEach((t, v) => {
    for (let a = 0; a < 4; a++) {
      const id = model.tets[t * 4 + a]!;
      for (let k = 0; k < 3; k++)
        result[3 * v + k] =
          result[3 * v + k]! +
          weights[4 * v + a]! * positionsSi[3 * id + k]! * 1000;
    }
  });
  return result;
}
