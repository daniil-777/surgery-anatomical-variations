/** Authored gross omental organization, in millimetres. These fields describe
 * joined fatty cords and the membrane between them, not segmented vessels or
 * histological cells. Geometry and appearance must sample this same field. */
export interface FatDepotSample {
  readonly lipidCoverage: number;
  readonly vesselMask: number;
  readonly membraneCoverage: number;
  readonly thicknessScale: number;
}

export interface OmentalDepotField {
  /** u runs left to right; v runs from the proximal arcade toward the free edge. */
  sample(u: number, v: number): FatDepotSample;
  readonly vesselFootprintMm: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => { const t = clamp01(value); return t * t * (3 - 2 * t); };
function random(seed: number, channel: number): number {
  let value = (seed ^ Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
}

interface Cord { x: number; start: number; end: number; lean: number; bend: number; width: number; radius: number }
interface Cluster { x: number; y: number; rx: number; ry: number; cosine: number; sine: number; amount: number }
interface Segment { x: number; y: number; dx: number; dy: number; lengthSquared: number }
function cordPoint(cord: Cord, t: number): number {
  return cord.x + cord.lean * t + cord.bend * Math.sin(Math.PI * t);
}

/** A pre-sampled connected curve has a continuous closest distance including
 * branch tips. It avoids local Newton minima on short oblique branches. The
 * 24 segments approximate a smooth path; they do not trace patient vessels. */
function cordDistance(segments: readonly Segment[], x: number, y: number): { distance: number; progress: number } {
  let nearest = Infinity, progress = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const t = clamp01(((x - segment.x) * segment.dx + (y - segment.y) * segment.dy) / segment.lengthSquared);
    const dx = x - segment.x - t * segment.dx, dy = y - segment.y - t * segment.dy;
    const squared = dx * dx + dy * dy;
    if (squared < nearest) { nearest = squared; progress = (index + t) / segments.length; }
  }
  return { distance: Math.sqrt(nearest), progress };
}

export function createOmentalDepotField(seed: number, widthMm: number, heightMm: number, options: { vesselFootprintMm?: number } = {}): OmentalDepotField {
  if (!Number.isSafeInteger(seed) || !Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    throw new RangeError("Omental fields require an integer seed and positive finite dimensions.");
  }
  if (options.vesselFootprintMm !== undefined && (!Number.isFinite(options.vesselFootprintMm) || options.vesselFootprintMm <= 0)) {
    throw new RangeError("The vessel sampling footprint must be positive and finite.");
  }
  const cords: Cord[] = [], clusters: Cluster[] = [];
  const count = Math.max(3, Math.min(5, Math.round(widthMm / 54)));
  const spacing = widthMm / count;
  for (let index = 0; index < count; index++) {
    const base = index * 43;
    const parent: Cord = {
      x: ((index + .22 + .56 * random(seed, base)) / count - .5) * widthMm * .9,
      start: -heightMm * .025,
      end: heightMm * (.34 + .24 * random(seed, base + 1)),
      lean: (random(seed, base + 2) - .5) * spacing * 1.35,
      bend: (random(seed, base + 3) - .5) * spacing * .46,
      width: Math.min(8.8, spacing * (.16 + .06 * random(seed, base + 4))),
      radius: .3 + .23 * random(seed, base + 5),
    };
    cords.push(parent);
    // Short unequal trunks split early into oblique fans. Long evenly spaced
    // full-height trunks produce an embossed curtain rather than an omentum.
    for (let branch = 0; branch < 4; branch++) {
      const start = .12 + branch * .21 + .09 * random(seed, base + 6 + branch);
      const side = (index + branch) % 2 ? -1 : 1;
      const y = parent.start + (parent.end - parent.start) * start;
      cords.push({ x: cordPoint(parent, start), start: y,
        end: Math.min(heightMm * .98, Math.max(y + heightMm * .2, heightMm * (.51 + .46 * random(seed, base + 10 + branch)))),
        lean: side * spacing * (.26 + .68 * random(seed, base + 14 + branch)),
        bend: (random(seed, base + 18 + branch) - .5) * spacing * .38,
        width: parent.width * (.53 + .23 * random(seed, base + 22 + branch)), radius: parent.radius * (.4 + .3 * random(seed, base + 26 + branch)) });
    }
  }
  const paths = cords.map((cord, index) => {
    // Unequal lobule groups interrupt a continuous thin fatty sleeve. Their
    // centres follow the vascular territory while their shape is independent
    // of the path's direction; no regularly spaced bead or stripe pattern.
    const groupCount = 3 + Math.floor(random(seed, 2000 + index) * 3);
    for (let group = 0; group < groupCount; group++) {
      const channel = 3000 + index * 41 + group * 6;
      const t = (group + .12 + .76 * random(seed, channel)) / groupCount;
      const angle = random(seed, channel + 1) * Math.PI;
      clusters.push({ x: cordPoint(cord, t) + (random(seed, channel + 2) - .5) * cord.width * 1.1,
        y: cord.start + t * (cord.end - cord.start),
        rx: cord.width * (.8 + .75 * random(seed, channel + 3)),
        ry: cord.width * (.68 + 1.05 * random(seed, channel + 4)),
        cosine: Math.cos(angle), sine: Math.sin(angle), amount: .58 + .37 * random(seed, channel + 5) });
    }
    const segments: Segment[] = [];
    for (let index = 0; index < 24; index++) {
      const t = index / 24, next = (index + 1) / 24;
      const x = cordPoint(cord, t), y = cord.start + t * (cord.end - cord.start);
      const dx = cordPoint(cord, next) - x, dy = (cord.end - cord.start) / 24;
      segments.push({ x, y, dx, dy, lengthSquared: dx * dx + dy * dy });
    }
    return { cord, segments };
  });
  // This footprint deliberately resolves the *visual path* at a 64-column
  // mesh, rather than claiming its interpolated width is a vessel diameter.
  const vesselFootprintMm = options.vesselFootprintMm ?? Math.max(.65, widthMm / 64 * .48);
  return {
    vesselFootprintMm,
    sample(u: number, v: number): FatDepotSample {
      if (!Number.isFinite(u) || !Number.isFinite(v)) throw new RangeError("Omental sample coordinates must be finite.");
      const x = (u - .5) * widthMm, y = v * heightMm;
      let sleeve = 0, vessel = 0;
      for (const { cord, segments } of paths) {
        const { distance, progress } = cordDistance(segments, x, y);
        const taper = 1 - .43 * smooth((progress - .45) / .55);
        const width = cord.width * taper;
        const ridge = Math.exp(-.5 * (distance / width) ** 2);
        // Smooth probabilistic union stays in range at branching junctions.
        sleeve += ridge * (1 - sleeve);
        const radius = Math.hypot(cord.radius * taper, vesselFootprintMm);
        const line = Math.exp(-.5 * (distance / radius) ** 2);
        vessel += line * (1 - vessel);
      }
      let groupedFat = 0;
      for (const cluster of clusters) {
        const dx = x - cluster.x, dy = y - cluster.y;
        const u = (dx * cluster.cosine + dy * cluster.sine) / cluster.rx;
        const v = (-dx * cluster.sine + dy * cluster.cosine) / cluster.ry;
        const value = Math.exp(-.5 * (u * u + v * v)) * cluster.amount;
        groupedFat += value * (1 - groupedFat);
      }
      const region = .5 + .25 * Math.sin(x * .047 + y * .031 + random(seed, 1001) * 6.28)
        + .25 * Math.sin(x * .022 - y * .043 + random(seed, 1002) * 6.28);
      const joined = sleeve * .57 + groupedFat * (1 - sleeve * .57);
      const lipidCoverage = clamp01(.035 + .96 * smooth((joined - .06) / .89) * (.93 + .07 * region));
      // Fine relief is weaker than the irregular gross lobule groups, so a
      // continuous path no longer becomes a continuous geometric ridge.
      const lobules = .5 + .25 * Math.sin(x * .59 + y * .37 + random(seed, 1003) * 6.28)
        + .25 * Math.sin(x * .31 - y * .53 + random(seed, 1004) * 6.28);
      const thicknessScale = .07 + .93 * lipidCoverage * (.58 + .28 * groupedFat + .14 * lobules);
      return { lipidCoverage, vesselMask: clamp01(vessel), membraneCoverage: 1 - lipidCoverage, thicknessScale };
    },
  };
}
