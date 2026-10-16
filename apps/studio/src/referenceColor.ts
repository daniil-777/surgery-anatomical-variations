import { validateReferenceColor, type ReferenceColor } from "./atlasMaterial";

type RGB = [number, number, number];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const linear = (x: number) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
const srgb = (x: number) => x <= .0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - .055;
// Oklab public-domain matrices by Björn Ottosson. Python parity is tested.
export function referenceOklab(rgb: RGB): RGB {
  const [r, g, b] = rgb.map(linear) as RGB;
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .7936177850*m - .0040720468*s,
    1.9779984951*l - 2.4285922050*m + .4505937099*s,
    .0259040371*l + .7827717662*m - .8086757660*s];
}
function fromLab([L, a, b]: RGB): RGB {
  const l = (L + .3963377774*a + .2158037573*b) ** 3;
  const m = (L - .1055613458*a - .0638541728*b) ** 3;
  const s = (L - .0894841775*a - 1.2914855480*b) ** 3;
  return [4.0767416621*l - 3.3077115913*m + .2309699292*s,
    -1.2684380046*l + 2.6097574011*m - .3413193965*s,
    -.0041960863*l - .7034186147*m + 1.7076147010*s];
}
export function referenceBaseColor(base: RGB, reference: ReferenceColor): RGB {
  validateReferenceColor(reference, reference.organ);
  if (!base.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) throw new Error("Invalid base colour");
  if (reference.strength === 0) return [...base];
  const before = referenceOklab(base), target = referenceOklab(reference.observed_srgb);
  if (reference.mode === "chroma") target[0] = before[0];
  const mixed = before.map((x, i) => x + reference.strength * (target[i]! - x)) as RGB;
  let low = 0, high = 1;
  const inGamut = (rgb: RGB) => rgb.every(x => x >= -1e-9 && x <= 1 + 1e-9);
  if (!inGamut(fromLab(mixed))) {
    for (let i = 0; i < 24; i++) {
      const scale = (low + high) / 2;
      if (inGamut(fromLab([mixed[0], mixed[1] * scale, mixed[2] * scale]))) low = scale; else high = scale;
    }
    mixed[1] *= low; mixed[2] *= low;
  }
  return fromLab(mixed).map(x => srgb(clamp(x))) as RGB;
}

/** Explicit mappings: reference identity does not infer the selected anatomy. */
export const REFERENCE_ORGAN_IDS: Record<string, string> = {
  liver: "liver", gallbladder: "gallbladder", stomach: "stomach", pancreas: "pancreas",
  spleen: "spleen", "small-intestine": "small-intestine", colon: "large-intestine",
  "left-kidney": "kidney", "right-kidney": "kidney", heart: "heart",
  "left-lung": "lung", "right-lung": "lung", "urinary-bladder": "urinary-bladder",
  esophagus: "esophagus", duodenum: "duodenum", diaphragm: "diaphragm", mesentery: "mesentery",
  "left-ureter": "ureter", "right-ureter": "ureter",
  "cystic-duct": "bile-duct", "hepatic-duct": "bile-duct", "pancreatic-duct": "pancreatic-duct",
  trachea: "trachea", bronchi: "bronchi", aorta: "artery", "hepatic-artery": "artery",
  "superior-mesenteric-artery": "artery", "inferior-mesenteric-artery": "artery",
  "left-renal-artery": "artery", "right-renal-artery": "artery", "splenic-artery": "artery", "celiac-trunk": "artery",
  "vena-cava": "vein", "portal-vein": "vein", "left-renal-vein": "vein", "right-renal-vein": "vein",
};
