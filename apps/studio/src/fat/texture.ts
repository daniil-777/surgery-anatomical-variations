import type { FatPreset } from "./generator";

/** Physical width of one repeat; triplanar coordinates should be in mm. */
export const FAT_TEXTURE_VERSION = "viscera-fat-texture-v3";
export const FAT_TEXTURE_TILE_MM = 72;
export type FatTextureMap = "color" | "normal" | "roughness" | "height";
export const FAT_TEXTURE_MAPS: readonly FatTextureMap[] = ["color", "normal", "roughness", "height"];

export interface FatTextureConfig {
  textureSeed: number;
  preset?: FatPreset;
  lobuleScale?: number;
  septaStrength?: number;
  vascularity?: number;
  colorVariation?: number;
  wetness?: number;
  normalStrength?: number;
}

export interface FatTextureBaker {
  readonly resolution: number;
  /** Internal scalar-field allocation. Output buffers are owned by the caller. */
  readonly workingBytes: number;
  /** Return exactly rowCount rows; target must be an equally sized buffer. */
  bakeRows(map: FatTextureMap, startRow: number, rowCount: number, target?: Uint8Array): Uint8Array;
  bake(map: FatTextureMap): Uint8Array;
}

const clamp = (x: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mod = (x: number, period: number) => ((x % period) + period) % period;
const smooth = (t: number) => t * t * (3 - 2 * t);

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface NoiseSample { value: number; dx: number; dy: number }
/** Periodic cubic value noise and analytic derivatives in UV units. */
function noise(u: number, v: number, periods: number, seed: number, out: NoiseSample): void {
  const x = u * periods, y = v * periods, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = smooth(fx), sy = smooth(fy), gx = 6 * fx * (1 - fx) * periods, gy = 6 * fy * (1 - fy) * periods;
  const x0 = mod(ix, periods), y0 = mod(iy, periods), x1 = (x0 + 1) % periods, y1 = (y0 + 1) % periods;
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  out.value = mix(mix(a, b, sx), mix(c, d, sx), sy);
  out.dx = mix(b - a, d - c, sy) * gx;
  out.dy = mix(c - a, d - b, sx) * gy;
}

interface CellSample { first: number; gap: number; variation: number }
function cell(u: number, v: number, periods: number, seed: number, out: CellSample): void {
  const x = u * periods, y = v * periods, ix = Math.floor(x), iy = Math.floor(y);
  let first = Infinity, second = Infinity, variation = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, hx = mod(cx, periods), hy = mod(cy, periods);
    const px = cx + .08 + .84 * hash(hx, hy, seed) - x;
    const py = cy + .08 + .84 * hash(hx, hy, seed ^ 0x4f9bb) - y;
    const distance = px * px + py * py;
    if (distance < first) {
      second = first; first = distance; variation = hash(hx, hy, seed ^ 0x613a91);
    } else if (distance < second) second = distance;
  }
  out.first = Math.sqrt(first); out.gap = Math.sqrt(second) - out.first; out.variation = variation;
}

interface VesselSegment { x: number; y: number; dx: number; dy: number; inverseLengthSq: number; width: number; endWidth: number }
function vesselTree(seed: number): VesselSegment[] {
  const segments: VesselSegment[] = [];
  let drawIndex = 0;
  const random = () => hash(drawIndex++, 691, seed ^ 0x1517e);
  function branch(x: number, y: number, angle: number, length: number, depth: number): void {
    let px = x, py = y, heading = angle;
    const radius = .00045 * 1.85 ** depth;
    for (let i = 0; i < 6; i++) {
      heading += (random() - .5) * .24;
      const dx = Math.cos(heading) * length / 6, dy = Math.sin(heading) * length / 6;
      segments.push({ x: px, y: py, dx, dy, inverseLengthSq: 1 / (dx * dx + dy * dy), width: radius * (1 - .3 * i / 6), endWidth: radius * (1 - .3 * (i + 1) / 6) });
      px += dx; py += dy;
    }
    if (depth > 0) {
      branch(px, py, heading - .45 - random() * .4, length * .61, depth - 1);
      branch(px, py, heading + .45 + random() * .4, length * .61, depth - 1);
    }
  }
  branch(random(), random(), random() * Math.PI * 2, .35, 2);
  return segments;
}

function validate(config: FatTextureConfig, resolution: number): void {
  if (!Number.isSafeInteger(config.textureSeed)) throw new RangeError("textureSeed must be a safe integer");
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 4096) throw new RangeError("Texture resolution must be an integer from 8 to 4096");
  if (config.preset !== undefined && !["subcutaneous", "visceral", "omental"].includes(config.preset)) throw new RangeError("Unknown fat preset");
  const ranges: [keyof FatTextureConfig, number, number][] = [["lobuleScale", .4, 2.5], ["septaStrength", 0, 2], ["vascularity", 0, 2], ["colorVariation", 0, 2], ["wetness", 0, 1], ["normalStrength", 0, 3]];
  for (const [key, low, high] of ranges) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high)) throw new RangeError(`${key} must be from ${low} to ${high}`);
  }
}

/**
 * Pure typed-array baking, safe to run in a Web Worker. The bounded 512² field
 * resolves gross lobules/septa; independent analytic microstructure is evaluated
 * at every requested output texel (including 4K). It is not a resized 512px map.
 * Only one output map is allocated at a time. Chunked rows permit cancellation
 * and progress reporting without reserving four 64 MiB buffers together.
 */
export function createFatTextureBaker(config: FatTextureConfig, resolution: number): FatTextureBaker {
  validate(config, resolution);
  const seed = config.textureSeed | 0;
  const baseSize = Math.min(512, resolution), channels = 7;
  const field = new Float32Array(baseSize * baseSize * channels);
  const periods = Math.max(5, Math.round(15 / (config.lobuleScale ?? 1)));
  const finePeriods = Math.round(periods * 3.2);
  const wetness = config.wetness ?? .6, septaStrength = config.septaStrength ?? 1;
  const vascularity = config.vascularity ?? .55, variation = config.colorVariation ?? 1, normalStrength = config.normalStrength ?? 1;
  const vesselSegments = vascularity > 0 ? vesselTree(seed) : [];
  const n: NoiseSample = { value: 0, dx: 0, dy: 0 }, coarse: CellSample = { first: 0, gap: 0, variation: 0 }, fine: CellSample = { first: 0, gap: 0, variation: 0 };
  for (let y = 0; y < baseSize; y++) for (let x = 0; x < baseSize; x++) {
    const u = x / baseSize, v = y / baseSize, offset = (y * baseSize + x) * channels;
    noise(u, v, 4, seed ^ 0x2e1b3, n); let warpU = (n.value - .5) * .075;
    noise(u, v, 5, seed ^ 0x3f19, n); let warpV = (n.value - .5) * .075;
    // Several wavelengths bend septa locally; an unwarped Voronoi diagram
    // looks like cracked wax rather than a soft lobular connective network.
    noise(u, v, 17, seed ^ 0x9fe13, n); warpU += (n.value - .5) * .033;
    noise(u, v, 19, seed ^ 0x1abf3, n); warpV += (n.value - .5) * .033;
    noise(u, v, 59, seed ^ 0x3ae71, n); warpU += (n.value - .5) * .008;
    noise(u, v, 61, seed ^ 0x9bc71, n); warpV += (n.value - .5) * .008;
    cell(u + warpU, v + warpV, periods, seed, coarse);
    cell(u + warpV * .7, v - warpU * .7, finePeriods, seed ^ 0x7ac91, fine);
    noise(u, v, 7, seed ^ 0x37a11, n); const broad = n.value - .5;
    const majorSepta = Math.exp(-coarse.gap * 42), minorSepta = Math.exp(-fine.gap * 55);
    noise(u, v, 27, seed ^ 0x63f19, n); const mottling = n.value - .5;
    noise(u, v, 3, seed ^ 0x1fab3, n);
    const membrane = smooth(clamp((n.value - .2) / .6));
    const exposed = 1 - membrane * .7;
    const connective = clamp((majorSepta * .31 + minorSepta * .025) * clamp(.65 + mottling * 2.2, .15, 1) * septaStrength * exposed);
    const lobule = Math.exp(-coarse.first * coarse.first * 2.4);
    let vessel = 0, vesselHalo = 0;
    for (const segment of vesselSegments) {
      // Nearest periodic copy of each short segment, using its midpoint.
      const px = u - segment.x - Math.round(u - segment.x - segment.dx * .5);
      const py = v - segment.y - Math.round(v - segment.y - segment.dy * .5);
      const t = clamp((px * segment.dx + py * segment.dy) * segment.inverseLengthSq);
      const dx = px - t * segment.dx, dy = py - t * segment.dy;
      const width = mix(segment.width, segment.endWidth, t);
      // Integrate a subtexel vessel footprint approximately as a Gaussian.
      // Point-sampling branches narrower than the scalar-field grid creates
      // dotted red segments that no later 4K upsampling can recover.
      const filteredWidth = Math.hypot(width, .45 / baseSize);
      const distanceSq = (dx * dx + dy * dy) / (filteredWidth * filteredWidth);
      if (distanceSq < 40) vesselHalo = Math.max(vesselHalo, Math.exp(-distanceSq * .12));
      if (distanceSq < 10) vessel = Math.max(vessel, Math.exp(-distanceSq * 1.3) * width / filteredWidth);
    }
    vessel = clamp(vessel * vascularity * .7);
    // Mostly continuous variation prevents flat, separately coloured polygons.
    const cellVariation = (coarse.variation - .5) * variation;
    const tone = broad * 28 * variation + mottling * 9 * variation + cellVariation * 3;
    const visceralShift = config.preset === "visceral" ? -5 : config.preset === "omental" ? 6 : 0;
    // sRGB albedo: yellow / cream fat, pale collagen and sparse red vessels.
    let r = 232 + tone + lobule * 5, g = 192 + tone * .85 + lobule * 10 + visceralShift, b = 128 + tone * .75 + lobule * 13 + visceralShift;
    r = mix(r, 241, connective); g = mix(g, 221, connective); b = mix(b, 185, connective);
    r = mix(r, 163, vessel); g = mix(g, 69, vessel) - vesselHalo * vascularity * 5; b = mix(b, 58, vessel) - vesselHalo * vascularity * 2;
    field[offset] = r; field[offset + 1] = g; field[offset + 2] = b;
    field[offset + 3] = clamp(.34 + (lobule * .27 + Math.exp(-fine.first * fine.first * 2.8) * .045 - majorSepta * .035 * septaStrength - minorSepta * .004) * exposed + broad * .045 + mottling * .014);
    // Broad smooth film patches cross many lobules: wet regions are not a copy
    // of every cellular boundary. Both dry and wet fields stay periodic.
    field[offset + 4] = clamp(.52 - wetness * (.15 + membrane * .2) + majorSepta * .025 * exposed + broad * .055 - vessel * .025, .12, .72);
  }
  for (let y = 0; y < baseSize; y++) for (let x = 0; x < baseSize; x++) {
    const offset = (y * baseSize + x) * channels;
    field[offset + 5] = (field[(y * baseSize + (x + 1) % baseSize) * channels + 3]! - field[(y * baseSize + (x + baseSize - 1) % baseSize) * channels + 3]!) * baseSize * .5;
    field[offset + 6] = (field[(((y + 1) % baseSize) * baseSize + x) * channels + 3]! - field[(((y + baseSize - 1) % baseSize) * baseSize + x) * channels + 3]!) * baseSize * .5;
  }

  const microPeriods = Math.max(2, Math.min(768, Math.floor(resolution / 4)));
  function bakeRows(map: FatTextureMap, startRow: number, rowCount: number, target?: Uint8Array): Uint8Array {
    if (!FAT_TEXTURE_MAPS.includes(map)) throw new RangeError("Unknown texture map");
    if (!Number.isInteger(startRow) || !Number.isInteger(rowCount) || startRow < 0 || rowCount < 0 || startRow + rowCount > resolution) throw new RangeError("Texture rows are outside the image");
    const expectedLength = rowCount * resolution * 4;
    if (target && target.length !== expectedLength) throw new RangeError("Texture target has the wrong byte length");
    const output = target ?? new Uint8Array(expectedLength);
    const micro: NoiseSample = { value: 0, dx: 0, dy: 0 };
    for (let row = 0; row < rowCount; row++) {
      const y = startRow + row, v = y === resolution - 1 ? 0 : y / (resolution - 1), sy = v * baseSize;
      const iy = Math.floor(sy), fy = sy - iy, y1 = (iy + 1) % baseSize;
      for (let x = 0; x < resolution; x++) {
        const u = x === resolution - 1 ? 0 : x / (resolution - 1), sx = u * baseSize, ix = Math.floor(sx), fx = sx - ix, x1 = (ix + 1) % baseSize;
        const a = (iy * baseSize + ix) * channels, b = (iy * baseSize + x1) * channels, c = (y1 * baseSize + ix) * channels, d = (y1 * baseSize + x1) * channels;
        const outputOffset = (row * resolution + x) * 4;
        noise(u, v, microPeriods, seed ^ 0x17139, micro);
        const grain = micro.value - .5;
        if (map === "color") {
          for (let channel = 0; channel < 3; channel++) {
            const base = mix(mix(field[a + channel]!, field[b + channel]!, fx), mix(field[c + channel]!, field[d + channel]!, fx), fy);
            output[outputOffset + channel] = Math.round(clamp(base + grain * 2 * variation, 0, 255));
          }
        } else if (map === "normal") {
          const gx = mix(mix(field[a + 5]!, field[b + 5]!, fx), mix(field[c + 5]!, field[d + 5]!, fx), fy) + micro.dx * .003;
          const gy = mix(mix(field[a + 6]!, field[b + 6]!, fx), mix(field[c + 6]!, field[d + 6]!, fx), fy) + micro.dy * .003;
          const nx = -gx * .013 * normalStrength, ny = -gy * .013 * normalStrength, inverseLength = 1 / Math.hypot(nx, ny, 1);
          output[outputOffset] = Math.round((nx * inverseLength * .5 + .5) * 255);
          output[outputOffset + 1] = Math.round((ny * inverseLength * .5 + .5) * 255);
          output[outputOffset + 2] = Math.round((inverseLength * .5 + .5) * 255);
        } else {
          const channel = map === "height" ? 3 : 4;
          const base = mix(mix(field[a + channel]!, field[b + channel]!, fx), mix(field[c + channel]!, field[d + channel]!, fx), fy);
          const value = Math.round(clamp(base + grain * (map === "height" ? .003 : .025)) * 255);
          output[outputOffset] = value; output[outputOffset + 1] = value; output[outputOffset + 2] = value;
        }
        output[outputOffset + 3] = 255;
      }
    }
    return output;
  }
  return { resolution, workingBytes: field.byteLength, bakeRows, bake: (map) => bakeRows(map, 0, resolution) };
}

export function bakeFatTexture(config: FatTextureConfig, resolution: number, map: FatTextureMap): Uint8Array {
  return createFatTextureBaker(config, resolution).bake(map);
}
