import { BLOOD_LUT, BLOOD_LUT_LOG_MAX, BLOOD_LUT_MAX_M, BLOOD_LUT_SCALE_M } from "./opticsLut.generated";

export type BloodOpticsRgb = readonly [number, number, number];
export interface BloodSlabTransport {
  /** Linear sRGB flux response under D65; does not include surface Fresnel. */
  reflectance: BloodOpticsRgb;
  /** Total two-stream transmission, including approximate diffuse transport. */
  transmittance: BloodOpticsRgb;
}
export interface ScalarSlabTransport { reflectance: number; transmittance: number; }

/** Public provenance is deliberately usable by the UI without loading raw spectra. */
export const BLOOD_OPTICS_PROVENANCE = Object.freeze({
  id: "bosschaart-oxy45-d65-two-stream-v1",
  label: "Spectral blood · oxygenated · Hct 45% · D65",
  model: "Homogeneous two-stream slab with reduced scattering; linear sRGB lookup",
  sourceType: "Compiled absorption measurements and calculated scattering/anisotropy",
  source: "Bosschaart et al. 2014, corrected 2022",
  sourceUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3953607/",
  correctionUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9172854/",
  conditions: "Oxygenated endpoint (>98% saturation), hematocrit 45%; D65 illuminant, CIE 1931 2° observer",
  attributionPath: "blood-optics-attribution.json",
  dataLicense: "CC BY-SA 4.0 (derived LUT); original blood table CC BY 4.0",
  limitations: "Approximate diffuse slab; no measured surgical light/camera calibration, refracted geometry, spatial multiple scattering, or tissue-specific substrate.",
  maxThicknessM: BLOOD_LUT_MAX_M,
  lookupEntries: BLOOD_LUT.length,
});

function nonnegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
}

/** Corrected Duysens factor. The imported whole-blood absorption is already
 * flattened, so this function is for reference/other raw Hb data, not the LUT.
 */
export function absorptionFlatteningFactor(absorptionRbcMInv: number, rbcWidthM: number): number {
  nonnegativeFinite(absorptionRbcMInv, "Intracellular absorption");
  nonnegativeFinite(rbcWidthM, "RBC width");
  const opticalDepth = absorptionRbcMInv * rbcWidthM;
  return opticalDepth === 0 ? 1 : -Math.expm1(-opticalDepth) / opticalDepth;
}

/** Unscattered beam only. Reduced scattering must NEVER be passed as μs here. */
export function ballisticTransmittance(absorptionMInv: number, scatteringMInv: number, pathLengthM: number): number {
  nonnegativeFinite(absorptionMInv, "Absorption");
  nonnegativeFinite(scatteringMInv, "Scattering");
  nonnegativeFinite(pathLengthM, "Path length");
  if (pathLengthM === 0) return 1;
  return Math.exp(-(absorptionMInv + scatteringMInv) * pathLengthM);
}

/** Exact boundary-value solution of the stated two-ordinate approximation.
 *
 * μ=1/√3, σs'=σs(1-g), a=σa+σs'/2, b=σs'/2.
 * dI+/dz=(-a I+ + b I-)/μ; dI-/dz=(-b I+ + a I-)/μ.
 * I+(0)=1, I-(d)=0; R=I-(0), T=I+(d). No Fresnel/internal
 * boundary reflections. This is not the full angular radiative transfer equation.
 */
export function slabTwoStream(absorptionMInv: number, reducedScatteringMInv: number, thicknessM: number): ScalarSlabTransport {
  nonnegativeFinite(absorptionMInv, "Absorption");
  nonnegativeFinite(reducedScatteringMInv, "Reduced scattering");
  nonnegativeFinite(thicknessM, "Thickness");
  const scale = Math.max(absorptionMInv, reducedScatteringMInv);
  if (thicknessM === 0 || scale === 0) return { reflectance: 0, transmittance: 1 };
  // Scale coefficients before squaring to avoid overflow. The zero absorption
  // branch is the conservative-scattering limit, not an epsilon material change.
  const absorption = absorptionMInv / scale, scattering = reducedScatteringMInv / scale;
  const gamma = Math.sqrt(absorption) * Math.sqrt(absorption + scattering);
  if (gamma === 0) {
    const transmittance = 1 / (1 + Math.sqrt(3) * .5 * (reducedScatteringMInv * thicknessM));
    return { reflectance: 1 - transmittance, transmittance };
  }
  const a = absorption + scattering / 2, b = scattering / 2;
  const rInfinity = b / (a + gamma), c = 2 * gamma / (a + gamma);
  let opticalDepth = Math.sqrt(3) * (scale * thicknessM) * gamma;
  if (!Number.isFinite(opticalDepth)) opticalDepth = Math.exp(Math.log(Math.sqrt(3)) + Math.log(scale) + Math.log(thicknessM) + Math.log(gamma));
  const attenuation = Math.exp(-opticalDepth), loss = -Math.expm1(-2 * opticalDepth);
  const denominator = c + (1 - c) * loss;
  return { reflectance: rInfinity * loss / denominator, transmittance: c * attenuation / denominator };
}

/** Spectral→RGB can leave the display gamut. Explicit projection keeps positive
 * channels and normalizes each R/T pair only if its sum exceeds one. It is a
 * display approximation; spectral passivity is independently checked upstream.
 */
export function projectPassiveRgb(reflectance: BloodOpticsRgb, transmittance: BloodOpticsRgb): BloodSlabTransport {
  const r: [number, number, number] = [0, 0, 0], t: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; ++channel) {
    if (!Number.isFinite(reflectance[channel]) || !Number.isFinite(transmittance[channel])) throw new RangeError("RGB transport must be finite");
    const positiveR = Math.max(0, reflectance[channel]!), positiveT = Math.max(0, transmittance[channel]!);
    // Positive data are bounded near [0,1]. Normalizing first also handles
    // unusually large finite values without overflowing their sum.
    const largest = Math.max(1, positiveR, positiveT);
    const sum = positiveR / largest + positiveT / largest;
    if (largest > 1 || sum > 1) {
      r[channel] = (positiveR / largest) / sum;
      t[channel] = (positiveT / largest) / sum;
    } else {
      r[channel] = positiveR;
      t[channel] = positiveT;
    }
  }
  return { reflectance: r, transmittance: t };
}

/** Effective diffuse reflectance of a symmetric slab on a reflective substrate.
 *
 * Both faces have the same R/T. For illumination from above, downward light
 * traverses the slab, reflects from the substrate, and traverses it again.
 * Repeated exchanges sum to R + T² s/(1-R s). This is RGB channel-wise adding,
 * not spectral layering or a directional BRDF; no Fresnel interface is included.
 * Do not apply an additional transmission term to this effective albedo.
 */
export function composeDiffuseSubstrate(transport: BloodSlabTransport, substrate: BloodOpticsRgb): BloodOpticsRgb {
  const result: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; ++channel) {
    const r = transport.reflectance[channel]!, inputT = transport.transmittance[channel]!, s = substrate[channel]!;
    if (![r, inputT, s].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
      throw new RangeError("Slab and substrate RGB must be finite and within [0,1]");
    if (r + inputT > 1 + 2 * Number.EPSILON)
      throw new RangeError("Slab RGB reflectance plus transmittance must not exceed one");
    // Remove only addition-scale roundoff, rather than projecting invalid data.
    const t = Math.min(inputT, 1 - r);
    // Opaque slabs also cover the R=s=1 zero-denominator limit: no light can
    // enter the cavity. Grouping avoids cancellation near R=s=1 and avoids
    // squaring tiny T before dividing by a similarly tiny denominator.
    const denominator = (1 - r) + r * (1 - s);
    result[channel] = t === 0 ? r : Math.min(1, r + t * (t * s / denominator));
  }
  return result;
}

/** Fixed-condition LUT; input is slab thickness in metres. Above 50 mm the
 * lookup saturates at its last entry. Scene chord/splat thickness is only an
 * approximation to normal slab thickness; the caller must disclose that.
 */
export function bloodSlabTransport(thicknessM: number): BloodSlabTransport {
  nonnegativeFinite(thicknessM, "Thickness");
  const index = Math.log1p(Math.min(thicknessM, BLOOD_LUT_MAX_M) / BLOOD_LUT_SCALE_M) / BLOOD_LUT_LOG_MAX * (BLOOD_LUT.length - 1);
  const lower = Math.min(Math.floor(index), BLOOD_LUT.length - 1), upper = Math.min(lower + 1, BLOOD_LUT.length - 1);
  const fraction = index - lower, first = BLOOD_LUT[lower]!, second = BLOOD_LUT[upper]!;
  const value = (channel: number) => first[channel]! + fraction * (second[channel]! - first[channel]!);
  return projectPassiveRgb([value(0), value(1), value(2)], [value(3), value(4), value(5)]);
}

const wgslFloat = (value: number) => Number.isInteger(value) ? `${value}.0` : String(value);
const array = (offset: number) => BLOOD_LUT.map(entry => `vec3<f32>(${entry.slice(offset, offset + 3).map(wgslFloat).join(",")})`).join(",\n");

/** Constant lookup only: no added GPU resources, readbacks, or solver mutations. */
export const BLOOD_OPTICS_WGSL = `
// Derived data CC BY-SA 4.0; attribution: blood-optics-attribution.json.
// Fixed oxy/Hct45/D65 two-stream approximation, not calibrated surgical optics.
struct BloodSlabTransport { reflectance:vec3<f32>, transmittance:vec3<f32> }
const BLOOD_OPTICS_R=array<vec3<f32>,${BLOOD_LUT.length}>(
${array(0)}
);
const BLOOD_OPTICS_T=array<vec3<f32>,${BLOOD_LUT.length}>(
${array(3)}
);
fn bloodSlabTransport(thicknessM:f32)->BloodSlabTransport {
  if(!(thicknessM>0.)){return BloodSlabTransport(vec3<f32>(0.),vec3<f32>(1.));}
  let thickness=min(thicknessM,${wgslFloat(BLOOD_LUT_MAX_M)});
  let x=clamp(log(1.+thickness/${wgslFloat(BLOOD_LUT_SCALE_M)})/${wgslFloat(BLOOD_LUT_LOG_MAX)}*${BLOOD_LUT.length - 1}.0,0.,${BLOOD_LUT.length - 1}.0);
  let lo=min(u32(floor(x)),${BLOOD_LUT.length - 1}u);let hi=min(lo+1u,${BLOOD_LUT.length - 1}u);
  let r=max(mix(BLOOD_OPTICS_R[lo],BLOOD_OPTICS_R[hi],fract(x)),vec3<f32>(0.));
  let t=max(mix(BLOOD_OPTICS_T[lo],BLOOD_OPTICS_T[hi],fract(x)),vec3<f32>(0.));
  let scale=max(vec3<f32>(1.),r+t);
  return BloodSlabTransport(r/scale,t/scale);
}
// Symmetric diffuse slab on a top-lit reflecting substrate. Inputs are linear
// RGB passive coefficients, not a radiance background. Defensive f32 bounds
// do not replace CPU input validation or spectral layering.
fn composeDiffuseSubstrate(transport:BloodSlabTransport,substrate:vec3<f32>)->vec3<f32>{
  let r=clamp(transport.reflectance,vec3<f32>(0.),vec3<f32>(1.));
  let t=min(clamp(transport.transmittance,vec3<f32>(0.),vec3<f32>(1.)),vec3<f32>(1.)-r);
  let s=clamp(substrate,vec3<f32>(0.),vec3<f32>(1.));
  let denominator=(vec3<f32>(1.)-r)+r*(vec3<f32>(1.)-s);
  // Select a safe divisor before evaluating the opaque perfect-reflector
  // channel. WGSL select evaluates both expressions, so selecting after a
  // division would still evaluate 0/0.
  let safeDenominator=select(vec3<f32>(1.),denominator,t>vec3<f32>(0.));
  return min(vec3<f32>(1.),r+t*(t*s/safeDenominator));
}
`;
