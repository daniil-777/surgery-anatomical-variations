import * as THREE from "three";

export const VIRTAMED_SURFACE_VERSION = "serosal-microstructure/3";
type Point = [number, number];
export interface VascularBranch {
  parent: number | null;
  parentSample: number;
  vein: boolean;
  depth: number;
  points: Point[];
  radii: number[];
}

/** Authored superficial branches in a periodic unit square, not recovered
 * anatomy. Side branches inherit their parent's position and initial tangent;
 * unequal, curved daughters gradually taper beneath the serosa. */
export function buildSerosalBranches(seed = 763): VascularBranch[] {
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const branches: VascularBranch[] = [];
  const grow = (origin: Point, angle: number, length: number, radius: number, depth: number, vein: boolean, parent: number | null, parentSample: number, turn: number) => {
    const id = branches.length, steps = 32;
    const branch: VascularBranch = { parent, parentSample, vein, depth, points: [origin], radii: [radius] };
    branches.push(branch);
    const phase = random() * Math.PI * 2, bend = (random() - .5) * 1.3;
    const headings = [angle];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Turn after leaving the parent: no angular fork or disconnected root.
      const heading = angle + turn * (1 - Math.exp(-t * 7)) + bend * t + .22 * Math.sin(t * 8 + phase) * Math.sin(t * Math.PI);
      const previous = branch.points[i - 1]!;
      branch.points.push([previous[0] + Math.cos(heading) * length / steps, previous[1] + Math.sin(heading) * length / steps]);
      headings.push(heading);
      branch.radii.push(radius * (1 - t) ** .85);
    }
    if (depth === 3) return;
    const count = depth === 0 ? 5 : 3;
    const side = random() > .5 ? 1 : -1;
    for (let child = 0; child < count; child++) {
      const at = Math.round(steps * (.22 + child * (depth === 0 ? .135 : .22) + random() * .04));
      const childRadius = branch.radii[at]! * (.38 + random() * .17);
      grow(branch.points[at]!, headings[at]!, length * (.29 + random() * .19), childRadius, depth + 1, vein, id, at, side * (child % 2 ? -1 : 1) * (.62 + random() * .48));
    }
  };
  for (let root = 0; root < 7; root++) {
    grow([.12 + (root % 3) * .34 + random() * .08, .13 + Math.floor(root / 3) * .3 + random() * .12], random() * Math.PI * 2,
      .31 + random() * .12, root % 3 === 1 ? .0042 : .0035, 0, root % 3 === 1, null, 0, (random() - .5) * .6);
  }
  return branches;
}

/** RG: antialiased arterial/venous coverage. B: broad under-surface color halo.
 * A: bounded relief. Rasterize unwrapped paths; wrap only the destination so
 * crossing the texture boundary never cuts a branch. Subpixel terminals lose
 * coverage rather than retaining a constant one-pixel width. */
export function rasterSerosalBranches(branches: VascularBranch[], side = 1024): Uint8Array {
  if (!Number.isInteger(side) || side < 32 || side > 2048) throw new Error("Invalid vascular texture size");
  const data = new Uint8Array(side * side * 4), wrap = (n: number) => ((n % side) + side) % side;
  for (const branch of branches) for (let i = 1; i < branch.points.length; i++) {
    const a = branch.points[i - 1]!, b = branch.points[i]!;
    const ax = a[0] * side, ay = a[1] * side, dx = (b[0] - a[0]) * side, dy = (b[1] - a[1]) * side;
    const r0 = branch.radii[i - 1]! * side, r1 = branch.radii[i]! * side;
    const pad = Math.ceil(Math.max(r0, r1) * 3 + 1), length2 = dx * dx + dy * dy;
    for (let y = Math.floor(Math.min(ay, ay + dy) - pad); y <= Math.ceil(Math.max(ay, ay + dy) + pad); y++) {
      for (let x = Math.floor(Math.min(ax, ax + dx) - pad); x <= Math.ceil(Math.max(ax, ax + dx) + pad); x++) {
        const t = Math.max(0, Math.min(1, ((x + .5 - ax) * dx + (y + .5 - ay) * dy) / Math.max(1e-12, length2)));
        const radius = r0 + (r1 - r0) * t, distance = Math.hypot(x + .5 - ax - dx * t, y + .5 - ay - dy * t);
        const coverage = Math.min(1, radius * 2) * Math.max(0, Math.min(1, radius + .7 - distance));
        const halo = Math.exp(-((distance / Math.max(.65, radius * 2.5)) ** 2)) * Math.min(1, radius);
        // Root trunks emerge through depth/opacity, not a needle-shaped tip.
        const emergence = Math.min(1, ((i - 1 + t) / (branch.points.length - 1)) / .22);
        const visibility = branch.parent === null ? emergence * emergence * (3 - 2 * emergence) : 1;
        const opacity = (.92 - branch.depth * .12) * visibility, at = (wrap(y) * side + wrap(x)) * 4, channel = branch.vein ? 1 : 0;
        data[at + channel] = Math.max(data[at + channel]!, Math.round(coverage * opacity * 255));
        data[at + 2] = Math.max(data[at + 2]!, Math.round(halo * opacity * 255));
        data[at + 3] = Math.max(data[at + 3]!, Math.round(coverage * Math.min(1, radius / 3) * 255));
      }
    }
  }
  return data;
}

const textures = new WeakMap<THREE.Texture, THREE.DataTexture>();
/** One GPU allocation per scene; lifetime follows its existing tissue volume. */
export function serosalVascularTexture(owner: THREE.Texture): THREE.DataTexture {
  const existing = textures.get(owner); if (existing) return existing;
  const texture = new THREE.DataTexture(rasterSerosalBranches(buildSerosalBranches()), 1024, 1024);
  texture.name = VIRTAMED_SURFACE_VERSION;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.anisotropy = 8; texture.needsUpdate = true;
  textures.set(owner, texture);
  const dispose = () => { texture.dispose(); textures.delete(owner); owner.removeEventListener("dispose", dispose); };
  owner.addEventListener("dispose", dispose);
  return texture;
}
