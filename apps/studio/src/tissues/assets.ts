import * as THREE from "three";
import type { TissueManifest } from "./contracts";

export const MAP_KEYS = ["substrate", "normal", "roughness", "vessels", "fascia", "adipose", "wet_film"] as const;
export type TissueMaps = Record<typeof MAP_KEYS[number], THREE.Texture> & Partial<Record<"substrate_normal" | "layer_relief" | "substrate_roughness", THREE.Texture>>;
export function materialFile(file: unknown): string {
  if (typeof file !== "string" || !/^[a-z0-9_][a-z0-9_/-]*\.png$/.test(file) || file.includes("..")) throw new Error("Invalid material path");
  return file;
}

/** Resolve the entire asset contract before starting any network requests. */
export function materialAssets(manifest: TissueManifest) {
  if (manifest.schema !== "viscera.tissue-materials/v1" || !Array.isArray(manifest.resolution) || manifest.resolution.length !== 2 || !manifest.resolution.every(n => Number.isInteger(n) && n >= 16 && n <= 8192) || manifest.resolution[0] !== manifest.resolution[1]) throw new Error("Unsupported tissue manifest");
  if (!manifest.recipe || typeof manifest.recipe.organ !== "string" || !Number.isFinite(manifest.recipe.tile_size_mm) || manifest.recipe.tile_size_mm <= 0) throw new Error("Invalid tissue dimensions");
  for (const name of ["wetness", "vessel_opacity", "fascia_opacity", "adipose_opacity"] as const) {
    const value = manifest.recipe[name];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid tissue ${name}`);
  }
  const assets: { key: keyof TissueMaps; file: string; color: boolean }[] = MAP_KEYS.map(key => {
    const layers = manifest.layers?.filter(layer => layer.id === key) ?? [];
    const channel = manifest.channels?.[key];
    if (!channel && layers.length !== 1) throw new Error(`Missing or duplicate tissue ${key}`);
    return { key, file: materialFile(channel ? channel.file : layers[0]!.file), color: key === "substrate" || key === "vessels" || key === "fascia" || key === "adipose" };
  });
  const dynamic = ["substrate_normal", "layer_relief"] as const;
  const present = dynamic.filter(key => manifest.channels[key]);
  if (present.length && present.length !== dynamic.length) throw new Error("Incomplete dynamic tissue relief");
  if (present.length) {
    const relief = manifest.channels.layer_relief!;
    if (JSON.stringify(relief.packing) !== '["vessels","adipose","fascia"]' || !Array.isArray(relief.decode_scale_mm) || relief.decode_scale_mm.length !== 3 || !relief.decode_scale_mm.every(value => Number.isFinite(value) && value > 0 && value <= 10) || JSON.stringify(relief.decode_offset_mm) !== '[0,0,0]') throw new Error("Unsupported tissue relief packing");
  }
  for (const key of present) {
    if (manifest.channels[key]!.color_space !== "linear") throw new Error("Relief textures must be linear data");
    assets.push({ key, file: materialFile(manifest.channels[key]!.file), color: false });
  }
  if (manifest.channels.substrate_roughness) {
    if (manifest.channels.substrate_roughness.color_space !== "linear") throw new Error("Substrate roughness must be linear data");
    assets.push({ key: "substrate_roughness", file: materialFile(manifest.channels.substrate_roughness.file), color: false });
  }
  return assets;
}

/** Transactional ownership: a cancelled or partially failed set releases every successful texture. */
export async function loadTissueMaps(manifest: TissueManifest, directory: string, anisotropy: number, signal: AbortSignal, load: (url: string) => Promise<THREE.Texture> = url => new THREE.TextureLoader().loadAsync(url), localFiles?: ReadonlyMap<string, Blob>): Promise<{ maps: TissueMaps; dispose: () => void }> {
  const assets = materialAssets(manifest);
  if (localFiles) for (const asset of assets) if (!localFiles.has(asset.file)) throw new Error(`Missing imported texture: ${asset.file}`);
  const localUrls = new Set<string>();
  const acquired = new Set<THREE.Texture>();
  let closed = false;
  const dispose = () => { closed = true; localUrls.forEach(url => URL.revokeObjectURL(url)); localUrls.clear(); acquired.forEach(texture => texture.dispose()); acquired.clear(); };
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { dispose(); reject(new DOMException("Material load cancelled", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (signal.aborted) onAbort();
  // Promise.all fails immediately; every late completion observes closed and releases itself.
  const pending = assets.map(async asset => {
    if (closed) throw new DOMException("Material load cancelled", "AbortError");
    const url = localFiles ? URL.createObjectURL(localFiles.get(asset.file)!) : `${directory}/${asset.file}`;
    if (localFiles) localUrls.add(url);
    let texture: THREE.Texture;
    try { texture = await load(url); }
    finally { if (localFiles && localUrls.delete(url)) URL.revokeObjectURL(url); }
    if (closed) { texture.dispose(); throw new DOMException("Material load cancelled", "AbortError"); }
    acquired.add(texture);
    const dimensions = texture.image as { width?: number; height?: number } | undefined;
    if (dimensions?.width !== manifest.resolution[0] || dimensions?.height !== manifest.resolution[1]) throw new Error(`Texture dimensions disagree: ${asset.key}`);
    texture.colorSpace = asset.color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, anisotropy);
    return [asset.key, texture] as const;
  });
  try {
    const results = await Promise.race([Promise.all(pending), aborted]);
    return { maps: Object.fromEntries(results) as TissueMaps, dispose };
  } catch (error) { dispose(); throw error; }
  finally { signal.removeEventListener("abort", onAbort); }
}
