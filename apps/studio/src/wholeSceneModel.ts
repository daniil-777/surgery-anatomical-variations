/** Shared world-space anatomy variation. Millimetres, +Y superior, +Z anterior.
 * Every structure is evaluated by the same invertible map, including narrow ducts.
 * This is a synthetic appearance study, not a patient/disease prediction model. */
export const WHOLE_SCENE_CATEGORIES = ["digestive", "respiratory", "cardiovascular", "urinary", "skeleton", "connective"] as const;
export type WholeSceneCategory = typeof WHOLE_SCENE_CATEGORIES[number];
export type WholeSceneView = "front" | "back" | "left" | "right" | "top" | "oblique";
export interface WholeSceneVariation {
  seed: number;
  strength: number;
  severity: number;
  baseline: boolean;
}
export const BASELINE_VARIATION: WholeSceneVariation = Object.freeze({ seed: 0, strength: 0, severity: 0, baseline: true });
export const WHOLE_SCENE_PROFILE = "Synthetic tissue congestion / patchy inflammation";
const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export function createWholeSceneVariation(seed: number, strength = 0.65, severity = 0.35): WholeSceneVariation {
  return { seed: (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0, strength: clamp01(strength), severity: clamp01(severity), baseline: false };
}
export function sceneRandom(seed: number, channel: number): number {
  let x = (seed ^ Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}
export function sceneStringSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}
export interface WholeSceneWarp {
  sx: number; sy: number; sz: number;
  bendX: number; bendZ: number; shearY: number;
  phaseX: number; phaseZ: number; phaseY: number;
  swelling: number;
}
export function wholeSceneWarp(variation: WholeSceneVariation): WholeSceneWarp {
  const strength = variation.baseline ? 0 : clamp01(variation.strength);
  const severity = variation.baseline ? 0 : clamp01(variation.severity);
  const signed = (channel: number) => sceneRandom(variation.seed, channel) * 2 - 1;
  return {
    sx: 1 + strength * (0.03 + 0.055 * signed(0)),
    sy: 1 + strength * (0.012 + 0.025 * signed(1)),
    sz: 1 + strength * (0.025 + 0.06 * signed(2)),
    bendX: signed(3) * strength * 8,
    bendZ: signed(4) * strength * 6,
    shearY: signed(5) * strength * 4,
    phaseX: sceneRandom(variation.seed, 6) * Math.PI * 2,
    phaseZ: sceneRandom(variation.seed, 7) * Math.PI * 2,
    phaseY: sceneRandom(variation.seed, 8) * Math.PI * 2,
    swelling: severity * 0.045,
  };
}
/** Composition of two triangular shears and positive scales. Analytic determinant
 * sx*(1+swelling*g(y))*sz*(1+swelling*g(y))*sy > 0 everywhere.
 * No independent organ centering/scaling, stochastic per-vertex displacements,
 * or local discontinuities can separate atlas-coincident connections. */
export function warpScenePoint(x: number, y: number, z: number, warp: WholeSceneWarp): [number, number, number] {
  const bulge = 1 + warp.swelling * Math.exp(-(((y + 65) / 210) ** 2));
  const px = x * warp.sx * bulge + warp.bendX * Math.sin(y / 230 + warp.phaseX);
  const pz = z * warp.sz * bulge + warp.bendZ * Math.sin(y / 200 + warp.phaseZ) + warp.bendX * 0.2 * Math.sin(px / 200);
  const py = y * warp.sy + warp.shearY * Math.sin(px / 240 + warp.phaseY) * Math.cos(pz / 220);
  return [px, py, pz];
}
export function warpScenePositions(rest: ArrayLike<number>, variation: WholeSceneVariation): Float32Array {
  if (rest.length % 3) throw new Error("Anatomy positions must contain complete XYZ triples.");
  const output = new Float32Array(rest.length);
  if (variation.baseline) { output.set(rest); return output; }
  const warp = wholeSceneWarp(variation);
  for (let i = 0; i < rest.length; i += 3) {
    const xyz = warpScenePoint(rest[i]!, rest[i + 1]!, rest[i + 2]!, warp);
    if (!xyz.every(Number.isFinite)) throw new Error("The anatomy variation contains non-finite coordinates.");
    output.set(xyz, i);
  }
  return output;
}
export interface WholeSceneTissue {
  hueShift: number; saturation: number; lightness: number; roughness: number;
  clearcoat: number; mottling: number; disease: number; seed: number;
}
export function wholeSceneTissue(id: string, category: WholeSceneCategory, variation: WholeSceneVariation): WholeSceneTissue {
  const seed = (sceneStringSeed(id) ^ variation.seed) >>> 0;
  const strength = variation.baseline ? 0 : clamp01(variation.strength);
  const disease = variation.baseline ? 0 : clamp01(variation.severity);
  const bone = category === "skeleton";
  return {
    hueShift: (sceneRandom(seed, 20) - 0.5) * 0.038 * strength,
    saturation: 1 + (sceneRandom(seed, 21) - 0.4) * 0.34 * strength,
    lightness: 1 + (sceneRandom(seed, 22) - 0.6) * 0.2 * strength - disease * (bone ? 0.015 : 0.075),
    roughness: (bone ? 0.6 : 0.43) + (sceneRandom(seed, 23) - 0.5) * 0.14 * strength + disease * 0.035,
    clearcoat: bone ? 0.04 : 0.2 + sceneRandom(seed, 24) * 0.06,
    mottling: (bone ? 0.055 : 0.15) + strength * 0.045,
    disease: bone ? disease * 0.12 : disease,
    seed: variation.baseline ? sceneStringSeed(id) % 8192 : seed % 8192,
  };
}
/** Compact deterministic witness of actual vertex data (not a seed-only label). */
export function sceneBufferSignature(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
