import type { GenerateTileRequest, GeneratorHealth } from "./generatorClient";
import { publicUrl } from "../api";
import { canonicalAppearanceSeed, sha256 } from "./neuralAppearance";
import { bakeAppearanceInWorker } from "./neuralAppearanceClient";
import { newMaterialSeed } from "./materialVariation";
import { encodePng } from "./pngEncoder";
export { encodePng } from "./pngEncoder";
export const BROWSER_FAMILIES = ["liver", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas"] as const;
export const BROWSER_GENERATOR_HEALTH: GeneratorHealth = {
  schema: "viscera.tissue-generator/v1", ready: true, busy: false, families: [...BROWSER_FAMILIES], modes: ["clean"],
  run_id: "browser-exemplar-v1", rights: { training_profile: "noncommercial-research", rights: ["noncommercial-research"] },
};
const ROUGHNESS: Record<string, number> = { liver: .36, spleen: .4, stomach: .34, small_bowel: .32, large_bowel: .36, pancreas: .46 };
const byte = (x: number) => Math.round(Math.max(0, Math.min(255, x)));
const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
};
const checkpoint = async (signal?: AbortSignal) => {
  await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted();
};
/** Full-detail RGB is synthesized in a cancellable worker. Relief/roughness are
 * bounded authored estimates from that appearance, never recovered tissue optics. */
export async function generateBrowserTileBundle(request: GenerateTileRequest, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const family = request.family;
  if (!(BROWSER_FAMILIES as readonly string[]).includes(family)) throw new Error("No fitted browser model for this tissue; select a supported organ.");
  if (request.mode && request.mode !== "clean") throw new Error("Browser generation supports clean appearance only; other modes require the local generator.");
  const seed = canonicalAppearanceSeed(request.seed ?? newMaterialSeed());
  const response = await fetch(publicUrl(`tissue-models/exemplar-${family}.tissue-model.json`), { ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Browser material model unavailable: HTTP ${response.status}`);
  const source = await response.text();
  const baked = await bakeAppearanceInWorker(source, 0, seed, 512, signal ?? new AbortController().signal, () => {});
  const size = 512, count = size*size, rgb = new Uint8Array(count*3), height = new Float32Array(count);
  const normal = new Uint8Array(count*3), roughness = new Uint8Array(count), zeroRgb = new Uint8Array(count*3), clear = new Uint8Array(count*4), wet = new Uint8Array(count*4);
  for (let i = 0; i < count; i++) {
    rgb.set(baked.rgba.subarray(i*4,i*4+3),i*3);
    height[i] = (rgb[i*3]!*.2126 + rgb[i*3+1]!*.7152 + rgb[i*3+2]!*.0722)/255;
  }
  const at = (x: number, y: number) => height[(y & 511)*size+(x & 511)]!;
  // High-pass height only: broad photographic shadows must not become geometry.
  const relief = new Float32Array(count);
  for (let y = 0; y < size; y++) {
    if ((y & 63) === 0) await checkpoint(signal);
    for (let x = 0; x < size; x++) {
      const i = y*size+x;
      relief[i] = Math.max(-.03, Math.min(.03, (at(x,y) - (at(x-3,y)+at(x+3,y)+at(x,y-3)+at(x,y+3))*.25)*.18));
      roughness[i] = byte((ROUGHNESS[family]! + relief[i]!*1.4)*255);
      wet[i*4]=wet[i*4+1]=wet[i*4+2]=255; wet[i*4+3]=byte((.62 + relief[i]!)*255);
    }
  }
  const h = (x: number, y: number) => relief[(y & 511)*size+(x & 511)]!;
  for (let y = 0; y < size; y++) {
    if ((y & 63) === 0) await checkpoint(signal);
    for (let x = 0; x < size; x++) {
      const nx = -(h(x+1,y)-h(x-1,y))/.2, ny = (h(x,y+1)-h(x,y-1))/.2, scale = 1/Math.hypot(nx,ny,1), i=(y*size+x)*3;
      normal[i]=byte((nx*scale*.5+.5)*255); normal[i+1]=byte((ny*scale*.5+.5)*255); normal[i+2]=byte((scale*.5+.5)*255);
    }
  }
  const maps: [string, 1|3|4, Uint8Array][] = [
    ["substrate",3,rgb], ["normal",3,normal], ["roughness",1,roughness], ["substrate_normal",3,normal],
    ["substrate_roughness",1,roughness], ["layer_relief",3,zeroRgb], ["vessels",4,clear], ["fascia",4,clear], ["adipose",4,clear], ["wet_film",4,wet],
  ];
  const files = [], meta: Record<string, { file: string; sha256: string; bytes: number; color_space: string }> = {};
  for (const [name, channels, data] of maps) {
    await checkpoint(signal);
    const bytes = encodePng(size,size,channels,data), file = `${name}.png`;
    meta[name] = { file, sha256: await sha256(bytes), bytes: bytes.length, color_space: ["substrate","vessels","fascia","adipose"].includes(name) ? "srgb" : "linear" };
    files.push({ file, pngBase64: base64(bytes) });
  }
  signal?.throwIfAborted();
  return JSON.stringify({ schema: "viscera.tissue-pbr-bundle/v1", manifest: {
    schema: "viscera.tissue-materials/v1", generator: "viscera.tissue-exemplar/v1", label: `${family.replaceAll("_"," ")} · browser variation`, resolution: [size,size],
    physical_size_mm: [51.2,51.2], pixel_size_mm: .1,
    recipe: { organ: family, seed, tile_size_mm: 51.2, wetness: .6, vessel_opacity: 0, fascia_opacity: 0, adipose_opacity: 0 },
    channels: { substrate: meta.substrate, normal: meta.normal, roughness: meta.roughness, substrate_normal: meta.substrate_normal, substrate_roughness: meta.substrate_roughness,
      layer_relief: { ...meta.layer_relief, packing: ["vessels","adipose","fascia"], decode_scale_mm: [.35,.9,.22], decode_offset_mm: [0,0,0] } },
    layers: ["vessels","fascia","adipose","wet_film"].map(id => ({ id, ...meta[id], opacity: id === "wet_film" ? .6 : 0, role: id === "wet_film" ? "authored wet film" : "not separately inferred from appearance" })),
    provenance: { executed: true, native_resolution: [512,512], model_id: baked.modelId, source_type: "histogram-preserving-generated-exemplar-synthesis", mode: "clean", training_profile: "noncommercial-research",
      source_model_provenance: JSON.parse(source).provenance, surface_estimate: "bounded high-pass RGB relief and authored roughness; not measured optics", clinically_validated: false, patient_specific: false },
  }, files });
}
