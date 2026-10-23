import { bloodAppearanceTransport } from "../experiments/bloodAppearanceOptics";
import { APPEARANCE_MAX_M, APPEARANCE_SCALE_M } from "../experiments/bloodAppearanceLut.generated";

/** Entries along log-spaced slab thickness; row 0 = reflectance, row 1 = transmittance. */
export const POOL_OPTICS_ENTRIES = 96;
export const POOL_OPTICS_SCALE_M = APPEARANCE_SCALE_M;
export const POOL_OPTICS_MAX_M = APPEARANCE_MAX_M;
const LOG_MAX = Math.log1p(POOL_OPTICS_MAX_M / POOL_OPTICS_SCALE_M);

export const poolOpticsThicknessM = (index: number) =>
  POOL_OPTICS_SCALE_M * Math.expm1(index / (POOL_OPTICS_ENTRIES - 1) * LOG_MAX);

/**
 * Saline irrigation dilutes absorbers and scatterers alike. In the
 * independent-scattering limit a slab of thickness d at whole-blood volume
 * fraction φ has the same optical depths as a whole-blood slab of φ·d. Dependent
 * scattering at high haematocrit and haemolysis are not modelled.
 */
export const equivalentWholeBloodThicknessM = (thicknessM: number, bloodFraction: number) => {
  if (!Number.isFinite(thicknessM) || thicknessM < 0 || !Number.isFinite(bloodFraction) || bloodFraction <= 0 || bloodFraction > 1)
    throw new RangeError("Invalid diluted-blood slab");
  return thicknessM * bloodFraction;
};

/** RGBA32F texture data (POOL_OPTICS_ENTRIES × 2) for the WGSL slab lookup. */
export function buildPoolOpticsLut(oxygenation: number, target: Float32Array<ArrayBuffer> = new Float32Array(POOL_OPTICS_ENTRIES * 2 * 4)): Float32Array<ArrayBuffer> {
  if (target.length !== POOL_OPTICS_ENTRIES * 8) throw new RangeError("Pool optics LUT has the wrong size");
  for (let i = 0; i < POOL_OPTICS_ENTRIES; i++) {
    const { reflectance, transmittance } = bloodAppearanceTransport(poolOpticsThicknessM(i), oxygenation);
    target.set([...reflectance, 1], i * 4);
    target.set([...transmittance, 1], (POOL_OPTICS_ENTRIES + i) * 4);
  }
  return target;
}

/** WGSL lookup mirroring poolOpticsThicknessM (linear interpolation in log thickness). */
export const POOL_OPTICS_WGSL = /* wgsl */`
const OPTICS_ENTRIES: f32 = ${POOL_OPTICS_ENTRIES}.0;
fn opticsIndex(thicknessM: f32) -> f32 {
  return clamp(log(1.0 + min(max(thicknessM, 0.0), ${POOL_OPTICS_MAX_M}) / ${POOL_OPTICS_SCALE_M}) / ${LOG_MAX} * (OPTICS_ENTRIES - 1.0), 0.0, OPTICS_ENTRIES - 1.0);
}
fn opticsRow(row: u32, thicknessM: f32) -> vec3f {
  let x = opticsIndex(thicknessM);
  let lo = u32(floor(x));
  let hi = min(lo + 1u, u32(OPTICS_ENTRIES) - 1u);
  return mix(textureLoad(opticsLut, vec2u(lo, row), 0).rgb, textureLoad(opticsLut, vec2u(hi, row), 0).rgb, fract(x));
}
// Symmetric diffuse slab over a diffusely reflecting, top-lit substrate
// (same closed form as optics.ts composeDiffuseSubstrate).
fn slabOverSubstrate(thicknessM: f32, substrate: vec3f, substrateIrradiance: vec3f) -> vec3f {
  if (thicknessM <= 0.0) { return substrate * substrateIrradiance; }
  let r = clamp(opticsRow(0u, thicknessM), vec3f(0.0), vec3f(1.0));
  let t = min(clamp(opticsRow(1u, thicknessM), vec3f(0.0), vec3f(1.0)), vec3f(1.0) - r);
  let s = clamp(substrate, vec3f(0.0), vec3f(1.0));
  return r + t * t * s * substrateIrradiance / max(vec3f(1.0) - r * s, vec3f(1e-4));
}
`;
