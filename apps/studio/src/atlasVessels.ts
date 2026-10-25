import * as THREE from "three";
import type { OrganMesh } from "@viscera/render";

export const ATLAS_VESSEL_VERSION = "surface-vessels-design-1.0.0" as const;
export type VesselVec3 = [number, number, number];
export interface AtlasVesselOptions {
  seed: number;
  organId: string;
  density?: number;
  visibility?: number;
  radiusScale?: number;
  /** Additional surface-constrained fairing for regularly tessellated lofts. */
  fairingPasses?: number;
}
export const DEFAULT_ATLAS_VESSEL_OPTIONS = { density: 0.45, visibility: 0.72, radiusScale: 1 } as const;
export interface AtlasVesselAnchor { triangle: number; weights: VesselVec3 }
export interface AtlasVesselSegment {
  a_mm: VesselVec3;
  b_mm: VesselVec3;
  normal: VesselVec3;
  radius_a_mm: number;
  radius_b_mm: number;
  depth_mm: number;
  /** 0: arterial palette; 1: venous palette. Not an anatomical classification. */
  kind: 0 | 1;
  a_anchor: AtlasVesselAnchor;
  b_anchor: AtlasVesselAnchor;
}
export interface AtlasVesselNetwork {
  version: typeof ATLAS_VESSEL_VERSION;
  seed: number;
  organ_id: string;
  provenance: "procedural-surface-design-not-patient-vasculature";
  settings: { density: number; visibility: number; radius_scale: number; fairing_passes?: number };
  segments: AtlasVesselSegment[];
  statistics: { terminals: number; branches: number; connected_components: number; length_mm: number; murray_exponent: 3;
    fine_terminals?: number; min_radius_mm?: number; max_radius_mm?: number; max_junction_murray_relative_error?: number };
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const xyz = (p: ArrayLike<number>, i: number): VesselVec3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
const distance = (a: VesselVec3, b: VesselVec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A binary heap keeps graph-geodesic routing O((V + E) log V), not O(V²). */
class MinHeap {
  private items: [number, number][] = [];
  push(id: number, cost: number) {
    const node: [number, number] = [id, cost];
    let i = this.items.length;
    this.items.push(node);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]![1] <= cost) break;
      this.items[i] = this.items[parent]!;
      i = parent;
    }
    this.items[i] = node;
  }
  pop(): [number, number] | undefined {
    const root = this.items[0], tail = this.items.pop();
    if (this.items.length && tail) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1]![1] < this.items[child]![1]) child++;
        if (this.items[child]![1] >= tail[1]) break;
        this.items[i] = this.items[child]!;
        i = child;
      }
      this.items[i] = tail;
    }
    return root;
  }
}

interface SurfaceGraph {
  positions: VesselVec3[];
  adjacency: Set<number>[];
  triangles: number[][];
  canonical: number[];
  original: number[];
  areas: number[];
}
function surfaceGraph(positions: ArrayLike<number>, indices: number[]): SurfaceGraph {
  const count = positions.length / 3;
  const graph: SurfaceGraph = { positions: [], adjacency: [], triangles: [], canonical: [], original: [], areas: [] };
  const weld = new Map<string, number>();
  // Welding coincident seam vertices makes routing independent of UV seams.
  for (let i = 0; i < count; i++) {
    const p = xyz(positions, i), key = p.map(v => Math.round(v * 1e5)).join(":");
    let id = weld.get(key);
    if (id === undefined) {
      id = graph.positions.length;
      weld.set(key, id);
      graph.positions.push(p); graph.adjacency.push(new Set()); graph.triangles.push([]); graph.original.push(i); graph.areas.push(0);
    }
    graph.canonical.push(id);
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < indices.length / 3; t++) {
    const ids = [0, 1, 2].map(j => graph.canonical[indices[t * 3 + j]!]!);
    a.fromArray(graph.positions[ids[0]!]!); b.fromArray(graph.positions[ids[1]!]!); c.fromArray(graph.positions[ids[2]!]!);
    const area = b.sub(a).cross(c.sub(a)).length() * 0.5;
    if (area < 1e-10) continue;
    for (let j = 0; j < 3; j++) {
      const from = ids[j]!, to = ids[(j + 1) % 3]!;
      graph.adjacency[from]!.add(to); graph.adjacency[to]!.add(from);
      graph.triangles[from]!.push(t); graph.areas[from]! += area / 3;
    }
  }
  return graph;
}

interface Projected { point: VesselVec3; normal: VesselVec3; anchor: AtlasVesselAnchor }
function projectLocal(point: VesselVec3, nearby: number[], graph: SurfaceGraph, positions: ArrayLike<number>, indices: number[]): Projected {
  const triangles = new Set<number>();
  for (const id of nearby) for (const t of graph.triangles[id]!) triangles.add(t);
  const tri = new THREE.Triangle(), target = new THREE.Vector3(...point), closest = new THREE.Vector3();
  let best = Infinity;
  let result: Projected | undefined;
  for (const t of triangles) {
    tri.a.fromArray(positions, indices[t * 3]! * 3); tri.b.fromArray(positions, indices[t * 3 + 1]! * 3); tri.c.fromArray(positions, indices[t * 3 + 2]! * 3);
    tri.closestPointToPoint(target, closest);
    const d = closest.distanceToSquared(target);
    if (d < best) {
      best = d;
      result = { point: closest.toArray() as VesselVec3, normal: tri.getNormal(new THREE.Vector3()).toArray() as VesselVec3,
        anchor: { triangle: t, weights: tri.getBarycoord(closest, new THREE.Vector3())!.toArray() as VesselVec3 } };
    }
  }
  if (!result) throw new Error("Surface vessels require non-degenerate surface triangles.");
  return result;
}

/** Reconstruct a stored surface attachment against a sculpted position buffer. */
export function evaluateVesselAnchor(anchor: AtlasVesselAnchor, positions: ArrayLike<number>, indices: ArrayLike<number>): VesselVec3 {
  const result: VesselVec3 = [0, 0, 0];
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) result[k]! += positions[indices[anchor.triangle * 3 + j]! * 3 + k]! * anchor.weights[j]!;
  return result;
}

/**
 * Surface-constrained delivery tree. A weighted graph-geodesic skeleton connects
 * area-distributed terminals; downstream demand sets radius with exponent 3.
 * Smoothed samples are projected back to local triangles, preserving attachments.
 * This is a procedural design prior, not segmented or validated anatomy.
 */
export function createAtlasVesselNetwork(organ: OrganMesh, options: AtlasVesselOptions): AtlasVesselNetwork {
  const density = options.density ?? DEFAULT_ATLAS_VESSEL_OPTIONS.density;
  const visibility = options.visibility ?? DEFAULT_ATLAS_VESSEL_OPTIONS.visibility;
  const radiusScale = options.radiusScale ?? DEFAULT_ATLAS_VESSEL_OPTIONS.radiusScale;
  const fairingPasses = options.fairingPasses ?? 0;
  if (![density, visibility, radiusScale].every(Number.isFinite) || density < 0 || density > 1 || visibility < 0 || visibility > 1 || radiusScale < 0.4 || radiusScale > 2.5 ||
      !Number.isInteger(fairingPasses) || fairingPasses < 0 || fairingPasses > 32 ||
      !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
    throw new Error("Surface vessel settings are outside their supported ranges.");
  const arrays = organ as unknown as { rest_positions?: number[] };
  const positions = arrays.rest_positions ?? organ.positions;
  if (positions.length !== organ.positions.length || positions.length % 3 || positions.some(v => !Number.isFinite(v) || Math.abs(v) > 100000) ||
      organ.indices.length % 3 || organ.indices.some(v => !Number.isInteger(v) || v < 0 || v >= positions.length / 3))
    throw new Error("Surface vessels need finite rest positions and valid surface triangles.");
  const result: AtlasVesselNetwork = { version: ATLAS_VESSEL_VERSION, seed: options.seed, organ_id: options.organId,
    provenance: "procedural-surface-design-not-patient-vasculature", settings: { density, visibility, radius_scale: radiusScale }, segments: [],
    statistics: { terminals: 0, branches: 0, connected_components: 0, length_mm: 0, murray_exponent: 3 } };
  if (!density || positions.length < 12) return result;
  if (fairingPasses) result.settings.fairing_passes = fairingPasses;
  const graph = surfaceGraph(positions, organ.indices), random = randomGenerator(options.seed);
  const n = graph.positions.length;
  const bounds = new THREE.Box3().setFromArray(positions), extent = bounds.getSize(new THREE.Vector3());
  const scale = clamp(Math.max(extent.x, extent.y, extent.z) / 180, 0.35, 1.8);
  const organName = options.organId.toLowerCase();
  const profile = organName.includes("heart") ? { radius: 0.26, depth: 0.20, terminals: 1.15 }
    : organName.includes("kidney") ? { radius: 0.14, depth: 0.60, terminals: 0.8 }
    : organName.includes("lung") ? { radius: 0.15, depth: 0.48, terminals: 1.15 }
    : { radius: 0.18, depth: 0.52, terminals: 1 };
  const rootAxis = new THREE.Vector3(0.18 + random() * 0.18, 0.8, -0.20 + random() * 0.4).normalize();
  const components: number[][] = [];
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || !graph.adjacency[start]!.size) continue;
    const component: number[] = [], stack = [start]; seen[start] = 1;
    while (stack.length) {
      const id = stack.pop()!; component.push(id);
      for (const next of graph.adjacency[id]!) if (!seen[next]) { seen[next] = 1; stack.push(next); }
    }
    components.push(component);
  }
  const totalArea = graph.areas.reduce((sum, area) => sum + area, 0);
  for (const component of components) {
    const area = component.reduce((sum, id) => sum + graph.areas[id]!, 0);
    if (component.length < 8 || area / Math.max(totalArea, 1e-12) < 0.012) continue;
    result.statistics.connected_components++;
    let root = component[0]!, rootScore = -Infinity;
    for (const id of component) {
      const score = new THREE.Vector3(...graph.positions[id]!).dot(rootAxis);
      if (score > rootScore) { root = id; rootScore = score; }
    }
    const dist = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), heap = new MinHeap();
    dist[root] = 0; heap.push(root, 0);
    const phase = random() * Math.PI * 2;
    let popped: [number, number] | undefined;
    while ((popped = heap.pop())) {
      const [id, cost] = popped;
      if (cost !== dist[id]) continue;
      for (const next of graph.adjacency[id]!) {
        const p = graph.positions[next]!, q = graph.positions[id]!;
        // A smooth positive cost field produces coherent corridors without
        // disconnected strokes or traversal through the organ interior.
        const bias = 1 + 0.32 * Math.sin((p[0] + q[0]) / (23 * scale) + phase) * Math.cos((p[2] + q[2]) / (19 * scale) - phase);
        const nextCost = cost + distance(p, q) * bias;
        if (nextCost < dist[next]!) { dist[next] = nextCost; parent[next] = id; heap.push(next, nextCost); }
      }
    }
    const terminalCount = Math.min(Math.round((20 + 135 * density) * profile.terminals * area / totalArea), Math.floor(component.length / 8));
    const cumulative: number[] = []; let sum = 0;
    for (const id of component) { sum += graph.areas[id]!; cumulative.push(sum); }
    const sampleArea = () => {
      const target = random() * sum; let lo = 0, hi = cumulative.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid]! < target) lo = mid + 1; else hi = mid; }
      return component[lo]!;
    };
    const terminals: number[] = [], terminalDemand = new Float64Array(n).fill(1), minimumSpacing = Math.sqrt(area / Math.max(terminalCount, 1)) * 0.38;
    for (let trial = 0; trial < terminalCount * 30 && terminals.length < terminalCount; trial++) {
      const candidate = sampleArea();
      if (dist[candidate]! < minimumSpacing * 1.5 || terminals.some(id => distance(graph.positions[id]!, graph.positions[candidate]!) < minimumSpacing)) continue;
      terminals.push(candidate);
    }
    // Add a second scale of delivery demand around selected terminal territories.
    // Its lower demand produces fine local twigs; it does not turn the entire
    // organ into a uniformly denser web or give every twig trunk calibre.
    for (const center of [...terminals]) {
      if (random() > 0.62 + 0.25 * density) continue;
      const local: number[] = [], reached = new Set<number>([center]), frontier = [center];
      const outer = (7 + 5 * random()) * scale, inner = outer * 0.28;
      while (frontier.length) {
        const id = frontier.pop()!;
        for (const next of graph.adjacency[id]!) {
          if (reached.has(next)) continue;
          reached.add(next);
          const d = distance(graph.positions[center]!, graph.positions[next]!);
          if (d > outer) continue;
          frontier.push(next);
          if (d > inner) local.push(next);
        }
      }
      const wanted = density > 0.65 ? 3 : 2;
      let added = 0;
      for (let trial = 0; trial < 18 && local.length && added < wanted; trial++) {
        const candidate = local[Math.floor(random() * local.length)]!;
        if (terminals.some(id => distance(graph.positions[id]!, graph.positions[candidate]!) < inner)) continue;
        terminals.push(candidate); terminalDemand[candidate] = 0.16; added++;
      }
    }
    // Attach terminals to the growing tree instead of retaining independent
    // root-to-terminal shortest paths. This shares a conveying scaffold and
    // grows local delivering twigs, avoiding a fan of near-parallel spokes.
    terminals.sort((a, b) => terminalDemand[b]! - terminalDemand[a]! || dist[b]! - dist[a]!);
    const inTree = new Uint8Array(n); inTree[root] = 1;
    parent.fill(-1);
    for (const terminal of terminals) {
      if (inTree[terminal]) continue;
      const routeCost = new Float64Array(n).fill(Infinity), routeFrom = new Int32Array(n).fill(-1), routeHeap = new MinHeap();
      routeCost[terminal] = 0; routeHeap.push(terminal, 0);
      let attachment = -1, item: [number, number] | undefined;
      while ((item = routeHeap.pop())) {
        const [id, cost] = item;
        if (cost !== routeCost[id]) continue;
        if (inTree[id]) { attachment = id; break; }
        for (const next of graph.adjacency[id]!) {
          const p = graph.positions[next]!, q = graph.positions[id]!;
          const bias = 1 + 0.22 * Math.sin((p[0] + q[0]) / (14 * scale) + phase) * Math.cos((p[2] + q[2]) / (17 * scale) - phase);
          let bend = 1;
          const previous = routeFrom[id]!;
          if (previous >= 0) {
            const before = graph.positions[previous]!;
            const incoming = q.map((v, k) => v - before[k]!), outgoing = p.map((v, k) => v - q[k]!);
            const cosine = incoming.reduce((sum, v, k) => sum + v * outgoing[k]!, 0) / Math.max(distance(q, before) * distance(p, q), 1e-9);
            bend += 0.25 * (1 - cosine);
          }
          const nextCost = cost + distance(p, q) * bias * bend;
          if (nextCost < routeCost[next]!) { routeCost[next] = nextCost; routeFrom[next] = id; routeHeap.push(next, nextCost); }
        }
      }
      if (attachment >= 0) {
        let from = attachment, next = routeFrom[from]!;
        while (next >= 0) { parent[next] = from; inTree[next] = 1; from = next; next = routeFrom[from]!; }
      }
    }
    const children = Array.from({ length: n }, () => [] as number[]);
    for (const id of component) if (inTree[id] && parent[id]! >= 0) children[parent[id]!]!.push(id);
    const nodes: number[] = [], pending = [root]; dist[root] = 0;
    while (pending.length) {
      const id = pending.pop()!; nodes.push(id);
      for (const next of children[id]!) { dist[next] = dist[id]! + distance(graph.positions[id]!, graph.positions[next]!); pending.push(next); }
    }
    const flow = new Float64Array(n);
    for (const id of [...nodes].reverse()) flow[id] = children[id]!.length ? children[id]!.reduce((sum, child) => sum + flow[child]!, 0) : terminalDemand[id]!;
    const smoothed = new Map<number, Projected>();
    for (const id of nodes) {
      const links = [...children[id]!, ...(parent[id]! >= 0 ? [parent[id]!] : [])];
      const p = graph.positions[id]!;
      let target = p;
      if (links.length === 2 && children[id]!.length === 1) {
        const a = graph.positions[links[0]!]!, b = graph.positions[links[1]!]!;
        target = p.map((v, k) => 0.4 * v + 0.3 * a[k]! + 0.3 * b[k]!) as VesselVec3;
      }
      smoothed.set(id, projectLocal(target, [id, ...links], graph, positions, organ.indices));
    }
    // A weighted geometric-median step at branch junctions minimizes the local
    // length × calibre² objective. Project every iterate back onto its local
    // surface patch; this removes the right-angle road-network appearance.
    for (let iteration = 0; iteration < 4; iteration++) {
      const next = new Map(smoothed);
      for (const id of nodes) {
        if (id === root || !children[id]!.length) continue;
        const p = smoothed.get(id)!.point;
        const links = [parent[id]!, ...children[id]!];
        const weights = links.map(other => Math.pow(other === parent[id] ? flow[id]! : flow[other]!, 2 / 3) / Math.max(distance(p, smoothed.get(other)!.point), 0.1 * scale));
        const total = weights.reduce((sum, w) => sum + w, 0);
        const target = p.map((v, k) => 0.2 * v + 0.8 * links.reduce((sum, other, j) => sum + smoothed.get(other)!.point[k]! * weights[j]!, 0) / total) as VesselVec3;
        const nearby = [id, ...graph.adjacency[id]!];
        next.set(id, projectLocal(target, nearby, graph, positions, organ.indices));
      }
      for (const [id, value] of next) smoothed.set(id, value);
    }
    // Match the initial tangent of a small daughter to its conveying parent.
    // The influence decays over the first three surface nodes, producing a
    // rounded Y attachment rather than an abrupt perpendicular incision.
    for (const id of nodes) {
      if (children[id]!.length < 2 || parent[id]! < 0) continue;
      const junction = smoothed.get(id)!.point, before = smoothed.get(parent[id]!)!.point;
      const tangent = new THREE.Vector3(...junction).sub(new THREE.Vector3(...before)).normalize();
      for (const child of children[id]!) {
        if (flow[child]! > flow[id]! * 0.6) continue;
        let cursor = child;
        for (let step = 0; step < 3; step++) {
          const current = smoothed.get(cursor)!, offset = new THREE.Vector3(...current.point).sub(new THREE.Vector3(...junction));
          const length = offset.length(), influence = (0.52 - step * 0.15);
          const direction = offset.normalize().multiplyScalar(1 - influence).addScaledVector(tangent, influence).normalize();
          const target = new THREE.Vector3(...junction).addScaledVector(direction, length).toArray() as VesselVec3;
          smoothed.set(cursor, projectLocal(target, [cursor, ...graph.adjacency[cursor]!], graph, positions, organ.indices));
          if (children[cursor]!.length !== 1) break;
          cursor = children[cursor]![0]!;
        }
      }
    }
    // Millimetre-scale, spatially coherent tortuosity, with shared junction
    // positions. It is an authored visual prior, not pathological tortuosity.
    for (const id of nodes) {
      if (parent[id]! < 0 || !children[id]!.length) continue;
      const p = smoothed.get(id)!;
      const tangent = new THREE.Vector3(...p.point).sub(new THREE.Vector3(...smoothed.get(parent[id]!)!.point)).normalize();
      const side = new THREE.Vector3(...p.normal).cross(tangent).normalize();
      const amount = 0.38 * scale * Math.sin(dist[id]! / (5.5 * scale) + phase) * Math.sin(p.point[1] / (18 * scale) - phase);
      const target = new THREE.Vector3(...p.point).addScaledVector(side, amount).toArray() as VesselVec3;
      smoothed.set(id, projectLocal(target, [id, ...graph.adjacency[id]!], graph, positions, organ.indices));
    }
    // Regular loft grids otherwise imprint visible stair-step corridors. Fair
    // degree-two runs without moving terminals or bifurcations. An expanded
    // local patch allows the path to cross grid edges, never the organ interior.
    const fairingPatches = new Map<number, number[]>();
    if (fairingPasses) for (const id of nodes) {
      if (parent[id]! < 0 || children[id]!.length !== 1) continue;
      const patch = new Set<number>([id]);
      for (let ring=0;ring<3;ring++) for (const near of [...patch]) for (const next of graph.adjacency[near]!) patch.add(next);
      fairingPatches.set(id,[...patch]);
    }
    for (let iteration=0;iteration<fairingPasses;iteration++) {
      const next = new Map(smoothed);
      for (const [id,patch] of fairingPatches) {
        const p=smoothed.get(id)!.point,a=smoothed.get(parent[id]!)!.point,b=smoothed.get(children[id]![0]!)!.point;
        const target=p.map((v,k)=>.2*v+.4*(a[k]!+b[k]!)) as VesselVec3;
        next.set(id,projectLocal(target,patch,graph,positions,organ.indices));
      }
      for (const [id,value] of next) smoothed.set(id,value);
    }
    const maxDistance = nodes.reduce((maximum, id) => Math.max(maximum, dist[id]!), 0);
    const terminalRadius = profile.radius * scale * radiusScale;
    // Keep palette identity stable while density changes the topology.
    const kind: 0 | 1 = (options.seed + result.statistics.connected_components) % 3 === 0 ? 1 : 0;
    const tangentAt=(id:number)=>{
      const point=new THREE.Vector3(...smoothed.get(id)!.point),tangent=new THREE.Vector3();
      if(parent[id]!>=0)tangent.copy(point).sub(new THREE.Vector3(...smoothed.get(parent[id]!)!.point)).normalize();
      const dominant=[...children[id]!].sort((a,b)=>flow[b]!-flow[a]!)[0];
      if(dominant!==undefined)tangent.add(new THREE.Vector3(...smoothed.get(dominant)!.point).sub(point).normalize());
      return tangent.normalize();
    };
    for (const id of nodes) {
      const p = parent[id]!;
      if (p < 0) continue;
      const a = smoothed.get(p)!, b = smoothed.get(id)!;
      if (distance(a.point, b.point) < 1e-6) continue;
      const normalVector = new THREE.Vector3(...a.normal).add(new THREE.Vector3(...b.normal));
      if (normalVector.lengthSq() < 0.01) normalVector.fromArray(a.normal);
      const normal = normalVector.normalize().toArray() as VesselVec3;
      const radius = terminalRadius * Math.cbrt(flow[id]!);
      const isTerminal = children[id]!.length === 0;
      const depth = profile.depth * (0.8 + 0.35 * Math.sin(dist[id]! / (31 * scale) + phase) ** 2);
      const ra=radius*(1+.12*(1-dist[p]!/Math.max(maxDistance,1))),rb=isTerminal?radius*.06:radius*(1+.12*(1-dist[id]!/Math.max(maxDistance,1)));
      const samples:{surface:Projected;t:number}[]=[{surface:a,t:0}];
      if(fairingPasses){
        const axis=new THREE.Vector3(...b.point).sub(new THREE.Vector3(...a.point)),length=axis.length(),ta=tangentAt(p),tb=tangentAt(id);
        axis.normalize();
        // Round only perceptible bends, keeping straight runs inexpensive.
        // All daughters share the node tangent, yielding a rounded bifurcation.
        if(length>.4&&Math.min(axis.dot(ta),axis.dot(tb))<.985){
          const curve=new THREE.CubicBezierCurve3(new THREE.Vector3(...a.point),new THREE.Vector3(...a.point).addScaledVector(ta,length*.32),new THREE.Vector3(...b.point).addScaledVector(tb,-length*.32),new THREE.Vector3(...b.point));
          const patch=[...(fairingPatches.get(p)??[p,...graph.adjacency[p]!]),...(fairingPatches.get(id)??[id,...graph.adjacency[id]!])];
          for(const t of [1/3,2/3])samples.push({surface:projectLocal(curve.getPoint(t).toArray() as VesselVec3,patch,graph,positions,organ.indices),t});
        }
      }
      samples.push({surface:b,t:1});
      for(let j=1;j<samples.length;j++){
        const from=samples[j-1]!,to=samples[j]!,n=new THREE.Vector3(...from.surface.normal).add(new THREE.Vector3(...to.surface.normal));
        result.segments.push({a_mm:from.surface.point,b_mm:to.surface.point,normal:n.lengthSq()>.01?n.normalize().toArray() as VesselVec3:normal,
          radius_a_mm:from.t===0?ra:ra+(rb-ra)*from.t,radius_b_mm:to.t===1?rb:ra+(rb-ra)*to.t,depth_mm:depth,kind,a_anchor:from.surface.anchor,b_anchor:to.surface.anchor});
        result.statistics.length_mm+=distance(from.surface.point,to.surface.point);
      }
    }
    result.statistics.terminals += nodes.filter(id => !children[id]!.length).length;
    result.statistics.fine_terminals = (result.statistics.fine_terminals ?? 0) + nodes.filter(id => !children[id]!.length && terminalDemand[id]! < 1).length;
    result.statistics.branches += nodes.filter(id => children[id]!.length > 1).length;
  }
  if (result.segments.length > 20000) throw new Error("This surface is too dense for the current vessel renderer. Use a lower resolution reference.");
  result.statistics.min_radius_mm = result.segments.reduce((r, s) => Math.min(r, s.radius_a_mm, s.radius_b_mm), Infinity);
  result.statistics.max_radius_mm = result.segments.reduce((r, s) => Math.max(r, s.radius_a_mm, s.radius_b_mm), 0);
  if (!result.segments.length) result.statistics.min_radius_mm = 0;
  const incoming = new Map<string, number>(), outgoing = new Map<string, number[]>();
  for (const segment of result.segments) {
    incoming.set(segment.b_mm.join(":"), segment.radius_b_mm);
    const key = segment.a_mm.join(":"), children = outgoing.get(key) ?? [];
    children.push(segment.radius_a_mm); outgoing.set(key, children);
  }
  let residual = 0;
  for (const [key, children] of outgoing) if (children.length > 1 && incoming.has(key)) {
    const parentCube = incoming.get(key)! ** 3;
    residual = Math.max(residual, Math.abs(parentCube - children.reduce((sum, radius) => sum + radius ** 3, 0)) / Math.max(parentCube, 1e-12));
  }
  result.statistics.max_junction_murray_relative_error = residual;
  return result;
}

export const ATLAS_VESSEL_ARTERY_LINEAR: VesselVec3 = [0.1626471937, 0.0134117489, 0.0196066485]; // sRGB (.44,.12,.15)
export const ATLAS_VESSEL_VEIN_LINEAR: VesselVec3 = [0.0732389559, 0.0196066485, 0.0396819095]; // sRGB (.30,.15,.22)

export interface AtlasVesselSample { artery: number; vein: number; heightMm: number; gradient: VesselVec3; core: number }
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Reference field shared with the GPU and Python 4K baker. */
export function sampleAtlasVessels(point: VesselVec3, normal: VesselVec3, network: AtlasVesselNetwork, footprintMm = 0): AtlasVesselSample {
  const sample: AtlasVesselSample = { artery: 0, vein: 0, heightMm: 0, gradient: [0, 0, 0], core: 0 };
  for (const segment of network.segments) {
    const axis = segment.b_mm.map((v, k) => v - segment.a_mm[k]!) as VesselVec3;
    const offset = point.map((v, k) => v - segment.a_mm[k]!) as VesselVec3;
    const axis2 = axis.reduce((sum, v) => sum + v * v, 0);
    const t = clamp(offset.reduce((sum, v, k) => sum + v * axis[k]!, 0) / Math.max(axis2, 1e-12), 0, 1);
    const delta = offset.map((v, k) => v - t * axis[k]!) as VesselVec3;
    const d2 = delta.reduce((sum, v) => sum + v * v, 0);
    const radius = segment.radius_a_mm * (1 - t) + segment.radius_b_mm * t;
    const depth = segment.depth_mm;
    const alignment = smoothstep(0.15, 0.55, normal.reduce((sum, v, k) => sum + v * segment.normal[k]!, 0));
    const w = radius + 0.2 * depth, w2 = w * w + 0.2 * footprintMm * footprintMm;
    const core = Math.exp(-2 * d2 / w2 - 0.8 * depth) * alignment * w / Math.sqrt(w2);
    const haloWidth = radius * 2.3 + 0.7 * depth;
    if (d2 > 4 * haloWidth * haloWidth) continue;
    const halo = Math.exp(-2 * d2 / (haloWidth * haloWidth) - 0.8 * depth) * alignment;
    const opacity = network.settings.visibility * (0.62 * core + 0.12 * halo);
    if (segment.kind === 0) sample.artery = Math.max(sample.artery, opacity); else sample.vein = Math.max(sample.vein, opacity);
    sample.core = Math.max(sample.core, core * network.settings.visibility);
    const height = 0.1 * radius * core * network.settings.visibility;
    if (height > sample.heightMm) {
      sample.heightMm = height;
      sample.gradient = delta.map(v => -4 * v * height / w2) as VesselVec3;
    }
  }
  return sample;
}

export function applyAtlasVesselColor(baseLinear: VesselVec3, sample: AtlasVesselSample): VesselVec3 {
  return baseLinear.map((v, k) => (v * (1 - sample.artery) + ATLAS_VESSEL_ARTERY_LINEAR[k]! * sample.artery) * (1 - sample.vein) + ATLAS_VESSEL_VEIN_LINEAR[k]! * sample.vein) as VesselVec3;
}
