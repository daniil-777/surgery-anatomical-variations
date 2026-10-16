// photoDetail.ts — real photograph detail over the procedural tissue, in the browser.
//
// pipelines/textures/photo_tiles.py cuts, from the licensed surgical photographs the studio ships (DSAD, CC BY 4.0), one
// small seamless tile per organ with its lighting flattened, and writes it Gaussianised with its inverse lookup
// (Heitz & Neyret 2018). Here the tile is laid over the organ in its rest frame by triplanar projection, each
// projection hex-tiled with random offsets and blended histogram-preservingly (Mikkelsen 2022): no visible repetition,
// nine texture reads and three lookups per fragment, no new geometry. The result divides by the tile's mean, so it
// modulates the tissue colour the shader already computed (base colour, preset, any transferred reference colour)
// without shifting it. It attaches outside the contract-locked material field, as the disease layer does, and leaves
// the output byte-identical at strength 0. It is a viewer layer of this copy: exports do not carry it.
import * as THREE from "three";
import { publicUrl } from "./api";
import type { ReferenceColor } from "./atlasMaterial";

export interface PhotoTileInfo { organ: string; files: { albedo: string; gauss: string; lut: string }; side_px: number; tile_mm: number; mean_linear: [number, number, number]; luminance_std_relative: number; source: { collection: string; id: string; region: string; credit?: string; license?: string; license_url?: string; source_url?: string; identity?: string }; reference_color?: ReferenceColor; color_quality?: { accepted_fraction: number; accepted_pixels: number } }
export interface PhotoManifest { version: string; organs: Record<string, PhotoTileInfo> }
export interface PhotoDetail { info: PhotoTileInfo; gauss: THREE.Texture; lut: THREE.Texture }

let manifest: Promise<PhotoManifest | null> | null = null;
const tiles = new Map<string, Promise<PhotoDetail | null>>();

export function photoManifest(): Promise<PhotoManifest | null> {
  manifest ??= fetch(publicUrl("textures/manifest.json")).then((r) => (r.ok ? r.json() : null), () => null).then((v) => (v && typeof v === "object" && "organs" in v ? v as PhotoManifest : null));
  return manifest;
}
const loadTexture = (url: string) => new Promise<THREE.Texture>((resolve, reject) => new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`${url} did not load`))));

/** The organ's photo tile, or null when the library has none; one download per organ. */
export function photoDetailFor(organ: string): Promise<PhotoDetail | null> {
  let p = tiles.get(organ);
  if (!p) {
    p = photoManifest().then(async (m) => {
      const info = m?.organs[organ];
      if (!info) return null;
      const [gauss, lut] = await Promise.all([loadTexture(publicUrl(`textures/${info.files.gauss}`)), loadTexture(publicUrl(`textures/${info.files.lut}`))]);
      gauss.colorSpace = THREE.NoColorSpace; gauss.wrapS = gauss.wrapT = THREE.RepeatWrapping; gauss.minFilter = THREE.LinearMipmapLinearFilter; gauss.magFilter = THREE.LinearFilter; gauss.generateMipmaps = true; gauss.anisotropy = 4;
      lut.colorSpace = THREE.NoColorSpace; lut.wrapS = lut.wrapT = THREE.ClampToEdgeWrapping; lut.minFilter = THREE.LinearFilter; lut.magFilter = THREE.LinearFilter; lut.generateMipmaps = false;
      gauss.needsUpdate = lut.needsUpdate = true;
      return { info, gauss, lut };
    });
    tiles.set(organ, p);
    p.catch(() => tiles.delete(organ));
  }
  return p;
}

const GLSL = /* glsl */`
uniform sampler2D uPhotoGauss;
uniform sampler2D uPhotoLut;
uniform float uPhotoStrength;
uniform float uPhotoReliefMm;
uniform float uPhotoTileMm;
uniform vec3 uPhotoMeanLinear;
// the triangle grid behind hex tiling: the three nearest hex centres of uv and their barycentric weights
void photoTriangleGrid(vec2 uv, out float w1, out float w2, out float w3, out ivec2 v1, out ivec2 v2, out ivec2 v3) {
  const mat2 gridToSkewed = mat2(1.0, 0.0, -0.57735027, 1.15470054);
  vec2 skewed = gridToSkewed * (uv * 3.4641016);
  ivec2 base = ivec2(floor(skewed));
  vec3 t = vec3(fract(skewed), 0.0);
  t.z = 1.0 - t.x - t.y;
  if (t.z > 0.0) { w1 = t.z; w2 = t.y; w3 = t.x; v1 = base; v2 = base + ivec2(0, 1); v3 = base + ivec2(1, 0); }
  else { w1 = -t.z; w2 = 1.0 - t.y; w3 = 1.0 - t.x; v1 = base + ivec2(1, 1); v2 = base + ivec2(1, 0); v3 = base + ivec2(0, 1); }
}
vec2 photoHash(ivec2 p) { return fract(sin(vec2(dot(vec2(p), vec2(127.1, 311.7)), dot(vec2(p), vec2(269.5, 183.3)))) * 43758.5453); }
// one projection: three randomly offset tiles, blended with their variance preserved, then mapped back through the
// inverse lookup (histogram-preserving blending); sRGB-encoded out
vec3 photoSample(vec2 uv, vec2 dx, vec2 dy) {
  float w1, w2, w3; ivec2 v1, v2, v3;
  photoTriangleGrid(uv, w1, w2, w3, v1, v2, v3);
  vec3 g = w1 * textureGrad(uPhotoGauss, uv + photoHash(v1), dx, dy).rgb
         + w2 * textureGrad(uPhotoGauss, uv + photoHash(v2), dx, dy).rgb
         + w3 * textureGrad(uPhotoGauss, uv + photoHash(v3), dx, dy).rgb;
  g = (g - 0.5) / sqrt(w1 * w1 + w2 * w2 + w3 * w3) + 0.5;
  return vec3(texture(uPhotoLut, vec2(g.r, 0.5)).r, texture(uPhotoLut, vec2(g.g, 0.5)).g, texture(uPhotoLut, vec2(g.b, 0.5)).b);
}
vec3 photoSrgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// triplanar in the organ's rest frame (the same frame the material field uses): mean-one modulation
vec3 photoDetail(vec3 restMm) {
  vec3 p = restMm / uPhotoTileMm;
  vec3 dpx = dFdx(p), dpy = dFdy(p);
  vec3 n = normalize(cross(dpx, dpy));
  vec3 w = pow(abs(n), vec3(4.0));
  w /= max(w.x + w.y + w.z, 1e-5);
  vec3 c = w.x * photoSample(p.yz, dpx.yz, dpy.yz) + w.y * photoSample(p.xz, dpx.xz, dpy.xz) + w.z * photoSample(p.xy, dpx.xy, dpy.xy);
  // once a pixel covers more than a few percent of a tile the detail is below the pixel and would only alias into
  // speckle (three blended tiles cannot average like a mipmap does): fade it to the mean with the footprint
  float footprint = max(length(dpx), length(dpy));
  float fade = 1.0 - smoothstep(0.025, 0.09, footprint);
  vec3 ratio = photoSrgbToLinear(c) / max(uPhotoMeanLinear, vec3(1e-3));
  return mix(vec3(1.0), ratio, fade);
}
// the photograph's luminance as relief: its screen-space gradient brought into the rest frame (the same construction
// as screen-space normal mapping), in height-mm per rest-mm, for the material's normal perturbation
vec3 photoReliefGradient(float lum, vec3 restMm) {
  vec3 dPx = dFdx(restMm), dPy = dFdy(restMm);
  float dLx = dFdx(lum), dLy = dFdy(lum);
  vec3 n = normalize(cross(dPx, dPy));
  vec3 r1 = cross(dPy, n), r2 = cross(n, dPx);
  float det = dot(dPx, r1);
  return (dLx * r1 + dLy * r2) * (sign(det) / max(abs(det), 1e-8));
}
`;

/** Lays the organ's photo tile over an installed atlas material. Call after installAtlasMaterial; strength 0 leaves
 *  the shading untouched. Idempotent per material: a second call replaces the layer. */
export function installPhotoDetail(material: THREE.MeshPhysicalMaterial, detail: PhotoDetail | null, strength: number, reliefMm = 0.03): void {
  const data = material.userData as { photoBase?: THREE.MeshPhysicalMaterial["onBeforeCompile"]; photoKey?: () => string; photoUniforms?: Record<string, THREE.IUniform> };
  data.photoBase ??= material.onBeforeCompile;
  data.photoKey ??= material.customProgramCacheKey.bind(material);
  const active = Boolean(detail) && strength > 0;
  const base = data.photoBase, baseKey = data.photoKey;
  const uniforms = data.photoUniforms ?? (data.photoUniforms = { uPhotoGauss: { value: null }, uPhotoLut: { value: null }, uPhotoStrength: { value: 0 }, uPhotoReliefMm: { value: 0.03 }, uPhotoTileMm: { value: 40 }, uPhotoMeanLinear: { value: new THREE.Vector3(1, 1, 1) } });
  uniforms.uPhotoGauss!.value = detail?.gauss ?? null;
  uniforms.uPhotoLut!.value = detail?.lut ?? null;
  uniforms.uPhotoStrength!.value = active ? strength : 0;
  uniforms.uPhotoReliefMm!.value = reliefMm;
  uniforms.uPhotoTileMm!.value = detail?.info.tile_mm ?? 40;
  (uniforms.uPhotoMeanLinear!.value as THREE.Vector3).set(...(detail?.info.mean_linear ?? [1, 1, 1]));
  material.customProgramCacheKey = () => `${baseKey()}${active ? ":photo-detail-1" : ""}`;
  material.onBeforeCompile = (shader, renderer) => {
    base?.(shader, renderer);
    if (!active) return;
    Object.assign(shader.uniforms, uniforms);
    const anchor = shader.fragmentShader.match(/AtlasMaterialSample atlasSurface = atlasSampleMaterial\([^;]*;/);
    if (!anchor) throw new Error("The tissue shader has no material sample to lay the photo detail over.");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GLSL}`)
      .replace(anchor[0], `${anchor[0]}
        vec3 photoRatio = photoDetail(vAtlasRestPosition);
        atlasSurface.colorLinear *= mix(vec3(1.0), photoRatio, uPhotoStrength);
        float photoLum = dot(photoRatio, vec3(0.2126, 0.7152, 0.0722));
        atlasSurface.heightGradientRest += uPhotoReliefMm * min(uPhotoStrength, 1.0) * photoReliefGradient(photoLum, vAtlasRestPosition);`);
  };
  material.needsUpdate = true;
}

/** The same layer over a whole-scene tissue material (wholeSceneMaterials.ts), which carries its rest frame in
 *  vSceneRest and sets diffuseColor itself: the modulation goes in before the roughness stage. Colour only. */
export function installScenePhotoDetail(material: THREE.MeshPhysicalMaterial, detail: PhotoDetail | null, strength: number): void {
  const data = material.userData as { photoBase?: THREE.MeshPhysicalMaterial["onBeforeCompile"]; photoKey?: () => string; photoUniforms?: Record<string, THREE.IUniform> };
  data.photoBase ??= material.onBeforeCompile;
  data.photoKey ??= material.customProgramCacheKey.bind(material);
  const active = Boolean(detail) && strength > 0;
  const base = data.photoBase, baseKey = data.photoKey;
  const uniforms = data.photoUniforms ?? (data.photoUniforms = { uPhotoGauss: { value: null }, uPhotoLut: { value: null }, uPhotoStrength: { value: 0 }, uPhotoReliefMm: { value: 0 }, uPhotoTileMm: { value: 40 }, uPhotoMeanLinear: { value: new THREE.Vector3(1, 1, 1) } });
  uniforms.uPhotoGauss!.value = detail?.gauss ?? null; uniforms.uPhotoLut!.value = detail?.lut ?? null;
  uniforms.uPhotoStrength!.value = active ? strength : 0; uniforms.uPhotoTileMm!.value = detail?.info.tile_mm ?? 40;
  (uniforms.uPhotoMeanLinear!.value as THREE.Vector3).set(...(detail?.info.mean_linear ?? [1, 1, 1]));
  material.customProgramCacheKey = () => `${baseKey()}${active ? ":photo-detail-1" : ""}`;
  material.onBeforeCompile = (shader, renderer) => {
    base?.(shader, renderer);
    if (!active) return;
    Object.assign(shader.uniforms, uniforms);
    if (!/vSceneRest/.test(shader.fragmentShader)) throw new Error("The scene tissue shader has no rest frame to lay the photo detail in.");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GLSL}`)
      .replace("#include <roughnessmap_fragment>", "diffuseColor.rgb *= mix(vec3(1.0), photoDetail(vSceneRest), uPhotoStrength);\n#include <roughnessmap_fragment>");
  };
  material.needsUpdate = true;
}
/** Which tile a whole-scene structure takes: the organ it is, or the organ its tissue is closest to. */
export const SCENE_TILE_ORGAN: Record<string, string> = { liver: "liver", stomach: "stomach", spleen: "spleen", "small-intestine": "small-intestine", duodenum: "small-intestine", colon: "large-intestine", gallbladder: "gallbladder", pancreas: "pancreas", "right-kidney": "kidney", "left-kidney": "kidney", "urinary-bladder": "urinary-bladder", "right-lung": "lung", "left-lung": "lung", heart: "heart", esophagus: "stomach" };

/** What the texture lab says when a visitor wants to generate a tile from a photograph of their own. The pipeline
 * (pipelines/textures/photo_tiles.py) runs on the API host; the public copy has none, and the host is not published
 * until a Hugging Face write token is provided. */
export const GENERATION_NOTICE = {
  offline: "No Hugging Face key yet. Generating a tile from your own photograph runs on the VISCERA API host, and that host is not published until a Hugging Face write token is provided. Until then this page shows the tiles generated on 12 October 2026 from the bundled photographs.",
  online: "The running API does not expose the texture pipeline yet: pipelines/textures/photo_tiles.py generates a tile offline from a photograph and its reviewed organ mask.",
} as const;
