/** Finite, oriented surface incisions. This is deliberately separate from the
 * prepared volumetric FEM experiment: it changes actual surface topology and
 * relaxes an uncalibrated supported membrane, not a validated liver volume. */
type V3 = [number, number, number];
type Q4 = [number, number, number, number];
export interface ScissorsSurfaceInput {
  positionsMm: ArrayLike<number>; indices: ArrayLike<number>; colors: ArrayLike<number>;
}
export interface ScissorsSnip {
  positionMm: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
  /** TOTAL jaw aperture. A completed closing stroke is required. */
  openingRadians: number; closingRadians: number;
  lengthMm?: number; activeStartMm?: number;
  /** Visual wall depth only; the actual radial jaw sweep determines capture. */
  depthMm?: number;
}
export interface ScissorsSurfaceGeometry {
  /** Views owned by the engine. Consumers may read but must not mutate them. */
  positionsMm: Float32Array; restPositionsMm: Float32Array; colors: Float32Array;
  indices: Uint32Array; wallIndices: Uint32Array;
  revision: number; positionRevision: number;
}
export interface ScissorsSnipResult {
  changed: boolean; cutSegments: number; reason: 'cut' | 'miss' | 'opening' | 'already-cut';
}
export interface ScissorsToolInteraction {
  positionMm: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
  openingRadians: number;
  lengthMm?: number;
  activeStartMm?: number;
  insertionDepthMm?: number;
  phase: 'closing' | 'opening' | 'contact';
  intensity: number;
}
export interface ScissorsMaterialParameters {
  youngPa: number;
  relaxationFraction?: number;
  relaxationTimeS?: number;
  fractureEnergyJm2: number;
  peakTractionPa: number;
}
export const SCISSORS_SURFACE_PROVENANCE = Object.freeze({
  model: 'finite-oriented-surface-incision-with-supported-prestressed-membrane',
  volumetric: false, learnedCuttingMechanics: false, humanTissueValidated: false,
  cutRule: 'completed jaw closure; finite radial blade sector; actual surface topology split',
  deformation: 'anisotropic morphoelastic capsule-release shell with dihedral bending, geodesic 3D lobe coupling, rim eversion, rest support and viscoelastic damping',
  wallScope: 'manifold-oriented finite-depth parenchymal V-trench walls; no removed volume or volumetric fracture energy',
  limits: 'Existing source boundaries remain open. Thin-shell response, wound-wall intersections and tissue forces are not surgical validation.',
});
export const SCISSORS_SHELL_PARAMETERS = Object.freeze({
  pretensionFraction: .08, edgeStiffnessNPerM: 38, bendingStiffnessNPerM: 7.5, supportStiffnessNPerM: .92,
  dampingPerSecond: 22, thicknessM: .002, densityKgM3: 1060,
  maximumSubstepSeconds: 1 / 120, projectionIterations: 10,
  retractionLipMm: 2.05, eversionLipMm: .46, lobeDecayMm: 16, recoilVelocityMmS: 24,
});

interface Node { rest: V3; position: V3; velocity: V3; color: V3; active: boolean; target: V3; supportScale: number }
interface EdgePoint { t: number; id: number }
interface Segment { start: number; end: number; normal: V3; depth: number }
interface Spring { a: number; b: number; lengthM: number; lambda: number; stiffness: number }
interface Wall { a: number; b: number; depth: number; normal: V3 }
interface FaceCut { polygon: number[]; line: number[]; signs: number[]; segments: Segment[] }
const EPS = 1e-7, MAX_NODES = 150000, MAX_TRIANGLES = 300000;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (v: V3) => Math.hypot(...v);
const normalized = (v: V3): V3 => { const n = length(v); return n > 0 ? mul(v, 1 / n) : [0, 1, 0]; };
const lerp = (a: V3, b: V3, t: number): V3 => add(mul(a, 1 - t), mul(b, t));
const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
const pointKey = (v: V3) => v.map(x => Math.round(x * 1e8)).join(':');
const copyNode = (node: Node): Node => ({ rest: [...node.rest], position: [...node.position], velocity: [...node.velocity], color: [...node.color], active: node.active, target: [...node.target], supportScale: node.supportScale });
const interpolateNode = (a: Node, b: Node, t: number): Node => ({ rest: lerp(a.rest, b.rest, t), position: lerp(a.position, b.position, t), velocity: lerp(a.velocity, b.velocity, t), color: lerp(a.color, b.color, t), active: a.active || b.active, target: lerp(a.target, b.target, t), supportScale: a.supportScale * (1 - t) + b.supportScale * t });
function rotate(v: V3, q: Q4): V3 {
  const u: V3 = [q[0], q[1], q[2]], t = mul(cross(u, v), 2);
  return add(v, add(mul(t, q[3]), cross(u, t)));
}
function validatedStroke(input: ScissorsSnip) {
  const origin = Array.from(input.positionMm), quaternion = Array.from(input.quaternion);
  const bladeLength = input.lengthMm ?? 18, start = input.activeStartMm ?? 2.5, depth = input.depthMm ?? 4;
  if (origin.length !== 3 || quaternion.length !== 4 || ![...origin, ...quaternion, input.openingRadians, input.closingRadians, bladeLength, start, depth].every(Number.isFinite)
    || input.openingRadians < 0 || input.openingRadians > Math.PI / 2 || input.closingRadians < 0 || input.closingRadians > Math.PI / 2
    || start < 0 || bladeLength <= start || bladeLength > 50 || depth <= 0 || depth > 20) throw new Error('Invalid finite scissors stroke');
  const norm = Math.hypot(...quaternion);
  if (!(norm > 1e-12) || !Number.isFinite(norm)) throw new Error('A finite nonzero scissors quaternion is required');
  const q = quaternion.map(v => v / norm) as Q4;
  // q and -q describe exactly the same orientation and closure identity.
  if (q[3] < 0 || (q[3] === 0 && (q[0] || q[1] || q[2]) < 0)) for (let i = 0; i < 4; i++) q[i]! *= -1;
  const inverse: Q4 = [-q[0], -q[1], -q[2], q[3]], position = origin as V3;
  const local = (p: V3) => rotate(sub(p, position), inverse);
  const slope = Math.tan(input.openingRadians / 2);
  const key = [...position, ...q, input.openingRadians, bladeLength, start].map(v => v.toFixed(7)).join(':');
  return { position, q, local, slope, bladeLength, start, depth, key };
}

/** Clip a line segment to the true radial tip sweep and a conservative hinge
 * exclusion. Unlike a rectangular wedge, this never cuts beyond the jaw tip. */
function sweptInterval(a: V3, b: V3, shape: ReturnType<typeof validatedStroke>): [number, number] | null {
  let lo = 0, hi = 1;
  const clip = (at: number, end: number) => {
    if (at < 0 && end < 0) return false;
    if (at < 0) lo = Math.max(lo, at / (at - end));
    else if (end < 0) hi = Math.min(hi, at / (at - end));
    return lo <= hi;
  };
  if (!clip(a[2] - shape.start, b[2] - shape.start)
    || !clip(shape.slope * a[2] - a[1], shape.slope * b[2] - b[1])
    || !clip(shape.slope * a[2] + a[1], shape.slope * b[2] + b[1])) return null;
  const dy = b[1] - a[1], dz = b[2] - a[2], A = dy * dy + dz * dz;
  const B = 2 * (a[1] * dy + a[2] * dz), C = a[1] ** 2 + a[2] ** 2 - shape.bladeLength ** 2;
  if (A < 1e-24) { if (C > 0) return null; }
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    lo = Math.max(lo, (-B - Math.sqrt(disc)) / (2 * A));
    hi = Math.min(hi, (-B + Math.sqrt(disc)) / (2 * A));
  }
  return hi - lo > 1e-8 ? [lo, hi] : null;
}
function strictlyInside(p: V3, shape: ReturnType<typeof validatedStroke>) {
  return p[2] > shape.start + EPS && shape.slope * p[2] - Math.abs(p[1]) > EPS
    && shape.bladeLength - Math.hypot(p[1], p[2]) > EPS;
}

export class ScissorsSurfaceEngine {
  private nodes: Node[];
  private faces: number[][];
  private readonly initialNodes: Node[];
  private readonly initialFaces: number[][];
  private readonly originalBoundaryEdges: number;
  private woundEdges = new Map<string, Wall>();
  private strokes = new Set<string>();
  private cutCount = 0;
  private cutSegments = 0;
  private springs: Spring[] = [];
  private inverseMass = new Float64Array();
  private activeNodes: number[] = [];
  private wallGroups = new Map<string, number[]>();
  private walls: Wall[] = [];
  private toolInteraction: ScissorsToolInteraction | null = null;
  private shell: Record<keyof typeof SCISSORS_SHELL_PARAMETERS, number> = { ...SCISSORS_SHELL_PARAMETERS };
  private view: ScissorsSurfaceGeometry;

  constructor(input: ScissorsSurfaceInput) {
    if (!input.positionsMm.length || input.positionsMm.length % 3 || input.colors.length !== input.positionsMm.length || input.indices.length % 3
      || input.positionsMm.length / 3 > MAX_NODES || input.indices.length / 3 > MAX_TRIANGLES) throw new Error('Invalid scissors surface layout');
    const positions = Array.from(input.positionsMm), colors = Array.from(input.colors), indices = Array.from(input.indices);
    if (![...positions, ...colors].every(Number.isFinite) || indices.some(id => !Number.isInteger(id) || id < 0 || id * 3 + 2 >= positions.length)) throw new Error('Finite surface positions, colors and valid triangle indices required');
    this.nodes = []; this.faces = [];
    const welded = new Map<string, number>(), remap = new Uint32Array(positions.length / 3);
    for (let i = 0; i < remap.length; i++) {
      const point = positions.slice(3 * i, 3 * i + 3) as V3, key = pointKey(point);
      let id = welded.get(key);
      if (id === undefined) {
        id = this.nodes.length; welded.set(key, id);
        this.nodes.push({ rest: point, position: [...point], velocity: [0, 0, 0], color: colors.slice(3 * i, 3 * i + 3) as V3, active: false, target: [...point], supportScale: 1 });
      } else if (length(sub(this.nodes[id]!.rest, point)) > 2e-8) throw new Error('Ambiguous initial surface weld');
      remap[i] = id;
    }
    for (let i = 0; i < indices.length; i += 3) {
      const face = indices.slice(i, i + 3).map(id => remap[id]!);
      if (new Set(face).size !== 3 || this.area(face, this.nodes) <= 1e-12) throw new Error('Nondegenerate source triangles required');
      this.faces.push(face);
    }
    this.originalBoundaryEdges = this.boundaries(this.faces).size;
    this.initialNodes = this.nodes.map(copyNode); this.initialFaces = this.faces.map(face => [...face]);
    this.view = { positionsMm: new Float32Array(), restPositionsMm: new Float32Array(), colors: new Float32Array(), indices: new Uint32Array(), wallIndices: new Uint32Array(), revision: 0, positionRevision: 0 };
    this.rebuildGeometry();
  }

  private area(face: number[], nodes: Node[]) { return .5 * length(cross(sub(nodes[face[1]!]!.rest, nodes[face[0]!]!.rest), sub(nodes[face[2]!]!.rest, nodes[face[0]!]!.rest))); }
  private boundaries(faces: number[][]) {
    const edges = new Map<string, { a: number; b: number; count: number }>();
    for (const face of faces) for (let j = 0; j < 3; j++) {
      const a = face[j]!, b = face[(j + 1) % 3]!, key = edgeKey(a, b), existing = edges.get(key);
      if (existing) existing.count++; else edges.set(key, { a, b, count: 1 });
    }
    if ([...edges.values()].some(edge => edge.count > 2)) throw new Error('Surface has nonmanifold edges');
    return new Map([...edges].filter(([, edge]) => edge.count === 1));
  }

  setToolInteraction(interaction: ScissorsToolInteraction | null): void {
    if (interaction === null) {
      if (!this.toolInteraction) return;
      this.toolInteraction = null;
      this.rebuildSprings();
      return;
    }
    this.toolInteraction = { ...interaction, positionMm: [...interaction.positionMm] as V3, quaternion: [...interaction.quaternion] as Q4 };
    this.rebuildSprings();
  }

  setMaterialParameters(material: ScissorsMaterialParameters | null): void {
    if (material === null) {
      this.shell = { ...SCISSORS_SHELL_PARAMETERS };
      this.rebuildSprings();
      return;
    }
    const g = material.relaxationFraction ?? .4, tau = material.relaxationTimeS ?? .7;
    if (![material.youngPa, material.fractureEnergyJm2, material.peakTractionPa, g, tau].every(Number.isFinite)
      || material.youngPa <= 0 || material.fractureEnergyJm2 <= 0 || material.peakTractionPa <= 0 || g < 0 || g >= 1 || tau <= 0) {
      throw new Error('Invalid scissors material parameters');
    }
    const stiffnessScale = Math.min(4, Math.max(.25, material.youngPa / 6000));
    const toughnessScale = Math.min(1.55, Math.max(.65, Math.sqrt((material.fractureEnergyJm2 / 20) * (16000 / material.peakTractionPa))));
    const dampingScale = Math.min(2.5, Math.max(.5, ((1 + g) / 1.4) * Math.pow(.7 / tau, .25)));
    this.shell = {
      ...SCISSORS_SHELL_PARAMETERS,
      edgeStiffnessNPerM: SCISSORS_SHELL_PARAMETERS.edgeStiffnessNPerM * stiffnessScale,
      bendingStiffnessNPerM: SCISSORS_SHELL_PARAMETERS.bendingStiffnessNPerM * stiffnessScale,
      supportStiffnessNPerM: SCISSORS_SHELL_PARAMETERS.supportStiffnessNPerM * stiffnessScale,
      dampingPerSecond: SCISSORS_SHELL_PARAMETERS.dampingPerSecond * dampingScale,
      retractionLipMm: SCISSORS_SHELL_PARAMETERS.retractionLipMm * toughnessScale,
      eversionLipMm: SCISSORS_SHELL_PARAMETERS.eversionLipMm * toughnessScale,
    };
    this.rebuildSprings();
  }

  snip(input: ScissorsSnip): ScissorsSnipResult {
    const shape = validatedStroke(input);
    if (input.openingRadians - input.closingRadians <= 1e-5 || input.closingRadians > 1e-5) return { changed: false, cutSegments: 0, reason: 'opening' };
    if (this.strokes.has(shape.key)) return { changed: false, cutSegments: 0, reason: 'already-cut' };
    // All topology edits are built privately. A miss or failed transaction never
    // changes geometry, mechanics, IDs, history, or the renderer revision.
    const nodes = this.nodes.map(copyNode);
    const separatedKeys = new Set<string>();
    for (const [key, ids] of this.wallGroups) if (ids.length >= 2) separatedKeys.add(key);
    const cutCoord = (node: Node): V3 => separatedKeys.has(pointKey(node.rest)) ? node.position : node.rest;
    const rawLocal = nodes.map(node => shape.local(cutCoord(node)));
    let tipOffsetX = 0, activeTipId = -1;
    if (this.cutCount > 0) {
      for (const ids of this.wallGroups.values()) {
        if (ids.length !== 1) continue;
        const id = ids[0]!, p = rawLocal[id]!;
        if (strictlyInside(p, shape) && Math.abs(p[0]) < 1.0) {
          activeTipId = id; tipOffsetX = p[0]; break;
        }
      }
    }
    const local: V3[] = rawLocal.map(p => [p[0] - tipOffsetX, p[1], p[2]]);
    if (activeTipId >= 0) {
      local[activeTipId]![0] = 0;
      for (const face of this.faces) {
        if (!face.includes(activeTipId)) continue;
        for (const id of face) {
          if (id >= this.initialNodes.length && id !== activeTipId && !this.wallGroups.has(pointKey(nodes[id]!.rest)) && Math.abs(local[id]![0]) < .03) {
            local[id]![0] = 0;
          }
        }
      }
    }
    const edgeSplits = new Map<string, EdgePoint[]>(), cuts = new Map<number, FaceCut>(), duplicate = new Set<number>();
    if (activeTipId >= 0) duplicate.add(activeTipId);
    const push = (node: Node) => { const id = nodes.length; nodes.push(node); const p = shape.local(cutCoord(node)); local.push([p[0] - tipOffsetX, p[1], p[2]]); return id; };
    const edgePoint = (a: number, b: number, t: number) => {
      if (t <= 1e-10) return a; if (t >= 1 - 1e-10) return b;
      const key = edgeKey(a, b), canonicalT = a < b ? t : 1 - t, list = edgeSplits.get(key) ?? [];
      const prior = list.find(point => Math.abs(point.t - canonicalT) < 1e-9);
      if (prior) return prior.id;
      const id = push(interpolateNode(nodes[a]!, nodes[b]!, t)); list.push({ t: canonicalT, id }); edgeSplits.set(key, list); return id;
    };
    const edgeFaces = new Map<string, number[]>();
    for (const face of this.faces) for (let j = 0; j < 3; j++) {
      const key = edgeKey(face[j]!, face[(j + 1) % 3]!), opposite = edgeFaces.get(key) ?? [];
      opposite.push(face[(j + 2) % 3]!); edgeFaces.set(key, opposite);
    }
    let segmentsCount = 0;
    for (let index = 0; index < this.faces.length; index++) {
      const face = this.faces[index]!, signs = face.map(id => local[id]![0]);
      const onPlane = face.filter(id => Math.abs(local[id]![0]) <= EPS);
      const alignedEdge = onPlane.length === 2 ? edgeFaces.get(edgeKey(onPlane[0]!, onPlane[1]!)) : undefined;
      // An edge exactly on the tool plane is a genuine cut when its incident
      // triangles lie on opposite sides. Grazing an existing outside boundary
      // or a coplanar surface does not manufacture a wound.
      const alignedCrossing = alignedEdge?.length === 2 && local[alignedEdge[0]!]![0] * local[alignedEdge[1]!]![0] < -EPS * EPS;
      if ((Math.min(...signs) >= -EPS || Math.max(...signs) <= EPS) && !alignedCrossing) continue;
      const intersections: { a: number; b: number; t: number; point: V3 }[] = [];
      for (let j = 0; j < 3; j++) {
        const a = face[j]!, b = face[(j + 1) % 3]!, x = local[a]![0], y = local[b]![0];
        if (Math.abs(x) <= EPS) intersections.push({ a, b: a, t: 0, point: local[a]! });
        else if ((x > 0) !== (y > 0) && Math.abs(y) > EPS) {
          const t = x / (x - y); intersections.push({ a, b, t, point: lerp(local[a]!, local[b]!, t) });
        }
      }
      if (intersections.length !== 2) continue;
      const [a, b] = intersections as [typeof intersections[number], typeof intersections[number]];
      const interval = sweptInterval(a.point, b.point, shape);
      if (!interval || length(sub(a.point, b.point)) * (interval[1] - interval[0]) < 1e-5) continue;
      const p = edgePoint(a.a, a.b, a.t), q = edgePoint(b.a, b.b, b.t), [lo, hi] = interval;
      const entries = [{ t: 0, id: p }, { t: 1, id: q }];
      // At least one distinct interior lip node is needed for a finite slit
      // whose endpoints both lie inside one source triangle to actually open.
      const spanMm = length(sub(nodes[p]!.rest, nodes[q]!.rest)) * (hi - lo);
      const minSub = (lo > 1e-6 && hi < 1 - 1e-6) || spanMm >= .6 ? 2 : 1;
      const subdivisions = Math.max(minSub, Math.ceil(spanMm / 1.5));
      for (let k = 0; k <= subdivisions; k++) {
        const t = lo + (hi - lo) * k / subdivisions;
        let id: number;
        if (t < 1e-9) id = p; else if (t > 1 - 1e-9) id = q;
        else { id = alignedCrossing ? edgePoint(p, q, t) : push(interpolateNode(nodes[p]!, nodes[q]!, t)); entries.push({ t, id }); }
        if ((k > 0 && k < subdivisions) || strictlyInside(local[id]!, shape)) duplicate.add(id);
      }
      entries.sort((x, y) => x.t - y.t);
      const line = entries.filter((entry, i) => i === 0 || entry.id !== entries[i - 1]!.id).map(entry => entry.id);
      const normal = normalized(cross(sub(nodes[face[1]!]!.rest, nodes[face[0]!]!.rest), sub(nodes[face[2]!]!.rest, nodes[face[0]!]!.rest)));
      const segments: Segment[] = [];
      for (let k = 0; k + 1 < entries.length; k++) {
        const x = entries[k]!, y = entries[k + 1]!;
        if (y.t - x.t > 1e-9 && (x.t + y.t) / 2 > lo - 1e-9 && (x.t + y.t) / 2 < hi + 1e-9)
          segments.push({ start: x.id, end: y.id, normal, depth: shape.depth });
      }
      cuts.set(index, { polygon: face, line, signs, segments }); segmentsCount++;
    }
    if (!cuts.size) return { changed: false, cutSegments: 0, reason: 'miss' };
    const duplicated = new Map<number, number>();
    for (const id of duplicate) { const other = push(copyNode(nodes[id]!)); nodes[id]!.active = true; nodes[other]!.active = true; duplicated.set(id, other); }
    const remap = (id: number, negative: boolean) => negative ? duplicated.get(id) ?? id : id;
    const subdivisions = (a: number, b: number) => {
      const list = [...(edgeSplits.get(edgeKey(a, b)) ?? [])].sort((x, y) => x.t - y.t);
      return [a, ...(a < b ? list : list.reverse()).map(point => point.id), b];
    };
    const faces: number[][] = [];
    const addPolygon = (polygon: number[], negative: boolean) => {
      const ids = polygon.map(id => remap(id, negative)).filter((id, i, all) => i === 0 || id !== all[i - 1]);
      if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
      if (ids.length < 3) return;
      if (ids.length === 3) { if (this.area(ids, nodes) > 1e-12) faces.push(ids); return; }
      // An interior fan preserves every collinear boundary split without
      // introducing T-junctions, including finite crack tips within a face.
      const average = (key: 'rest' | 'position' | 'velocity' | 'color' | 'target'): V3 => mul(ids.reduce((sum, id) => add(sum, nodes[id]![key]), [0, 0, 0] as V3), 1 / ids.length);
      const center = push({ rest: average('rest'), position: average('position'), velocity: average('velocity'), color: average('color'), active: ids.some(id => nodes[id]!.active), target: average('target'), supportScale: 1 });
      for (let j = 0; j < ids.length; j++) { const face = [center, ids[j]!, ids[(j + 1) % ids.length]!]; if (this.area(face, nodes) > 1e-12) faces.push(face); }
    };
    const newWounds = new Map<string, Wall>();
    for (const wall of this.woundEdges.values()) {
      const chain = subdivisions(wall.a, wall.b);
      for (let j = 0; j + 1 < chain.length; j++) {
        const a = chain[j]!, b = chain[j + 1]!, negative = (local[a]![0] + local[b]![0]) / 2 < -EPS;
        const x = remap(a, negative), y = remap(b, negative);
        newWounds.set(edgeKey(x, y), { ...wall, a: x, b: y });
      }
    }
    for (let index = 0; index < this.faces.length; index++) {
      const face = this.faces[index]!, cut = cuts.get(index);
      if (!cut) {
        const polygon: number[] = [];
        for (let j = 0; j < 3; j++) polygon.push(...subdivisions(face[j]!, face[(j + 1) % 3]!).slice(0, -1));
        addPolygon(polygon, face.reduce((sum, id) => sum + local[id]![0], 0) < -EPS);
        continue;
      }
      for (const side of [1, -1]) {
        const polygon: number[] = [];
        for (let j = 0; j < 3; j++) {
          const a = face[j]!, b = face[(j + 1) % 3]!, chain = subdivisions(a, b);
          for (const id of chain.slice(0, -1)) if (side * local[id]![0] >= -EPS) polygon.push(id);
        }
        // Clipping a triangle leaves one plane edge. Insert the entire ordered
        // cut chain there, with its orientation inherited from the source face.
        const expanded: number[] = [];
        for (let j = 0; j < polygon.length; j++) {
          const a = polygon[j]!, b = polygon[(j + 1) % polygon.length]!; expanded.push(a);
          if ((a === cut.line[0] && b === cut.line[cut.line.length - 1]) || (b === cut.line[0] && a === cut.line[cut.line.length - 1])) {
            const line = cut.line[0] === a ? cut.line : [...cut.line].reverse();
            expanded.push(...line.slice(1, -1));
          }
        }
        addPolygon(expanded, side < 0);
        for (const segment of cut.segments) {
          const a = remap(segment.start, side < 0), b = remap(segment.end, side < 0);
          newWounds.set(edgeKey(a, b), { a, b, normal: segment.normal, depth: segment.depth });
        }
      }
    }
    if (nodes.length > MAX_NODES || faces.length > MAX_TRIANGLES) throw new Error('Surface incision resolution limit reached; reset before further cuts');
    const boundary = this.boundaries(faces);
    for (const [key, wall] of newWounds) {
      const edge = boundary.get(key);
      if (!edge) newWounds.delete(key);
      // Möbius manifold orientation: reverse the surface triangle's boundary
      // half-edge so the descending wall quad's normal points into the cleft.
      else { wall.a = edge.b; wall.b = edge.a; }
    }
    if (!newWounds.size) throw new Error('Incision did not produce an open surface boundary');
    const beforeArea = this.faces.reduce((sum, face) => sum + this.area(face, this.nodes), 0), afterArea = faces.reduce((sum, face) => sum + this.area(face, nodes), 0);
    if (Math.abs(afterArea - beforeArea) > 1e-8 * Math.max(1, beforeArea)) throw new Error('Incision surface-area conservation failed');
    for (const node of nodes) if (length(sub(node.position, shape.position)) < shape.bladeLength * 2.25) node.active = true;
    this.nodes = nodes; this.faces = faces; this.woundEdges = newWounds; this.strokes.add(shape.key);
    this.cutCount++; this.cutSegments += segmentsCount;
    this.rebuildSprings();
    for (const [a, b] of duplicated) for (const id of [a, b]) {
      const node = this.nodes[id]!, dir = sub(node.target, node.position), dist = length(dir);
      if (dist > 1e-6) node.velocity = add(node.velocity, mul(dir, this.shell.recoilVelocityMmS * Math.min(1, dist / 2) / dist));
    }
    this.rebuildGeometry();
    return { changed: true, cutSegments: segmentsCount, reason: 'cut' };
  }

  private rebuildSprings() {
    this.walls = [...this.woundEdges.values()]; this.wallGroups = new Map();
    for (const wall of this.walls) for (const id of [wall.a, wall.b]) {
      const key = pointKey(this.nodes[id]!.rest), group = this.wallGroups.get(key) ?? [];
      if (!group.includes(id)) group.push(id); this.wallGroups.set(key, group);
    }
    for (const node of this.nodes) { node.target = [...node.rest]; node.supportScale = 1; }
    const woundAdj = new Map<number, { to: number; len: number }[]>();
    if (this.walls.length > 0) {
      const woundVertices = new Set<number>();
      const retractSum = new Map<number, V3>(), normalSum = new Map<number, V3>();
      for (const wall of this.walls) {
        const a = this.nodes[wall.a]!, b = this.nodes[wall.b]!, edgeVec = sub(b.rest, a.rest), segLen = length(edgeVec);
        if (segLen <= 1e-12) continue;
        // Because wall.a -> wall.b is oriented opposite the surface boundary,
        // (b.rest - a.rest) x wall.normal points into the retracting flap.
        const retractDir = normalized(cross(edgeVec, wall.normal));
        for (const id of [wall.a, wall.b]) {
          woundVertices.add(id);
          retractSum.set(id, add(retractSum.get(id) ?? [0, 0, 0], mul(retractDir, segLen)));
          normalSum.set(id, add(normalSum.get(id) ?? [0, 0, 0], mul(wall.normal, segLen)));
        }
        const listA = woundAdj.get(wall.a) ?? []; listA.push({ to: wall.b, len: segLen }); woundAdj.set(wall.a, listA);
        const listB = woundAdj.get(wall.b) ?? []; listB.push({ to: wall.a, len: segLen }); woundAdj.set(wall.b, listB);
      }
      // Smooth the lip tangent/retraction and normal frames along each lip chain
      // so triangle-facet angle changes never cause sawtooth lip scalloping.
      for (let pass = 0; pass < 3; pass++) {
        const nextRetract = new Map<number, V3>(), nextNormal = new Map<number, V3>();
        for (const id of woundVertices) {
          let rSum = mul(retractSum.get(id) ?? [0, 0, 0], 2);
          let nSum = mul(normalSum.get(id) ?? [0, 1, 0], 2);
          for (const edge of woundAdj.get(id) ?? []) {
            const nr = retractSum.get(edge.to), nn = normalSum.get(edge.to);
            if (nr && dot(nr, rSum) >= 0) rSum = add(rSum, nr);
            if (nn) nSum = add(nSum, nn);
          }
          nextRetract.set(id, rSum); nextNormal.set(id, nSum);
        }
        for (const [id, rVal] of nextRetract) retractSum.set(id, rVal);
        for (const [id, nVal] of nextNormal) normalSum.set(id, nVal);
      }
      const chainScale = new Map<number, number>(), visitedChain = new Set<number>();
      for (const start of woundVertices) {
        if (visitedChain.has(start)) continue;
        const comp: number[] = [start]; visitedChain.add(start);
        let degreeSum = 0;
        for (let idx = 0; idx < comp.length; idx++) {
          const u = comp[idx]!;
          for (const edge of woundAdj.get(u) ?? []) {
            degreeSum += edge.len;
            if (!visitedChain.has(edge.to)) { visitedChain.add(edge.to); comp.push(edge.to); }
          }
        }
        // Each undirected wound edge is traversed twice; each slit has two lips.
        const incisionLengthMm = .25 * degreeSum;
        const factor = 1 + .26 * Math.tanh(Math.max(0, incisionLengthMm - 13) / 10);
        for (const id of comp) chainScale.set(id, factor);
      }
      const separatedRests: V3[] = [];
      for (const id of woundVertices) {
        const group = this.wallGroups.get(pointKey(this.nodes[id]!.rest));
        if (group && group.length > 1) separatedRests.push(this.nodes[id]!.rest);
      }
      const isInternalJunction = (rest: V3): boolean => {
        if (this.cutCount <= 1) return false;
        const nearbyDirs: V3[] = [];
        for (const other of separatedRests) {
          const dVec = sub(other, rest), d = length(dVec);
          if (d > .2 && d < 5.5) nearbyDirs.push(mul(dVec, 1 / d));
        }
        for (let i = 0; i < nearbyDirs.length; i++) for (let j = i + 1; j < nearbyDirs.length; j++) {
          if (dot(nearbyDirs[i]!, nearbyDirs[j]!) < -.25) return true;
        }
        return false;
      };
      const tipDist = new Map<number, number>(), unvisitedWound = new Set<number>(woundVertices);
      for (const id of woundVertices) {
        const group = this.wallGroups.get(pointKey(this.nodes[id]!.rest));
        const isTrueTip = Boolean(group && group.length === 1 && !isInternalJunction(this.nodes[id]!.rest));
        tipDist.set(id, isTrueTip ? 0 : Infinity);
      }
      while (unvisitedWound.size) {
        let best = -1, bestDist = Infinity;
        for (const id of unvisitedWound) { const d = tipDist.get(id)!; if (d < bestDist) { bestDist = d; best = id; } }
        if (best < 0 || !Number.isFinite(bestDist)) break;
        unvisitedWound.delete(best);
        for (const edge of woundAdj.get(best) ?? []) {
          const next = bestDist + edge.len;
          if (next < (tipDist.get(edge.to) ?? Infinity)) tipDist.set(edge.to, next);
        }
      }
      const multiCutFactor = 1 + .18 * Math.min(2.5, this.cutCount - 1);
      const lipDisp = new Map<number, V3>(), lipNormal = new Map<number, V3>();
      for (const id of woundVertices) {
        const dTip = tipDist.get(id) ?? Infinity;
        const eta = Number.isFinite(dTip) ? Math.tanh(dTip / 2.1) : 1;
        const sHat = normalized(retractSum.get(id) ?? [0, 0, 0]), nHat = normalized(normalSum.get(id) ?? [0, 1, 0]);
        const scale = eta * multiCutFactor * (chainScale.get(id) ?? 1);
        const disp = mul(add(mul(sHat, this.shell.retractionLipMm), mul(nHat, this.shell.eversionLipMm)), scale);
        lipDisp.set(id, disp); lipNormal.set(id, nHat);
      }
      // Smooth the lip displacement profile along each separated lip chain
      // while keeping true outer crack tips (tipDist === 0) pinned.
      for (let pass = 0; pass < 2; pass++) {
        const nextDisp = new Map<number, V3>();
        for (const id of woundVertices) {
          if ((tipDist.get(id) ?? Infinity) <= 1e-6) { nextDisp.set(id, lipDisp.get(id)!); continue; }
          let sum = mul(lipDisp.get(id)!, 2), w = 2;
          for (const edge of woundAdj.get(id) ?? []) {
            const nd = lipDisp.get(edge.to);
            if (nd && dot(nd, sum) >= 0) { sum = add(sum, nd); w += 1; }
          }
          nextDisp.set(id, mul(sum, 1 / w));
        }
        for (const [id, dVal] of nextDisp) lipDisp.set(id, dVal);
      }
      const meshAdj = new Map<number, { to: number; len: number }[]>();
      for (const face of this.faces) {
        if (!face.some(id => this.nodes[id]!.active)) continue;
        for (let j = 0; j < 3; j++) {
          const u = face[j]!, v = face[(j + 1) % 3]!, segLen = length(sub(this.nodes[v]!.rest, this.nodes[u]!.rest));
          const lu = meshAdj.get(u) ?? []; if (!lu.some(e => e.to === v)) lu.push({ to: v, len: segLen }); meshAdj.set(u, lu);
          const lv = meshAdj.get(v) ?? []; if (!lv.some(e => e.to === u)) lv.push({ to: u, len: segLen }); meshAdj.set(v, lv);
        }
      }
      const geoDist = new Float64Array(this.nodes.length).fill(Infinity);
      const propDisp = new Array<V3>(this.nodes.length), propNormal = new Array<V3>(this.nodes.length);
      const queue = new Set<number>();
      const retractingSeeds = [...woundVertices].filter(id => (tipDist.get(id) ?? Infinity) > 1e-6);
      const seeds = retractingSeeds.length > 0 ? retractingSeeds : [...woundVertices];
      for (const id of woundVertices) {
        propDisp[id] = lipDisp.get(id)!; propNormal[id] = lipNormal.get(id)!;
      }
      for (const id of seeds) {
        geoDist[id] = 0; queue.add(id);
      }
      while (queue.size) {
        let u = -1, best = Infinity;
        for (const id of queue) if (geoDist[id]! < best) { best = geoDist[id]!; u = id; }
        if (u < 0) break;
        queue.delete(u);
        for (const edge of meshAdj.get(u) ?? []) {
          if (woundVertices.has(edge.to)) continue;
          const next = best + edge.len;
          if (next < geoDist[edge.to]! && next <= this.shell.lobeDecayMm * 3.4) {
            geoDist[edge.to] = next;
            propDisp[edge.to] = propDisp[u]!;
            propNormal[edge.to] = propNormal[u]!;
            queue.add(edge.to);
          }
        }
      }
      for (const id of woundVertices) geoDist[id] = 0;
      // Smooth the propagated retraction vector field across each split lobe
      // without averaging opposing flaps across the crack tips.
      for (let pass = 0; pass < 4; pass++) {
        const smoothed = propDisp.slice();
        for (let id = 0; id < this.nodes.length; id++) {
          if (woundVertices.has(id) || !propDisp[id]) continue;
          let sum = mul(propDisp[id]!, 2), weight = 2;
          for (const edge of meshAdj.get(id) ?? []) {
            const nd = propDisp[edge.to];
            if (nd && dot(nd, propDisp[id]!) >= -1e-6) { sum = add(sum, nd); weight += 1; }
          }
          smoothed[id] = mul(sum, 1 / weight);
        }
        for (let id = 0; id < this.nodes.length; id++) if (smoothed[id]) propDisp[id] = smoothed[id]!;
      }
      for (let id = 0; id < this.nodes.length; id++) {
        const rGeo = geoDist[id]!, disp = propDisp[id], nHat = propNormal[id];
        if (!Number.isFinite(rGeo) || !disp || !nHat) continue;
        let rEuclid = rGeo;
        if (rGeo > 0) {
          let bestE = Infinity;
          const pRest = this.nodes[id]!.rest;
          for (const wId of seeds) {
            const dE = length(sub(pRest, this.nodes[wId]!.rest));
            if (dE < bestE) bestE = dE;
          }
          if (Number.isFinite(bestE)) rEuclid = .65 * bestE + .35 * rGeo;
        }
        const decay = Math.exp(-rEuclid / this.shell.lobeDecayMm);
        const drawdown = -.24 * (rEuclid / 8) * Math.exp(1 - rEuclid / 8);
        this.nodes[id]!.target = add(this.nodes[id]!.rest, add(mul(disp, decay), mul(nHat, drawdown)));
        this.nodes[id]!.supportScale = woundVertices.has(id) ? 2.1 : (.75 + .25 * Math.tanh(rEuclid / 10));
      }
    }
    const toolActive = new Set<number>();
    if (this.toolInteraction && this.toolInteraction.intensity > 1e-4) {
      const tool = this.toolInteraction, norm = Math.hypot(...tool.quaternion);
      if (norm > 1e-12) {
        const q = tool.quaternion.map(v => v / norm) as Q4, invQ: Q4 = [-q[0], -q[1], -q[2], q[3]];
        const origin = [...tool.positionMm] as V3, bladeLen = tool.lengthMm ?? 18, insertMm = tool.insertionDepthMm ?? 2;
        const zCenter = .55 * bladeLen, radiusLimit = bladeLen * 2.1, intensity = Math.max(0, Math.min(1, tool.intensity));
        for (let id = 0; id < this.nodes.length; id++) {
          const p = rotate(sub(this.nodes[id]!.rest, origin), invQ);
          if (Math.hypot(p[0], p[1], p[2] - zCenter) > radiusLimit) continue;
          const pTarget = rotate(sub(this.nodes[id]!.target, origin), invQ);
          toolActive.add(id);
          const wIndent = Math.exp(-(p[0] ** 2) / (2 * 13 ** 2) - (p[1] ** 2) / (2 * 14 ** 2) - ((p[2] - zCenter) ** 2) / (2 * 14 ** 2));
          const dy = -(1.65 + .35 * insertMm) * intensity * wIndent;
          const wPinch = Math.exp(-(p[0] ** 2) / (2 * 9 ** 2) - ((p[2] - zCenter) ** 2) / (2 * 11 ** 2));
          const dx = tool.phase === 'closing'
            ? -.52 * intensity * Math.tanh(p[0] / 3.5) * wPinch
            : .88 * intensity * Math.tanh(pTarget[0] / 1.8) * wPinch;
          const dz = (tool.phase === 'closing' ? .55 : .25) * intensity * wIndent;
          this.nodes[id]!.target = add(this.nodes[id]!.target, rotate([dx, dy, dz], q));
        }
      }
    }
    const areas = new Float64Array(this.nodes.length), edges = new Map<string, Spring>(), opposites = new Map<string, number[]>();
    const isActive = (id: number) => this.nodes[id]!.active || toolActive.has(id);
    for (const face of this.faces) {
      const f0 = face[0]!, f1 = face[1]!, f2 = face[2]!;
      const area = this.area(face, this.nodes) / 3;
      areas[f0]! += area; areas[f1]! += area; areas[f2]! += area;
      if (!isActive(f0) && !isActive(f1) && !isActive(f2)) continue;
      for (let j = 0; j < 3; j++) {
        const a = face[j]!, b = face[(j + 1) % 3]!, c = face[(j + 2) % 3]!, key = edgeKey(a, b);
        const opp = opposites.get(key);
        if (opp) opp.push(c); else opposites.set(key, [c]);
        if (!edges.has(key) && (isActive(a) || isActive(b)))
          edges.set(key, { a, b, lengthM: .001 * length(sub(this.nodes[a]!.target, this.nodes[b]!.target)), lambda: 0, stiffness: this.shell.edgeStiffnessNPerM });
      }
    }
    if (this.shell.bendingStiffnessNPerM > 0) {
      for (const pair of opposites.values()) {
        if (pair.length !== 2 || pair[0] === pair[1]) continue;
        const c = pair[0]!, d = pair[1]!, key = edgeKey(c, d);
        if (!edges.has(key) && (isActive(c) || isActive(d)))
          edges.set(key, { a: c, b: d, lengthM: .001 * length(sub(this.nodes[c]!.target, this.nodes[d]!.target)), lambda: 0, stiffness: this.shell.bendingStiffnessNPerM });
      }
      // Lip-continuity bending springs keep the parted incision rim smooth.
      for (const [u, neighbors] of woundAdj) {
        if (neighbors.length === 2) {
          const c = neighbors[0]!.to, d = neighbors[1]!.to, key = edgeKey(c, d);
          if (c !== d && !edges.has(key) && (isActive(c) || isActive(d)))
            edges.set(key, { a: c, b: d, lengthM: .001 * length(sub(this.nodes[c]!.target, this.nodes[d]!.target)), lambda: 0, stiffness: this.shell.bendingStiffnessNPerM * 1.5 });
        }
      }
    }
    this.activeNodes = this.nodes.flatMap((_, id) => isActive(id) && areas[id]! > 0 ? [id] : []);
    this.inverseMass = Float64Array.from(areas, (area, id) => isActive(id) && area > 0 ? 1 / Math.max(1e-8, area * 1e-6 * this.shell.thicknessM * this.shell.densityKgM3) : 0);
    this.springs = [...edges.values()];
  }

  step(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0 || dtSeconds > .1) throw new Error('Surface step must be finite and between zero and 0.1 seconds');
    if (!dtSeconds || !this.activeNodes.length) return;
    const count = Math.ceil(dtSeconds / this.shell.maximumSubstepSeconds), dt = dtSeconds / count, dt2 = dt * dt;
    const damp = Math.exp(-this.shell.dampingPerSecond * dt), invDt = 1 / dt;
    const original = this.activeNodes.map(id => ({ id, position: [...this.nodes[id]!.position] as V3, velocity: [...this.nodes[id]!.velocity] as V3 }));
    const previous = new Float64Array(3 * this.activeNodes.length), anchors = new Float64Array(3 * this.activeNodes.length);
    try {
      for (let substep = 0; substep < count; substep++) {
        anchors.fill(0);
        for (let j = 0; j < this.activeNodes.length; j++) {
          const id = this.activeNodes[j]!, node = this.nodes[id]!, pos = node.position, vel = node.velocity, pOff = 3 * j;
          previous[pOff] = pos[0]; previous[pOff + 1] = pos[1]; previous[pOff + 2] = pos[2];
          vel[0] *= damp; vel[1] *= damp; vel[2] *= damp;
          pos[0] += vel[0] * dt; pos[1] += vel[1] * dt; pos[2] += vel[2] * dt;
        }
        for (let s = 0; s < this.springs.length; s++) this.springs[s]!.lambda = 0;
        const nSprings = this.springs.length;
        for (let iteration = 0; iteration < this.shell.projectionIterations; iteration++) {
          const reverse = (iteration & 1) === 1;
          for (let s = 0; s < nSprings; s++) {
            const spring = this.springs[reverse ? nSprings - 1 - s : s]!;
            const pa = this.nodes[spring.a]!.position, pb = this.nodes[spring.b]!.position;
            const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
            const mm = Math.hypot(dx, dy, dz);
            if (mm < 1e-12) continue;
            const wa = this.inverseMass[spring.a]!, wb = this.inverseMass[spring.b]!, alpha = 1 / (spring.stiffness * dt2);
            const dl = (-(mm * .001 - spring.lengthM) - alpha * spring.lambda) / (wa + wb + alpha);
            spring.lambda += dl;
            const scale = 1000 * dl / mm, sa = wa * scale, sb = wb * scale;
            pa[0] -= dx * sa; pa[1] -= dy * sa; pa[2] -= dz * sa;
            pb[0] += dx * sb; pb[1] += dy * sb; pb[2] += dz * sb;
          }
          for (let j = 0; j < this.activeNodes.length; j++) {
            const id = this.activeNodes[j]!, node = this.nodes[id]!, pos = node.position, target = node.target, w = this.inverseMass[id]!;
            const alpha = 1 / (this.shell.supportStiffnessNPerM * node.supportScale * dt2), denom = w + alpha, kBase = 3 * j;
            for (let axis = 0; axis < 3; axis++) {
              const k = kBase + axis, dl = (-(pos[axis]! - target[axis]!) * .001 - alpha * anchors[k]!) / denom;
              anchors[k]! += dl; pos[axis]! += 1000 * w * dl;
            }
          }
        }
        for (let j = 0; j < this.activeNodes.length; j++) {
          const node = this.nodes[this.activeNodes[j]!]!, pos = node.position, vel = node.velocity, rest = node.rest, pOff = 3 * j;
          vel[0] = (pos[0] - previous[pOff]!) * invDt;
          vel[1] = (pos[1] - previous[pOff + 1]!) * invDt;
          vel[2] = (pos[2] - previous[pOff + 2]!) * invDt;
          const rx = pos[0] - rest[0], ry = pos[1] - rest[1], rz = pos[2] - rest[2];
          if (!Number.isFinite(pos[0] + pos[1] + pos[2] + vel[0] + vel[1] + vel[2]) || rx * rx + ry * ry + rz * rz > 400) {
            throw new Error('Surface relaxation exceeded its bounded approximation');
          }
        }
      }
    } catch (error) { for (const saved of original) { this.nodes[saved.id]!.position = saved.position; this.nodes[saved.id]!.velocity = saved.velocity; } throw error; }
    this.updatePositions(); this.view.positionRevision++;
  }

  private rebuildGeometry() {
    this.walls = [...this.woundEdges.values()]; this.wallGroups = new Map();
    const wallKeyAdj = new Map<string, Set<string>>();
    for (const wall of this.walls) {
      const keyA = pointKey(this.nodes[wall.a]!.rest), keyB = pointKey(this.nodes[wall.b]!.rest);
      if (keyA !== keyB) {
        let sA = wallKeyAdj.get(keyA); if (!sA) { sA = new Set(); wallKeyAdj.set(keyA, sA); } sA.add(keyB);
        let sB = wallKeyAdj.get(keyB); if (!sB) { sB = new Set(); wallKeyAdj.set(keyB, sB); } sB.add(keyA);
      }
      for (const id of [wall.a, wall.b]) {
        const key = pointKey(this.nodes[id]!.rest), group = this.wallGroups.get(key) ?? [];
        if (!group.includes(id)) group.push(id); this.wallGroups.set(key, group);
      }
    }
    const restNormals = new Map<string, V3>();
    for (const wall of this.walls) {
      const segLen = Math.max(1e-4, length(sub(this.nodes[wall.b]!.rest, this.nodes[wall.a]!.rest)));
      const wn = mul(wall.normal, segLen);
      for (const id of [wall.a, wall.b]) {
        const key = pointKey(this.nodes[id]!.rest);
        restNormals.set(key, add(restNormals.get(key) ?? [0, 0, 0], wn));
      }
    }
    for (const [key, n] of restNormals) restNormals.set(key, normalized(n));
    for (let pass = 0; pass < 16; pass++) {
      const next = new Map<string, V3>();
      for (const [key, n] of restNormals) {
        const adj = wallKeyAdj.get(key);
        if (!adj || adj.size === 0) { next.set(key, n); continue; }
        let sum = mul(n, 1.2);
        for (const nb of adj) sum = add(sum, restNormals.get(nb) ?? n);
        next.set(key, normalized(sum));
      }
      for (const [key, n] of next) restNormals.set(key, n);
    }
    const count = this.nodes.length + 4 * this.walls.length;
    const positionsMm = new Float32Array(3 * count), restPositionsMm = new Float32Array(3 * count), colors = new Float32Array(3 * count), wallIndices = new Uint32Array(6 * this.walls.length);
    this.nodes.forEach((node, id) => { restPositionsMm.set(node.rest, 3 * id); colors.set(node.color, 3 * id); });
    this.walls.forEach((wall, i) => {
      const base = this.nodes.length + 4 * i, a = this.nodes[wall.a]!, b = this.nodes[wall.b]!;
      const nA = restNormals.get(pointKey(a.rest)) ?? wall.normal, nB = restNormals.get(pointKey(b.rest)) ?? wall.normal;
      const bottomA = sub(a.rest, mul(nA, wall.depth)), bottomB = sub(b.rest, mul(nB, wall.depth));
      [a.rest, b.rest, bottomB, bottomA].forEach((p, j) => { restPositionsMm.set(p, 3 * (base + j)); colors.set([.34, .045, .035], 3 * (base + j)); });
      wallIndices.set([base, base + 1, base + 2, base, base + 2, base + 3], 6 * i);
    });
    this.view = { positionsMm, restPositionsMm, colors, indices: Uint32Array.from(this.faces.flat()), wallIndices, revision: this.view.revision + 1, positionRevision: this.view.positionRevision + 1 };
    this.updatePositions();
  }
  private updatePositions() {
    this.nodes.forEach((node, id) => this.view.positionsMm.set(node.position, 3 * id));
    const centers = new Map<string, { center: V3; opening: number; normal: V3 }>();
    const wallKeyAdj = new Map<string, Set<string>>();
    for (const wall of this.walls) {
      const keyA = pointKey(this.nodes[wall.a]!.rest), keyB = pointKey(this.nodes[wall.b]!.rest);
      if (keyA !== keyB) {
        let sA = wallKeyAdj.get(keyA); if (!sA) { sA = new Set(); wallKeyAdj.set(keyA, sA); } sA.add(keyB);
        let sB = wallKeyAdj.get(keyB); if (!sB) { sB = new Set(); wallKeyAdj.set(keyB, sB); } sB.add(keyA);
      }
    }
    for (const [key, ids] of this.wallGroups) {
      const avgPos = mul(ids.reduce((sum, id) => add(sum, this.nodes[id]!.position), [0, 0, 0] as V3), 1 / ids.length);
      const restPos = this.nodes[ids[0]!]!.rest;
      let opening = 0;
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++)
        opening = Math.max(opening, length(sub(this.nodes[ids[a]!]!.position, this.nodes[ids[b]!]!.position)));
      if (ids.length === 1) {
        const dRest = length(sub(avgPos, restPos));
        if (dRest > .35) opening = 2 * dRest;
      }
      centers.set(key, { center: restPos, opening, normal: [0, 0, 0] });
    }
    for (const wall of this.walls) {
      const segLen = Math.max(1e-4, length(sub(this.nodes[wall.b]!.rest, this.nodes[wall.a]!.rest)));
      const wn = mul(wall.normal, segLen);
      for (const id of [wall.a, wall.b]) {
        const group = centers.get(pointKey(this.nodes[id]!.rest));
        if (group) group.normal = add(group.normal, wn);
      }
    }
    for (const group of centers.values()) group.normal = normalized(group.normal);
    for (let pass = 0; pass < 16; pass++) {
      const next = new Map<string, { normal: V3; opening: number }>();
      for (const [key, group] of centers) {
        const adj = wallKeyAdj.get(key);
        if (!adj || adj.size === 0) { next.set(key, { normal: group.normal, opening: group.opening }); continue; }
        let nSum = mul(group.normal, 1.2), oSum = group.opening * 1.2, w = 1.2;
        for (const nbKey of adj) {
          const nb = centers.get(nbKey);
          if (nb) { nSum = add(nSum, nb.normal); oSum += nb.opening; w += 1; }
        }
        next.set(key, { normal: normalized(nSum), opening: oSum / w });
      }
      for (const [key, val] of next) {
        const group = centers.get(key)!;
        group.normal = val.normal;
        group.opening = val.opening;
      }
    }
    this.walls.forEach((wall, i) => {
      const a = this.nodes[wall.a]!, b = this.nodes[wall.b]!, base = this.nodes.length + 4 * i;
      const groupA = centers.get(pointKey(a.rest))!, groupB = centers.get(pointKey(b.rest))!;
      const depthA = wall.depth * (1 + .28 * Math.min(1, groupA.opening / 2.8));
      const depthB = wall.depth * (1 + .28 * Math.min(1, groupB.opening / 2.8));
      const bottomA = sub(groupA.center, mul(groupA.normal, depthA)), bottomB = sub(groupB.center, mul(groupB.normal, depthB));
      [a.position, b.position, bottomB, bottomA].forEach((point, j) => this.view.positionsMm.set(point, 3 * (base + j)));
    });
  }
  geometry(): ScissorsSurfaceGeometry { return this.view; }
  metrics() {
    let maximumDisplacementMm = 0, maximumLipOpeningMm = 0;
    for (const node of this.nodes) maximumDisplacementMm = Math.max(maximumDisplacementMm, length(sub(node.position, node.rest)));
    for (const ids of this.wallGroups.values()) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++)
      maximumLipOpeningMm = Math.max(maximumLipOpeningMm, length(sub(this.nodes[ids[a]!]!.position, this.nodes[ids[b]!]!.position)));
    return { cutCount: this.cutCount, cutSegments: this.cutSegments, maximumDisplacementMm, maximumLipOpeningMm, nodeCount: this.nodes.length, triangleCount: this.faces.length,
      woundBoundaryEdges: this.woundEdges.size, originalBoundaryEdges: this.originalBoundaryEdges };
  }
  reset(): void {
    this.nodes = this.initialNodes.map(copyNode); this.faces = this.initialFaces.map(face => [...face]);
    this.woundEdges.clear(); this.strokes.clear(); this.cutCount = 0; this.cutSegments = 0; this.toolInteraction = null;
    this.springs = []; this.activeNodes = []; this.inverseMass = new Float64Array(); this.rebuildGeometry();
  }
  snapshot() {
    return { schema: 'viscera.scissors-surface/v1', provenance: SCISSORS_SURFACE_PROVENANCE, shellParameters: SCISSORS_SHELL_PARAMETERS, metrics: this.metrics(),
      geometry: { ...this.view, positionsMm: Array.from(this.view.positionsMm), restPositionsMm: Array.from(this.view.restPositionsMm), colors: Array.from(this.view.colors), indices: Array.from(this.view.indices), wallIndices: Array.from(this.view.wallIndices) } };
  }
}
