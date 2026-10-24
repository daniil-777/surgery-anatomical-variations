import { Vector2, type BufferGeometry, type Material, type Texture } from "three";

export const TISSUE_MAP_SIZE = 512;

/** Continuous periodic value noise: no per-cell color steps or visible borders. */
export function periodicTissueNoise(u: number, v: number, frequency: number, seed: number): number {
  const x = u * frequency, y = v * frequency, ix = Math.floor(x), iy = Math.floor(y);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const hash = (a: number, b: number) => {
    a = ((a % frequency) + frequency) % frequency; b = ((b % frequency) + frequency) % frequency;
    let h = Math.imul(a ^ seed, 374761393) ^ Math.imul(b, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const sx = fade(x - ix), sy = fade(y - iy);
  const a = hash(ix,iy) * (1-sx) + hash(ix+1,iy) * sx;
  const b = hash(ix,iy+1) * (1-sx) + hash(ix+1,iy+1) * sx;
  return a * (1-sy) + b * sy;
}

/** Shared optics for single uploads and whole scenes. Standard glTF channels,
 * including the clearcoat normal, carry the same detail into exported files. */
export function configureTissueOptics(material: Material, organ: string, wetness: number, roughness: number, tubular = false): void {
  const m = material as Material & {
    metalness?: number; roughness?: number; sheen?: number; envMapIntensity?: number;
    normalScale?: Vector2; normalMap?: Texture | null; roughnessMap?: Texture | null;
    clearcoat?: number; clearcoatRoughness?: number; clearcoatNormalScale?: Vector2;
    clearcoatNormalMap?: Texture | null; clearcoatRoughnessMap?: Texture | null;
  };
  if (typeof m.metalness === 'number') m.metalness = 0;
  if (typeof m.sheen === 'number') m.sheen = 0;
  if (typeof m.roughness === 'number') m.roughness = Math.min(.66, .48 + .20 * roughness - .10 * wetness);
  m.normalScale?.setScalar(tubular ? .12 : organ === 'liver' ? .30 : .40);
  if (typeof m.envMapIntensity === 'number') m.envMapIntensity = .3;
  if (typeof m.clearcoat === 'number') {
    m.clearcoat = .12 + .16 * wetness;
    m.clearcoatRoughness = .24 + .05 * (1-wetness);
    m.clearcoatNormalMap = m.normalMap ?? null;
    // Keep film roughness scalar: glTF repacks a separate clearcoat roughness
    // image per material, which would exceed the whole-scene image budget.
    m.clearcoatRoughnessMap = null;
    m.clearcoatNormalScale?.setScalar(.55);
  }
}

export function tubularStructure(name: string): "artery" | "vein" | "duct" | undefined {
  const token = name.toLowerCase().replace(/[_\s]+/g, "-");
  if (/artery|arterial|aorta|celiac-trunk/.test(token)) return "artery";
  if (/vein|venous|vena/.test(token)) return "vein";
  if (/duct/.test(token)) return "duct";
  return undefined;
}

export interface VascularTable {
  arteryMask: Float32Array;
  veinMask: Float32Array;
  vesselHeight: Float32Array;
  adiposeHalo: Float32Array;
  fasciaWave: Float32Array;
}

/** Authored surface detail, not a reconstruction of a patient's vasculature.
 * Every child starts at its parent's endpoint. Rasterize the unwrapped tree,
 * wrapping only the pixel address, so branches also join across tile borders. */
export function buildVascularTable(seed: number, side = TISSUE_MAP_SIZE): VascularTable {
  const table: VascularTable = {
    arteryMask: new Float32Array(side * side), veinMask: new Float32Array(side * side),
    vesselHeight: new Float32Array(side * side), adiposeHalo: new Float32Array(side * side),
    fasciaWave: new Float32Array(side * side),
  };
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const wrap = (n: number) => ((n % side) + side) % side;
  const segment = (ax: number, ay: number, bx: number, by: number, r0: number, r1: number, vein: boolean, depth: number) => {
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    const pad = Math.ceil(r0 * 3 + 1);
    for (let y = Math.floor(Math.min(ay, by) - pad); y <= Math.ceil(Math.max(ay, by) + pad); y++) {
      for (let x = Math.floor(Math.min(ax, bx) - pad); x <= Math.ceil(Math.max(ax, bx) + pad); x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / Math.max(1e-9, length2)));
        const radius = r0 + (r1 - r0) * t;
        const distance = Math.hypot(x + 0.5 - ax - t * dx, y + 0.5 - ay - t * dy);
        const at = wrap(y) * side + wrap(x);
        // Soft subserosal edge plus an opaque, antialiased lumen. Narrow
        // terminals fade in coverage instead of disappearing between pixels.
        const coverage = Math.max(0, Math.min(1, radius + 0.65 - distance));
        const halo = Math.exp(-2 * (distance / Math.max(0.4, radius * 1.8)) ** 2) * 0.16;
        const strength = (coverage * 0.86 + halo) * (1 - depth * 0.075);
        const target = vein ? table.veinMask : table.arteryMask;
        target[at] = Math.max(target[at]!, strength);
        const height = Math.sqrt(Math.max(0, 1 - (distance / Math.max(0.4, radius)) ** 2)) * radius / (side * 0.007);
        table.vesselHeight[at] = Math.max(table.vesselHeight[at]!, height * 0.5);
        if (depth < 2) table.adiposeHalo[at] = Math.max(table.adiposeHalo[at]!, Math.exp(-((distance / (radius * 2.8)) ** 2)) * 0.6);
      }
    }
  };
  const branch = (x: number, y: number, angle: number, length: number, radius: number, depth: number, vein: boolean) => {
    const phase = random() * Math.PI * 2;
    const bend = (random() - 0.5) * 0.55;
    const steps = 16;
    let heading = angle;
    for (let step = 0; step < steps; step++) {
      const t = (step + 1) / steps;
      heading = angle + bend * t + 0.13 * Math.sin(t * 5 + phase);
      const nx = x + Math.cos(heading) * length / steps;
      const ny = y + Math.sin(heading) * length / steps;
      // Trunks emerge from beneath the capsule instead of ending in a cut rectangle.
      const emerge = (s: number) => depth === 0 ? Math.min(1, .06 + s * 5) : 1;
      segment(x, y, nx, ny, radius * (1 - 0.28 * step / steps) * emerge(step / steps), radius * (1 - 0.28 * t) * emerge(t), vein, depth);
      x = nx; y = ny;
    }
    if (depth >= 4) return;
    // Asymmetric daughter radii, conserving the cube sum at the junction.
    const split = 0.30 + random() * 0.3;
    const tipRadius = radius * 0.72;
    branch(x, y, heading + 0.38 + random() * 0.24, length * (0.64 + random() * 0.1), tipRadius * Math.cbrt(split), depth + 1, vein);
    branch(x, y, heading - 0.38 - random() * 0.24, length * (0.70 + random() * 0.1), tipRadius * Math.cbrt(1 - split), depth + 1, vein);
  };
  // Sparse, independently seeded trees leave readable tissue between vessels.
  for (let root = 0; root < 4; root++) {
    const vein = root % 2 === 1;
    branch((0.15 + (root % 2) * 0.5 + random() * 0.10) * side,
      (0.14 + Math.floor(root / 2) * 0.5 + random() * 0.12) * side,
      random() * Math.PI * 2, side * (0.24 + random() * 0.06), side * (vein ? 0.0042 : 0.0035), 0, vein);
  }
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const u = x / side * Math.PI * 2, v = y / side * Math.PI * 2;
    table.fasciaWave[y * side + x] = (0.5 + 0.5 * Math.sin(3 * u + 2 * v + 0.55 * Math.sin(u - v))) ** 5;
  }
  return table;
}

/** The projection lives in the original geometry, so all PBR channels stay
 * attached while shapes change. No normal-dependent UV wobble at mesh seams. */
export function tissueUv(organ: string, x: number, y: number, z: number): [number, number] {
  const scale = organ === "liver" || organ === "spleen" || organ === "kidney" ? 0.85 : 0.72;
  return [scale * (1.28 * x + 0.16 * y - 0.62 * z), scale * (-0.22 * x + 1.28 * y + 0.54 * z)];
}

/** Tangents must come from the actual UV derivatives, not an arbitrary axis
 * or the uploaded mesh's now-replaced UV layout. Nonindexed meshes use the
 * renderer's derivative basis, which is also supported by glTF viewers. */
export function updateTissueTangents(geometry: BufferGeometry): void {
  geometry.deleteAttribute("tangent");
  if (geometry.index && geometry.getAttribute("normal") && geometry.getAttribute("uv")) geometry.computeTangents();
}
