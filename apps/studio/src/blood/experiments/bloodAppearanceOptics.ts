import { projectPassiveRgb, type BloodSlabTransport } from "../optics";
import {
  APPEARANCE_LOG_MAX, APPEARANCE_LUT_BASE64, APPEARANCE_MAX_M,
  APPEARANCE_SATURATIONS, APPEARANCE_SCALE_M, APPEARANCE_THICKNESS_COUNT,
} from "./bloodAppearanceLut.generated";

/** Illustrative preset assumptions, not patient-specific oxygen measurements. */
export const BLOOD_OXYGENATION_DEFAULTS = Object.freeze({ artery: .98, vein: .75 });

export const BLOOD_APPEARANCE_PROVENANCE = Object.freeze({
  id: "bosschaart-oxygenation45-d65-two-stream-experimental-v1",
  label: "Spectral oxygenation model · Hct 45% · D65",
  model: "Wavelength-domain interpolation of absorption and reduced scattering before two-stream transport",
  source: "Bosschaart et al. 2014, corrected 2022; compiled absorption and theoretical scattering",
  sourceUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3953607/",
  correctionUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9172854/",
  conditions: "Hematocrit 45%; 0% and >98% source endpoints; fraction 1 represents the >98% endpoint; D65/CIE1931",
  attributionPath: "blood-optics-attribution.json",
  attributionSection: "experimentalAppearance",
  dataLicense: "CC BY-SA 4.0 (derived LUT); original blood table CC BY 4.0",
  oxygenationRange: Object.freeze([0, 1] as const),
  maxThicknessM: APPEARANCE_MAX_M,
  limitations: "Intermediate oxygenation is an endpoint-coefficient approximation, including already-flattened absorption. No measured light/camera calibration, intracellular oxygen mixing, directional multiple scattering, or clinical validation.",
});

// Decode once, explicitly little-endian so the artifact is platform independent.
// The runtime needs no raw spectra, network requests, or per-frame spectral sums.
const lut = (() => {
  const decoded = atob(APPEARANCE_LUT_BASE64);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; ++i) bytes[i] = decoded.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const values = new Float32Array(decoded.length / 4);
  for (let i = 0; i < values.length; ++i) values[i] = view.getFloat32(i * 4, true);
  if (values.length !== APPEARANCE_SATURATIONS.length * APPEARANCE_THICKNESS_COUNT * 6)
    throw new Error("Invalid spectral blood appearance lookup length");
  return values;
})();

/** Linear-sRGB flux response of a homogeneous slab in metres. No Fresnel.
 *
 * Coefficients are interpolated spectrally during offline generation; this
 * bilinear LUT then approximates those computed RGB responses. It is NOT an
 * RGB tint between two fixed blood colours. Above 50mm the opaque-limit lookup
 * is held constant. Values outside the finite input domain are rejected.
 *
 * R may be used as an approximate diffuse baseColor under normalized lighting;
 * a top-lit substrate requires composeDiffuseSubstrate, not R + T*substrate.
 */
export function bloodAppearanceTransport(thicknessM: number, oxygenationFraction: number): BloodSlabTransport {
  if (!Number.isFinite(thicknessM) || thicknessM < 0)
    throw new RangeError("Blood appearance thickness must be finite and nonnegative");
  if (!Number.isFinite(oxygenationFraction) || oxygenationFraction < 0 || oxygenationFraction > 1)
    throw new RangeError("Blood appearance oxygenation fraction must be finite and within [0,1]");
  if (thicknessM === 0) return { reflectance: [0, 0, 0], transmittance: [1, 1, 1] };
  let lower = 0, upper = APPEARANCE_SATURATIONS.length - 1;
  while (upper - lower > 1) {
    const middle = (lower + upper) >>> 1;
    if (APPEARANCE_SATURATIONS[middle]! <= oxygenationFraction) lower = middle;
    else upper = middle;
  }
  const saturationFraction = (oxygenationFraction - APPEARANCE_SATURATIONS[lower]!)
    / (APPEARANCE_SATURATIONS[upper]! - APPEARANCE_SATURATIONS[lower]!);
  const x = Math.min(APPEARANCE_THICKNESS_COUNT - 1,
    Math.log1p(Math.min(thicknessM, APPEARANCE_MAX_M) / APPEARANCE_SCALE_M)
      / APPEARANCE_LOG_MAX * (APPEARANCE_THICKNESS_COUNT - 1));
  const lo = Math.floor(x), hi = Math.min(lo + 1, APPEARANCE_THICKNESS_COUNT - 1), fraction = x - lo;
  const base0 = lower * APPEARANCE_THICKNESS_COUNT * 6, base1 = upper * APPEARANCE_THICKNESS_COUNT * 6;
  const channel = (c: number) => {
    const a = lut[base0 + lo * 6 + c]!, b = lut[base0 + hi * 6 + c]!;
    const p = lut[base1 + lo * 6 + c]!, q = lut[base1 + hi * 6 + c]!;
    return (a + fraction * (b - a)) * (1 - saturationFraction)
      + (p + fraction * (q - p)) * saturationFraction;
  };
  // Convex interpolation preserves passivity analytically; this projection
  // removes storage/interpolation roundoff only (float32 nodes can sum >1).
  return projectPassiveRgb([channel(0), channel(1), channel(2)], [channel(3), channel(4), channel(5)]);
}
