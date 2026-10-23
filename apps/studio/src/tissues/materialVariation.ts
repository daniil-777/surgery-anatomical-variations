/** Authored, bounded variation of a material in fixed surface coordinates.
 * This is independent of the optional learned model, not an inferred tissue model. */
export const TISSUE_VARIATION_VERSION = "viscera-tissue-variation-v1" as const;
export interface TissueMaterialVariation {
  version: typeof TISSUE_VARIATION_VERSION;
  enabled: boolean;
  seed: string;
  strength: number;
  warmth: number;
  depth: number;
  roughness: number;
}
export const defaultMaterialVariation: Readonly<TissueMaterialVariation> = Object.freeze({
  version: TISSUE_VARIATION_VERSION, enabled: false, seed: "42", strength: .45, warmth: 0, depth: 0, roughness: .35,
});
export function validateMaterialVariation(value: TissueMaterialVariation): TissueMaterialVariation {
  if (value.version !== TISSUE_VARIATION_VERSION || typeof value.enabled !== "boolean"
    || typeof value.seed !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value.seed) || BigInt(value.seed) > 18446744073709551615n
    || ![value.strength, value.roughness].every(x => Number.isFinite(x) && x >= 0 && x <= 1)
    || ![value.warmth, value.depth].every(x => Number.isFinite(x) && x >= -1 && x <= 1)) throw new RangeError("Invalid tissue material variation recipe");
  return value;
}
export function newMaterialSeed(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(words[0]!) << 32n) | BigInt(words[1]!)).toString();
}
/** Mix all 64 bits before reducing to exactly representable shader phase offsets. */
export function materialSeedOffsets(seed: string): [number, number, number] {
  validateMaterialVariation({ ...defaultMaterialVariation, seed });
  let state = BigInt(seed);
  return [0, 1, 2].map(() => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    z ^= z >> 31n;
    return Number(z & 65535n) / 256;
  }) as [number, number, number];
}

const ROUGHNESS_DELTA = .16;
const AUTHORED_ROUGHNESS_MIN = .075;
const AUTHORED_ROUGHNESS_MAX = .85;
/** Numeric contract for the shader's dry-substrate variation, not fitted optics.
 * Preserve an imported baseline outside the authored range; variation may move
 * it inward, but never make it more extreme. Zero amount is exactly neutral. */
export function applyMaterialRoughnessVariation(dry: number, field: number, amount: number): number {
  if (!Number.isFinite(dry) || dry < 0 || dry > 1
    || !Number.isFinite(field) || field < -1 || field > 1
    || !Number.isFinite(amount) || amount < 0 || amount > 1) throw new RangeError("Invalid dry roughness variation");
  if (amount === 0) return dry;
  return Math.min(Math.max(dry + ROUGHNESS_DELTA * amount * field, Math.min(dry, AUTHORED_ROUGHNESS_MIN)), Math.max(dry, AUTHORED_ROUGHNESS_MAX));
}

// Integer-frequency periodic fields close exactly at coupon/lumen UV seams.
// Atlas surfaces evaluate the same field in object millimetres, independent of
// view, light and time. Pigment variation never invents displacement or vessels.
export const tissueVariationShader = `
uniform float tissueVariationEnabled;
uniform vec3 tissueVariationSeed;
uniform vec4 tissueVariationAmounts;
float tissueVariationHash(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float tissueVariationNoise(vec3 position, float frequency, vec3 offset) {
  vec3 p = position * frequency;
  vec3 cell = floor(p), f = fract(p);
  vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = tissueVariationHash(mod(cell, frequency) + offset);
  float b = tissueVariationHash(mod(cell+vec3(1,0,0), frequency) + offset);
  float c = tissueVariationHash(mod(cell+vec3(0,1,0), frequency) + offset);
  float d = tissueVariationHash(mod(cell+vec3(1,1,0), frequency) + offset);
  float e = tissueVariationHash(mod(cell+vec3(0,0,1), frequency) + offset);
  float g = tissueVariationHash(mod(cell+vec3(1,0,1), frequency) + offset);
  float h = tissueVariationHash(mod(cell+vec3(0,1,1), frequency) + offset);
  float j = tissueVariationHash(mod(cell+vec3(1,1,1), frequency) + offset);
  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(mix(e,g,u.x),mix(h,j,u.x),u.y),u.z);
}
float tissueVariationField(vec3 p, vec3 offset) {
  return 2.0*(.55*tissueVariationNoise(p,3.0,offset)+.30*tissueVariationNoise(p,7.0,offset+17.0)+.15*tissueVariationNoise(p,17.0,offset+39.0))-1.0;
}
vec3 tissueVaryPigment(vec3 color, vec3 p) {
  if (tissueVariationEnabled == 0.0) return color;
  float field = tissueVariationField(p, tissueVariationSeed);
  float warmth = tissueVariationAmounts.x;
  float depth = tissueVariationAmounts.y;
  float amount = tissueVariationAmounts.z;
  // Authored log-space colour gains in linear RGB, bounded and non-emissive.
  vec3 gain = exp(vec3(.12,-.02,-.14)*warmth - vec3(.18,.27,.22)*depth
    + amount*field*vec3(.24,-.14,-.18));
  return clamp(color*gain, vec3(0.0), vec3(1.0));
}
float tissueVaryRoughness(float dry, vec3 p) {
  if (tissueVariationEnabled == 0.0) return dry;
  if (tissueVariationAmounts.w == 0.0) return dry;
  float field = tissueVariationField(p, tissueVariationSeed+vec3(83.0,41.0,7.0));
  return clamp(dry + ${ROUGHNESS_DELTA}*tissueVariationAmounts.w*field, min(dry, ${AUTHORED_ROUGHNESS_MIN}), max(dry, ${AUTHORED_ROUGHNESS_MAX}));
}
`;
