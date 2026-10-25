import {
  ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, NoColorSpace, RGBAFormat, type Texture,
} from "three";
import { composeDiffuseSubstrate, type BloodOpticsRgb } from "./blood/optics";
import {
  BLOOD_APPEARANCE_PROVENANCE, bloodAppearanceTransport,
} from "./blood/experiments/bloodAppearanceOptics";
import {
  APPEARANCE_LOG_MAX, APPEARANCE_MAX_M, APPEARANCE_SCALE_M, APPEARANCE_THICKNESS_COUNT,
} from "./blood/experiments/bloodAppearanceLut.generated";

export const OPERATIVE_BLOOD_OPTICS_VERSION = "operative-spectral-film/1";
/** An authored scene assumption, not a measurement or a vascular diagnosis. */
export const OPERATIVE_BLOOD_OXYGENATION = .75;
export const OPERATIVE_BLOOD_TRANSPORT_WIDTH = APPEARANCE_THICKNESS_COUNT;
export const OPERATIVE_BLOOD_PROVENANCE = Object.freeze({
  version: OPERATIVE_BLOOD_OPTICS_VERSION,
  sourceModel: BLOOD_APPEARANCE_PROVENANCE.id,
  sourceUrl: BLOOD_APPEARANCE_PROVENANCE.sourceUrl,
  correctionUrl: BLOOD_APPEARANCE_PROVENANCE.correctionUrl,
  dataLicense: BLOOD_APPEARANCE_PROVENANCE.dataLicense,
  attributionPath: "blood-optics-attribution.json",
  attributionSection: "operativeSceneAppearance",
  defaultOxygenationFraction: OPERATIVE_BLOOD_OXYGENATION,
  oxygenationSource: "Authored assumption; not identified from surgical images",
  method: "Existing spectral two-stream R/T lookup over a top-lit diffuse substrate, composed in linear RGB",
  thicknessUnit: "millimetres",
  maximumLookupThicknessMm: APPEARANCE_MAX_M * 1000,
  limitations: "Appearance only: no fluid mass, transport, coagulation, measured film thickness, camera calibration or clinical validation. "
    + BLOOD_APPEARANCE_PROVENANCE.limitations,
});

/** Effective diffuse reflectance. Fresnel reflection is supplied separately by
 * the host material. Inputs and output are linear RGB; thickness is in mm.
 * Do not alpha-blend another transmission term over this complete stack. */
export function operativeBloodComposite(thicknessMm: number, substrate: BloodOpticsRgb,
  oxygenationFraction = OPERATIVE_BLOOD_OXYGENATION): BloodOpticsRgb {
  if (!Number.isFinite(thicknessMm) || thicknessMm < 0)
    throw new RangeError("Operative blood thickness must be finite and nonnegative in millimetres");
  return composeDiffuseSubstrate(bloodAppearanceTransport(thicknessMm * .001, oxygenationFraction), substrate);
}

/** A single oxygenation slice of existing attributed data, without color fitting.
 * Row 0 holds R, row 1 holds T. Explicit shader interpolation uses nearest
 * sampling, so float-linear filtering is not a device requirement. */
export function operativeBloodTransportTextureData(oxygenationFraction = OPERATIVE_BLOOD_OXYGENATION): Float32Array {
  // Validate even if the texture size or filling strategy changes later.
  bloodAppearanceTransport(0, oxygenationFraction);
  const data = new Float32Array(APPEARANCE_THICKNESS_COUNT * 2 * 4);
  for (let i = 0; i < APPEARANCE_THICKNESS_COUNT; i++) {
    const thicknessM = APPEARANCE_SCALE_M * Math.expm1(APPEARANCE_LOG_MAX * i / (APPEARANCE_THICKNESS_COUNT - 1));
    const { reflectance, transmittance } = bloodAppearanceTransport(thicknessM, oxygenationFraction);
    const r = i * 4, t = (APPEARANCE_THICKNESS_COUNT + i) * 4;
    for (let c = 0; c < 3; c++) {
      data[r + c] = reflectance[c]!;
      data[t + c] = transmittance[c]!;
    }
    data[r + 3] = data[t + 3] = 1;
  }
  return data;
}

/** Explicitly owned variant. The caller must dispose it; the normal scene path
 * below shares a texture for a lifetime owner without per-frame uploads. */
export function createOperativeBloodTransportTexture(oxygenationFraction = OPERATIVE_BLOOD_OXYGENATION): DataTexture {
  const texture = new DataTexture(operativeBloodTransportTextureData(oxygenationFraction),
    APPEARANCE_THICKNESS_COUNT, 2, RGBAFormat, FloatType);
  texture.name = OPERATIVE_BLOOD_OPTICS_VERSION;
  texture.colorSpace = NoColorSpace;
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.userData.provenance = { ...OPERATIVE_BLOOD_PROVENANCE, oxygenationFraction };
  return texture;
}

const textures = new WeakMap<Texture, DataTexture>();
/** Share one spectral slice across all organ materials owned by a scene.
 * Disposing the owner releases this texture and its disposal listener. */
export function operativeBloodTexture(owner: Texture): DataTexture {
  const existing = textures.get(owner);
  if (existing) return existing;
  const texture = createOperativeBloodTransportTexture();
  textures.set(owner, texture);
  const dispose = () => {
    texture.dispose();
    textures.delete(owner);
    owner.removeEventListener("dispose", dispose);
  };
  owner.addEventListener("dispose", dispose);
  return texture;
}

/** Attach uOperativeBlood to the texture above, then call
 * operativeBloodColor(linearSubstrate, thicknessMm) AFTER tissue-interface
 * blending and BEFORE lighting/tone mapping. The returned color is opaque
 * diffuse reflectance of the whole stack, not blood opacity or emission. */
export const OPERATIVE_BLOOD_GLSL = `
uniform sampler2D uOperativeBlood;
vec3 operativeBloodColor(vec3 substrate, float thicknessMm) {
  if (!(thicknessMm > 0.0)) return substrate;
  float thicknessM = min(thicknessMm, ${(APPEARANCE_MAX_M * 1000).toFixed(1)}) * 0.001;
  float coordinate = min(${(APPEARANCE_THICKNESS_COUNT - 1).toFixed(1)},
    log(1.0 + thicknessM / ${APPEARANCE_SCALE_M}) / ${APPEARANCE_LOG_MAX}
    * ${(APPEARANCE_THICKNESS_COUNT - 1).toFixed(1)});
  float lower = floor(coordinate), upper = min(lower + 1.0, ${(APPEARANCE_THICKNESS_COUNT - 1).toFixed(1)});
  float u0 = (lower + 0.5) / ${APPEARANCE_THICKNESS_COUNT.toFixed(1)};
  float u1 = (upper + 0.5) / ${APPEARANCE_THICKNESS_COUNT.toFixed(1)};
  float fraction = coordinate - lower;
  vec3 r = mix(texture2D(uOperativeBlood, vec2(u0, 0.25)).rgb,
    texture2D(uOperativeBlood, vec2(u1, 0.25)).rgb, fraction);
  vec3 t = mix(texture2D(uOperativeBlood, vec2(u0, 0.75)).rgb,
    texture2D(uOperativeBlood, vec2(u1, 0.75)).rgb, fraction);
  // Float32 storage can introduce tiny passivity error; normalize both together.
  vec3 pairScale = max(vec3(1.0), r + t);
  r /= pairScale; t /= pairScale;
  vec3 s = clamp(substrate, vec3(0.0), vec3(1.0));
  vec3 denominator = max((vec3(1.0) - r) + r * (vec3(1.0) - s), vec3(1e-8));
  return min(vec3(1.0), r + t * (t * s / denominator));
}
`;
