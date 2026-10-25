import * as THREE from "three";
import { publicUrl } from "./api";

export const OPERATIVE_APPEARANCE_VERSION = "rest-attached-operative-film/1";
export interface OperativeAppearance {
  texture: THREE.DataTexture;
  sha256: string;
  model: string;
  redThreshold: number;
}
/** A phase-randomized statistical field, never a pasted surgical photograph.
 * The source contract records the fit split and excludes held-out operations. */
export async function loadOperativeAppearance(signal?: AbortSignal): Promise<OperativeAppearance> {
  const prefix = publicUrl("operative-appearance/");
  const response = await fetch(`${prefix}manifest.json`, { signal: signal ?? null });
  if (!response.ok) throw new Error("Operative appearance manifest unavailable.");
  const manifest = await response.json();
  if (!Number.isFinite(manifest.texture?.redThreshold) || manifest.texture.redThreshold < 0 || manifest.texture.redThreshold > 1 || manifest.schema !== "viscera.operative-statistics/v1" || manifest.texture.file !== "morphology.png"
    || !/^[a-f0-9]{64}$/.test(manifest.texture.sha256)) throw new Error("Invalid operative appearance manifest.");
  const image = await fetch(`${prefix}morphology.png`, { signal: signal ?? null });
  if (!image.ok) throw new Error("Operative morphology unavailable.");
  const bytes = await image.arrayBuffer(), hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (hash !== manifest.texture.sha256) throw new Error("Operative morphology checksum mismatch.");
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || bitmap.width !== 512 || bitmap.height !== 512) { bitmap.close(); throw new Error("Invalid operative morphology dimensions."); }
  context.drawImage(bitmap, 0, 0); bitmap.close();
  const pixels = context.getImageData(0, 0, 512, 512); signal?.throwIfAborted();
  const texture = new THREE.DataTexture(pixels.data, 512, 512);
  texture.name = OPERATIVE_APPEARANCE_VERSION; texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.anisotropy = 8; texture.needsUpdate = true;
  return { texture, sha256: hash, model: manifest.model, redThreshold: manifest.texture.redThreshold };
}

export const operativeStrength = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Authored regional support in reconstructed rest-space mm. The film does not
 * join meshes across air or claim an incision, blood flow or conservation. */
export const OPERATIVE_REGION_GLSL = `
float operativeSupport(int organ, vec3 p) {
  vec3 bed = (p - vec3(-31., -9., 27.)) / vec3(54., 39., 42.);
  vec3 apron = (p - vec3(15., -70., 40.)) / vec3(78., 40., 46.);
  float region = max(1.-smoothstep(.18,1.,length(bed)), .38*(1.-smoothstep(.25,1.,length(apron))));
  float host = organ==8||organ==9 ? 1. : organ==1 ? .32 : organ==0 ? .22 : organ==5||organ==6||organ==7 ? .22 : organ==10||organ==11 ? 0. : .35;
  return region*host;
}
`;

/** All inputs are material/rest coordinates. Diffuse blood transport is applied
 * once after substrate blending; film slope is separate from substrate detail. */
export const OPERATIVE_LAYER_GLSL = `
vec3 vmOpP = vVmRest/vec3(105.,160.,105.) + vec3(uVmOffset*.127, uVmOffset*.083, uVmOffset*.059);
vec4 vmOp = vmProjection(uVmOperative, vmOpP, vmW, vmDx/vec3(105.,160.,105.), vmDy/vec3(105.,160.,105.));
float vmRegion = vmS.exposure * uVmOperativeStrength;
float vmResidue = smoothstep(uVmOperativeThreshold-.045,uVmOperativeThreshold+.16,vmOp.r);
float vmDeposit = smoothstep(uVmOperativeThreshold+.23,uVmOperativeThreshold+.48,vmOp.r);
float vmThickness = vmRegion * (.0015 + .055*vmResidue + .12*vmDeposit);
float vmClearWet = vmRegion * (.32+.68*smoothstep(.3,.72,vmOp.g));
float vmFilmLevel = clamp(vmClearWet*.5 + vmThickness/(vmThickness+.016),0.,1.);
vec2 vmFilmSlope = vec2(dFdx(vmThickness),dFdy(vmThickness));
vmS.color = operativeBloodColor(vmS.color,vmThickness);
vmS.coat = mix(vmS.coat,.98,vmFilmLevel);
vmS.coatRoughness = mix(vmS.coatRoughness,.055,vmFilmLevel);
`;
