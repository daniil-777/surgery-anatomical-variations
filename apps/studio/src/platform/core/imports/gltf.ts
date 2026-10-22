// glTF 2.0 documents read without three.js: the GLB container, the JSON (with the checks that must happen before
// GLTFLoader allocates anything) and the facts used for detection and limits — generator, Sketchfab-style
// asset.extras, external files, extensions, and vertex/triangle counts from the accessors.

import type { JsonObject, JsonValue } from "../types";
import { readU32, startsWithAscii, utf8Text } from "./bytes";
import { importRefusal } from "./errors";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

export interface GltfContainer {
  json: JsonObject;
  /** The GLB binary chunk (buffer 0 without a URI), or null. */
  bin: Uint8Array | null;
}

/** Extensions three.js r186 reads without extra decoders (KHR_draco_mesh_compression and KHR_texture_basisu need them). */
export const SUPPORTED_GLTF_EXTENSIONS: ReadonlySet<string> = new Set([
  "KHR_lights_punctual",
  "KHR_materials_clearcoat",
  "KHR_materials_dispersion",
  "KHR_materials_ior",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_iridescence",
  "KHR_materials_anisotropy",
  "KHR_materials_unlit",
  "KHR_materials_volume",
  "KHR_materials_emissive_strength",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "EXT_materials_bump",
  "EXT_texture_webp",
  "EXT_texture_avif",
  "EXT_meshopt_compression",
  "KHR_meshopt_compression",
  "EXT_mesh_gpu_instancing",
  "KHR_xmp_json_ld",
  "KHR_materials_variants",
]);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const DAMAGED = "The file may be damaged or incomplete. Export or download it again.";
const REEXPORT = "Export it again from the app that made it, as glTF 2.0 (GLB works best).";

/** The JSON and BIN chunks of a GLB file. */
export function readGlb(bytes: Uint8Array, label = "The GLB file"): { jsonText: string; bin: Uint8Array | null } {
  if (bytes.length < 20 || !startsWithAscii(bytes, "glTF")) throw importRefusal(`${label} has no GLB header.`, "gltf-container", { advice: DAMAGED });
  const version = readU32(bytes, 4);
  if (version !== 2) throw importRefusal(`${label} is glTF ${version}.0; only glTF 2.0 can be imported.`, "unsupported:gltf1", { advice: "Re-export it as glTF 2.0 (GLB)." });
  const length = readU32(bytes, 8);
  if (length > bytes.length || length < 20) throw importRefusal(`${label} is truncated (the header says ${length} bytes, the file has ${bytes.length}).`, "gltf-container", { advice: DAMAGED });
  let at = 12;
  let jsonText: string | null = null;
  let bin: Uint8Array | null = null;
  while (at + 8 <= length) {
    const chunkLength = readU32(bytes, at);
    const chunkType = readU32(bytes, at + 4);
    const start = at + 8;
    if (start + chunkLength > length) throw importRefusal(`${label} has a chunk that runs past the end of the file.`, "gltf-container", { advice: DAMAGED });
    if (chunkType === GLB_JSON && jsonText === null) jsonText = utf8Text(bytes, start, start + chunkLength);
    else if (chunkType === GLB_BIN && bin === null && jsonText !== null) bin = bytes.subarray(start, start + chunkLength);
    at = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (jsonText === null) throw importRefusal(`${label} has no JSON chunk.`, "gltf-container", { advice: DAMAGED });
  return { jsonText, bin };
}

/** Parses glTF JSON, refusing keys that would reach object prototypes (GLTFLoader copies extras with Object.assign). */
export function parseGltfJson(text: string, label = "The glTF file"): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw importRefusal(`${label} is not valid JSON.`, "gltf-json", { advice: DAMAGED });
  }
  if (!isObject(value)) throw importRefusal(`${label} is not a glTF document.`, "gltf-json", { advice: REEXPORT });
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (++visited > 5_000_000) throw importRefusal(`${label} is too complex to inspect.`, "gltf-json", { code: "limit_reached", advice: "Simplify the scene and export it again." });
    if (Array.isArray(item)) {
      for (const child of item) if (typeof child === "object" && child !== null) pending.push(child);
    } else if (isObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (UNSAFE_KEYS.has(key)) throw importRefusal(`${label} contains the reserved key "${key}" and was not loaded.`, "gltf-unsafe-key", { advice: REEXPORT });
        if (typeof child === "object" && child !== null) pending.push(child);
      }
    }
  }
  const asset = value.asset;
  const version = isObject(asset) && typeof asset.version === "string" ? asset.version : null;
  if (version === null) throw importRefusal(`${label} has no asset.version; it is not a glTF 2.0 document.`, "gltf-json", { advice: REEXPORT });
  if (!/^2\.\d+$/.test(version)) throw importRefusal(`${label} is glTF ${version}; only glTF 2.0 can be imported.`, "unsupported:gltf1", { advice: "Re-export it as glTF 2.0." });
  return value as JsonObject;
}

export function readGltf(bytes: Uint8Array, binary: boolean, label?: string): GltfContainer {
  if (binary) {
    const { jsonText, bin } = readGlb(bytes, label);
    return { json: parseGltfJson(jsonText, label), bin };
  }
  return { json: parseGltfJson(utf8Text(bytes), label), bin: null };
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export interface GltfFacts {
  generator: string | null;
  copyright: string | null;
  /** asset.extras as written by Sketchfab and others: {title, author, license, source}. */
  extras: { title: string | null; author: string | null; license: string | null; source: string | null };
  /** KHR_xmp_json_ld packet "xmp:CreatorTool". */
  creatorTool: string | null;
  extensionsUsed: string[];
  extensionsRequired: string[];
  meshes: number;
  materials: number;
  images: number;
  animations: number;
  skins: number;
  /** Per mesh definition (not per instance), from the accessor counts. */
  vertices: number;
  triangles: number;
  /** External files the document needs (not data: URIs). */
  bufferUris: string[];
  imageUris: string[];
  /** Primitives compressed with Draco without an uncompressed fallback. */
  dracoOnly: boolean;
  /** Textures whose only image source is KTX2 (KHR_texture_basisu). */
  ktx2Only: boolean;
}

export function inspectGltf(json: JsonObject): GltfFacts {
  const asset = isObject(json.asset) ? json.asset : {};
  const extras = isObject(asset.extras) ? asset.extras : {};
  const accessors = list(json.accessors);
  const meshes = list(json.meshes);
  let vertices = 0;
  let triangles = 0;
  let dracoOnly = false;
  for (const mesh of meshes) {
    for (const primitive of list(mesh.primitives)) {
      const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
      const position = typeof attributes.POSITION === "number" ? accessors[attributes.POSITION] : undefined;
      const extensions = isObject(primitive.extensions) ? primitive.extensions : {};
      if (isObject(extensions.KHR_draco_mesh_compression) && (position === undefined || position.bufferView === undefined)) dracoOnly = true;
      const vertexCount = count(position?.count);
      vertices += vertexCount;
      const indices = typeof primitive.indices === "number" ? accessors[primitive.indices] : undefined;
      const elementCount = indices ? count(indices.count) : vertexCount;
      const mode = typeof primitive.mode === "number" ? primitive.mode : 4;
      if (mode === 4) triangles += Math.floor(elementCount / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, elementCount - 2);
    }
  }
  const images = list(json.images);
  const ktx2Only = list(json.textures).some((texture) => {
    const extensions = isObject(texture.extensions) ? texture.extensions : {};
    return isObject(extensions.KHR_texture_basisu) && texture.source === undefined;
  });
  let creatorTool: string | null = null;
  const xmp = isObject(json.extensions) && isObject(json.extensions.KHR_xmp_json_ld) ? json.extensions.KHR_xmp_json_ld : null;
  if (xmp) {
    for (const packet of list(xmp.packets)) {
      creatorTool ??= text(packet["xmp:CreatorTool"]);
    }
  }
  const strings = (value: JsonValue | undefined) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const uriOf = (entry: JsonObject) => (typeof entry.uri === "string" && !/^data:/i.test(entry.uri) ? entry.uri : null);
  return {
    generator: text(asset.generator),
    copyright: text(asset.copyright),
    extras: { title: text(extras.title), author: text(extras.author), license: text(extras.license), source: text(extras.source) },
    creatorTool,
    extensionsUsed: strings(json.extensionsUsed),
    extensionsRequired: strings(json.extensionsRequired),
    meshes: meshes.length,
    materials: list(json.materials).length,
    images: images.length,
    animations: list(json.animations).length,
    skins: list(json.skins).length,
    vertices,
    triangles,
    bufferUris: list(json.buffers).map(uriOf).filter((uri): uri is string => uri !== null),
    imageUris: images.map(uriOf).filter((uri): uri is string => uri !== null),
    dracoOnly,
    ktx2Only,
  };
}

/** Refuses documents that need decoders this importer does not ship. Returns notes for optional extensions it ignores. */
export function checkGltfExtensions(facts: GltfFacts, label: string): string[] {
  const required = new Set(facts.extensionsRequired);
  if (required.has("KHR_draco_mesh_compression") || facts.dracoOnly) {
    throw importRefusal(`${label} uses Draco mesh compression, which isn't supported yet.`, "unsupported:draco", {
      advice: "Export it again without Draco (in Blender: glTF 2.0 export › Data › Compression off).",
    });
  }
  if (required.has("KHR_texture_basisu") || facts.ktx2Only) {
    throw importRefusal(`${label} uses KTX2 / Basis Universal textures, which aren't supported yet.`, "unsupported:ktx2", {
      advice: "Export it again with PNG, JPEG or WebP textures.",
    });
  }
  for (const name of required) {
    if (!SUPPORTED_GLTF_EXTENSIONS.has(name)) {
      throw importRefusal(`${label} requires the glTF extension ${name}, which this viewer can't read.`, "unsupported:gltf-extension", {
        advice: "Export it again without that extension.",
      });
    }
  }
  const ignored = facts.extensionsUsed.filter((name) => !SUPPORTED_GLTF_EXTENSIONS.has(name) && !required.has(name));
  return ignored.length > 0 ? [`Optional glTF extensions ignored by the preview: ${ignored.join(", ")}.`] : [];
}

/**
 * Removes material references to the given textures (their images are missing), so GLTFLoader never asks for them and
 * the material keeps its factors. Texture-info objects are any "...Texture" key holding {index} inside a material.
 */
export function dropTextureReferences(json: JsonObject, textureIndices: ReadonlySet<number>): number {
  let removed = 0;
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/Texture$/.test(key) && isObject(child) && typeof child.index === "number" && textureIndices.has(child.index)) {
        delete value[key];
        removed++;
      } else {
        visit(child);
      }
    }
  };
  for (const material of list(json.materials)) visit(material);
  return removed;
}

/** A GLB file from a JSON document and an optional binary chunk (both padded to 4 bytes as the format requires). */
export function writeGlb(json: JsonObject, bin: Uint8Array | null): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const binLength = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON, true);
  out.set(encoded, 20);
  out.fill(0x20, 20 + encoded.length, 20 + jsonLength);
  if (bin) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, GLB_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

/** Bytes of image `index` when it lives in a buffer view of the GLB binary chunk. */
export function glbImageBytes(json: JsonObject, bin: Uint8Array | null, index: number): Uint8Array | null {
  const image = list(json.images)[index];
  if (!image || typeof image.bufferView !== "number" || !bin) return null;
  const view = list(json.bufferViews)[image.bufferView];
  if (!view || view.buffer !== 0) return null;
  const start = count(view.byteOffset);
  const length = count(view.byteLength);
  return start + length <= bin.length ? bin.subarray(start, start + length) : null;
}

/** Indices of textures whose image is in `missingImages`. */
export function texturesUsingImages(json: JsonObject, missingImages: ReadonlySet<number>): Set<number> {
  const result = new Set<number>();
  list(json.textures).forEach((texture, index) => {
    if (typeof texture.source === "number" && missingImages.has(texture.source)) result.add(index);
  });
  return result;
}
