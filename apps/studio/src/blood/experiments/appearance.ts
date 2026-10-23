/** Illustrative vessel wall BRDF maps, independently authored from structural
 * observations, not histology image copies, a learned model or patient tissue.
 *
 * Sources:
 * Holzapfel et al. 2012, DOI 10.1098/rsif.2011.0888:
 * layer-specific, dispersed collagen families with predominantly axial
 * adventitial orientation. https://pubmed.ncbi.nlm.nih.gov/22171063/
 * Rezakhaniha et al. 2012, DOI 10.1007/s10237-011-0325-z:
 * observed wavy collagen families in unloaded rabbit carotid adventitia.
 *
 * The chosen relief amplitudes/roughness/reflectances below are illustrative
 * authoring parameters, not values measured or inferred from those papers.
 */
export interface ExperimentAppearance {
  illumination: "studio" | "camera";
  exposureEV: number;
  referencePatch: boolean;
  wallDetail: boolean;
  oxygenationFraction: number;
}
export const DEFAULT_EXPERIMENT_APPEARANCE: Readonly<ExperimentAppearance> = Object.freeze({
  illumination: "camera", exposureEV: 0, referencePatch: false, wallDetail: true, oxygenationFraction: .98,
});
export function resolveAppearance(current: ExperimentAppearance, change: Partial<ExperimentAppearance>): ExperimentAppearance {
  const next = { ...current, ...change };
  if (!["studio", "camera"].includes(next.illumination) || !Number.isFinite(next.exposureEV) ||
      next.exposureEV < -2 || next.exposureEV > 2 || typeof next.referencePatch !== "boolean" ||
      typeof next.wallDetail !== "boolean" || !Number.isFinite(next.oxygenationFraction) ||
      next.oxygenationFraction < 0 || next.oxygenationFraction > 1) throw new RangeError("Invalid experiment appearance");
  return next;
}
export function relativeCameraLightPower(referenceDistanceM: number, irradiance = Math.PI) {
  if (!Number.isFinite(referenceDistanceM) || referenceDistanceM <= 0 || !Number.isFinite(irradiance) || irradiance <= 0)
    throw new RangeError("Camera-light reference distance and irradiance must be positive");
  // Three decay=2 measures distance in scene units; our world unit is one mm.
  // This is a relative irradiance convention, not a measured LED lumen/lux claim.
  return irradiance * (referenceDistanceM * 1000) ** 2;
}
export function dielectricF0(ior: number) {
  if (!Number.isFinite(ior) || ior < 1 || ior > 2.333) throw new RangeError("Invalid dielectric refractive index");
  return ((ior - 1) / (ior + 1)) ** 2;
}
const TAU = 2 * Math.PI;
function hash(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x1_0000_0000; };
}
function srgb(v: number) { return v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055; }
export interface WallMapOptions {
  layer: "adventitia" | "intima";
  seed?: number;
  size?: number;
  axialPeriodM?: number;
  circumferentialPeriodM?: number;
}
/** Seamless oriented, wavy bundle relief in physical units. Mipmapped maps
 * represent unresolved surface structure; fluid heights/normals are unaffected.
 */
export function vesselWallMapData(options: WallMapOptions) {
  const size = options.size ?? 512, axialPeriodM = options.axialPeriodM ?? .004,
    circumferentialPeriodM = options.circumferentialPeriodM ?? .004, seed = options.seed ?? 0x71ab29;
  if (!["adventitia", "intima"].includes(options.layer) || !Number.isInteger(size) || size < 16 || size > 2048 ||
      ![axialPeriodM, circumferentialPeriodM].every(v => Number.isFinite(v) && v > 0 && v <= .1) ||
      !Number.isInteger(seed)) throw new RangeError("Invalid vessel-wall map dimensions");
  const random = hash(seed), phases = Array.from({ length: 10 }, () => random() * TAU);
  const intima = options.layer === "intima", amplitudeM = intima ? .35e-6 : 3.5e-6;
  const field = new Float64Array(size * size), pattern = new Float32Array(size * size);
  const colour = new Uint8Array(size * size * 4), normal = new Uint8Array(size * size * 4), roughness = new Uint8Array(size * size * 4);
  const base = intima ? [.29, .095, .078] : [.39, .235, .185];
  // The diffuse modulation occupies [0.9755,1.0795]. A bounded 4096-node
  // encoding table avoids three pow() calls per texel while remaining well
  // below one 8-bit output quantum. No stochastic or screen-dependent shading.
  const encodedColour = new Uint8Array(4096 * 3);
  for (let i = 0; i < 4096; i++) for (let ch = 0; ch < 3; ch++)
    encodedColour[i * 3 + ch] = Math.round(srgb(base[ch]! * (.95 + .15 * i / 4095)) * 255);
  const family = (u: number, v: number, ku: number, kv: number, phase: number, modulation: number) => {
    const p = TAU * (ku * u + kv * v) + phase + .8 * Math.sin(TAU * (u + 2 * v) + modulation);
    return Math.exp(-((Math.sin(p) / .32) ** 2));
  };
  let heightMinM = Infinity, heightMaxM = -Infinity, roughnessMin = 1, roughnessMax = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    // Integer winding numbers make the tile continuous across both boundaries.
    // Opposing, crimped families are predominantly axial in adventitia; intimal
    // relief is much smaller and broader in orientation.
    const a = family(u, v, intima ? 7 : 4, 13, phases[0]!, phases[1]!);
    const b = family(u, v, intima ? -9 : -5, 12, phases[2]!, phases[3]!);
    const c = family(u, v, 12, 2, phases[4]!, phases[5]!);
    const bundle = (a + .8 * b + .16 * c) / 1.96;
    const coverage = .5 + .2 * Math.sin(TAU * (u + v) + phases[6]!) + .15 * Math.sin(TAU * (2 * u - v) + phases[7]!);
    const h = amplitudeM * bundle * (.75 + .25 * coverage), i = y * size + x;
    field[i] = h; pattern[i] = bundle;
    heightMinM = Math.min(heightMinM, h); heightMaxM = Math.max(heightMaxM, h);
    const modulation = 1 + .07 * (coverage - .5) + .055 * bundle;
    const colourIndex = Math.round((modulation - .95) / .15 * 4095);
    for (let ch = 0; ch < 3; ch++) colour[i * 4 + ch] = encodedColour[colourIndex * 3 + ch]!;
    colour[i * 4 + 3] = 255;
    const r = intima ? .19 + .035 * bundle : .34 + .085 * (1 - bundle);
    roughnessMin = Math.min(roughnessMin, r); roughnessMax = Math.max(roughnessMax, r);
    roughness[i * 4] = roughness[i * 4 + 1] = roughness[i * 4 + 2] = Math.round(r * 255); roughness[i * 4 + 3] = 255;
  }
  let maxSlope = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = (field[y * size + (x + 1) % size]! - field[y * size + (x + size - 1) % size]!) / (2 * axialPeriodM / size);
    const sy = (field[((y + 1) % size) * size + x]! - field[((y + size - 1) % size) * size + x]!) / (2 * circumferentialPeriodM / size);
    const inv = 1 / Math.hypot(sx, sy, 1), j = (y * size + x) * 4;
    normal[j] = Math.round((-.5 * sx * inv + .5) * 255); normal[j + 1] = Math.round((-.5 * sy * inv + .5) * 255);
    normal[j + 2] = Math.round((.5 * inv + .5) * 255); normal[j + 3] = 255;
    maxSlope = Math.max(maxSlope, Math.hypot(sx, sy));
  }
  return { size, colour, normal, roughness, field, pattern,
    metadata: { layer: options.layer, seed, axialPeriodM, circumferentialPeriodM,
      heightMinM, heightMaxM, roughnessMin, roughnessMax, maxSlope,
      provenance: "Illustrative structured fiber maps; not patient measured or learned." } };
}
// CPU maps are immutable in renderer use. Four entries bound retained storage;
// each renderer still owns/disposes its own GPU texture objects. This avoids
// regenerating a million structured samples when switching vessel presets.
const wallMapCache = new Map<string, ReturnType<typeof vesselWallMapData>>();
export function cachedVesselWallMapData(options: WallMapOptions) {
  const key = JSON.stringify([options.layer, options.seed ?? 0x71ab29, options.size ?? 512,
    options.axialPeriodM ?? .004, options.circumferentialPeriodM ?? .004]);
  const present = wallMapCache.get(key);
  if (present) { wallMapCache.delete(key); wallMapCache.set(key, present); return present; }
  const result = vesselWallMapData(options);
  if (wallMapCache.size >= 4) wallMapCache.delete(wallMapCache.keys().next().value!);
  wallMapCache.set(key, result); return result;
}
