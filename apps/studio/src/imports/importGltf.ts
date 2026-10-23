import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { IMPORT_LIMITS, ImportResources, LocalFiles, boundedInteger, checkAbort, dataBytes, decodeImages, textOf, type SelectedFile } from "./importResources";

type Json = Record<string, any>;
const EXTENSIONS = new Set([
  "KHR_materials_unlit", "KHR_materials_clearcoat", "KHR_materials_dispersion", "KHR_materials_sheen",
  "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_ior", "KHR_materials_emissive_strength",
  "KHR_materials_specular", "KHR_materials_iridescence", "KHR_materials_anisotropy", "EXT_materials_bump",
  "KHR_texture_transform", "KHR_mesh_quantization", "EXT_meshopt_compression", "KHR_meshopt_compression",
]);
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
function list(value: unknown, max: number, label: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new Error(`Invalid or excessive glTF ${label}.`);
  return value as Json[];
}
function index(value: unknown, array: readonly unknown[], label: string) {
  return boundedInteger(value, array.length - 1, label);
}
function guardJson(json: unknown) {
  const pending: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++count > 2_000_000 || depth > 64) throw new Error("glTF JSON is too complex.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("glTF contains nonfinite numbers.");
    if (typeof value !== "object" || !value) continue;
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe metadata key in glTF.");
      if (key === "extensions" && child && typeof child === "object") {
        for (const extension of Object.keys(child)) if (!EXTENSIONS.has(extension)) throw new Error(`Unsupported glTF extension: ${extension}. Export a static mesh with baked PNG/JPEG materials.`);
      }
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}
export function readGltfContainer(entry: SelectedFile): { json: Json; binary?: ArrayBuffer } {
  let jsonText: string, binary: ArrayBuffer | undefined;
  if (entry.path.toLowerCase().endsWith(".glb")) {
    const view = new DataView(entry.bytes);
    if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== view.byteLength) throw new Error("Invalid GLB v2 header or length.");
    let at = 12; jsonText = "";
    while (at < view.byteLength) {
      if (at + 8 > view.byteLength) throw new Error("Truncated GLB chunk.");
      const length = view.getUint32(at, true), type = view.getUint32(at + 4, true); at += 8;
      if (length % 4 || at + length > view.byteLength) throw new Error("Invalid GLB chunk length.");
      if (type === 0x4e4f534a && !jsonText && at === 20) jsonText = textOf(entry.bytes.slice(at, at + length), "glTF JSON").trimEnd();
      else if (type === 0x004e4942 && jsonText && binary === undefined) binary = entry.bytes.slice(at, at + length);
      else throw new Error("Unsupported or duplicate GLB chunk.");
      at += length;
    }
    if (!jsonText) throw new Error("GLB has no JSON chunk.");
  } else jsonText = textOf(entry.bytes, "glTF JSON");
  let json: Json;
  try { json = JSON.parse(jsonText); } catch { throw new Error("Invalid glTF JSON."); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid glTF document.");
  guardJson(json);
  if (json.asset?.version !== "2.0") throw new Error("Only glTF 2.0 models are supported.");
  return binary === undefined ? { json } : { json, binary };
}

/** Preflight allocations, hierarchy and every dependency before invoking Three. */
export function preflightGltf(entry: SelectedFile, files: LocalFiles) {
  const { json, binary } = readGltfContainer(entry);
  const buffers = list(json.buffers, 256, "buffers"), views = list(json.bufferViews, 8192, "buffer views");
  const accessors = list(json.accessors, 8192, "accessors"), images = list(json.images, IMPORT_LIMITS.textures, "images");
  const textures = list(json.textures, IMPORT_LIMITS.textures, "textures"), materials = list(json.materials, IMPORT_LIMITS.materials, "materials");
  const meshes = list(json.meshes, IMPORT_LIMITS.meshes, "meshes"), nodes = list(json.nodes, IMPORT_LIMITS.nodes, "nodes");
  const scenes = list(json.scenes, 8, "scenes");
  if (list(json.animations, 0, "animations").length || list(json.skins, 0, "skins").length) throw new Error("Animated or skinned models are unsupported; export a static evaluated mesh.");
  for (const extension of [...(json.extensionsRequired ?? []), ...(json.extensionsUsed ?? [])]) if (!EXTENSIONS.has(extension)) throw new Error(`Unsupported glTF extension: ${extension}. Export a static baked model.`);
  let allocated = 0;
  const bufferData = buffers.map((definition, i) => {
    const length = boundedInteger(definition.byteLength, IMPORT_LIMITS.decodedBufferBytes, "buffer length", 1);
    allocated += length;
    let bytes: ArrayBuffer;
    if (definition.uri === undefined) {
      if (i !== 0 || !binary) throw new Error("glTF buffer has no local data.");
      bytes = binary;
    } else {
      if (typeof definition.uri !== "string") throw new Error("Invalid glTF buffer URI.");
      bytes = definition.uri.startsWith("data:") ? dataBytes(definition.uri) : files.resolve(definition.uri, entry.path).bytes;
    }
    if (bytes.byteLength < length) throw new Error("Truncated glTF buffer.");
    return bytes;
  });
  for (const view of views) {
    const buffer = bufferData[index(view.buffer, bufferData, "buffer index")]!;
    const start = boundedInteger(view.byteOffset ?? 0, buffer.byteLength, "buffer view offset");
    const size = boundedInteger(view.byteLength, IMPORT_LIMITS.decodedBufferBytes, "buffer view length", 1);
    const compressed = view.extensions?.EXT_meshopt_compression ?? view.extensions?.KHR_meshopt_compression;
    if (compressed) {
      const source = bufferData[index(compressed.buffer, bufferData, "meshopt buffer")]!;
      const from = boundedInteger(compressed.byteOffset ?? 0, source.byteLength, "meshopt offset");
      const length = boundedInteger(compressed.byteLength, source.byteLength, "meshopt size", 1);
      const count = boundedInteger(compressed.count, IMPORT_LIMITS.vertices * 3, "meshopt count", 1);
      const stride = boundedInteger(compressed.byteStride, 256, "meshopt stride", 1);
      if (from + length > source.byteLength || count * stride !== size || !["ATTRIBUTES","TRIANGLES","INDICES"].includes(compressed.mode)) throw new Error("Invalid meshopt buffer layout.");
      allocated += size;
    } else if (start + size > buffer.byteLength) throw new Error("glTF buffer view exceeds local data.");
    if (view.byteStride !== undefined) boundedInteger(view.byteStride, 252, "buffer view stride", 4);
  }
  for (const accessor of accessors) {
    const count = boundedInteger(accessor.count, IMPORT_LIMITS.vertices * 3, "accessor count", 1);
    const components = COMPONENTS[accessor.type], bytes = BYTES[accessor.componentType];
    if (!components || !bytes) throw new Error("Invalid glTF accessor type.");
    allocated += count * components * Math.max(bytes, 4);
    if (accessor.bufferView !== undefined) {
      const view = views[index(accessor.bufferView, views, "accessor buffer view")]!;
      const offset = boundedInteger(accessor.byteOffset ?? 0, view.byteLength, "accessor byte offset");
      // MAT2/MAT3 with short components have additional column padding.
      const row = accessor.type === "MAT2" ? 2 : accessor.type === "MAT3" ? 3 : accessor.type === "MAT4" ? 4 : 0;
      const packed = row ? row * Math.ceil(row * bytes / 4) * 4 : components * bytes;
      const stride = view.byteStride ?? packed;
      if (stride < packed || offset + (count - 1) * stride + packed > view.byteLength) throw new Error("glTF accessor exceeds its buffer view.");
    }
    if (accessor.sparse !== undefined) {
      const sparse = accessor.sparse, n = boundedInteger(sparse.count, count, "sparse accessor count", 1);
      if (![5121,5123,5125].includes(sparse.indices?.componentType)) throw new Error("Sparse indices must be unsigned integers.");
      for (const [definition, width] of [[sparse.indices, BYTES[sparse.indices?.componentType]], [sparse.values, components * bytes]] as const) {
        if (!definition || !width) throw new Error("Invalid sparse accessor.");
        const view = views[index(definition.bufferView, views, "sparse buffer view")]!;
        const offset = boundedInteger(definition.byteOffset ?? 0, view.byteLength, "sparse offset");
        if (offset + n * width > view.byteLength) throw new Error("Sparse accessor exceeds its buffer.");
      }
      const sparseView = views[sparse.indices.bufferView]!;
      if (sparseView.extensions) throw new Error("Compressed sparse index buffers are unsupported.");
      const data = new DataView(bufferData[sparseView.buffer]!);
      const offset = (sparseView.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0), width = BYTES[sparse.indices.componentType]!;
      let previous = -1;
      for (let i = 0; i < n; i++) {
        const at = offset + i * width, value = width === 1 ? data.getUint8(at) : width === 2 ? data.getUint16(at,true) : data.getUint32(at,true);
        if (value >= count || value <= previous) throw new Error("Sparse accessor indices must increase within the accessor bounds.");
        previous = value;
      }
    }
  }
  if (allocated > IMPORT_LIMITS.decodedBufferBytes) throw new Error("glTF decoded geometry exceeds the 128 MiB budget.");
  let vertices = 0, triangles = 0, primitives = 0;
  for (const mesh of meshes) {
    if (mesh.weights || !Array.isArray(mesh.primitives)) throw new Error("Morph targets are unsupported; export the evaluated static shape.");
    for (const primitive of mesh.primitives) {
      if (primitive.targets) throw new Error("Morph targets are unsupported; export the evaluated static shape.");
      const p = accessors[index(primitive.attributes?.POSITION, accessors, "position accessor")]!;
      if (p.type !== "VEC3") throw new Error("Position accessors must be VEC3.");
      const mode = primitive.mode ?? 4;
      if (![4,5,6].includes(mode)) throw new Error("Only triangle surfaces are supported, not point clouds or lines.");
      const indices = primitive.indices === undefined ? undefined : accessors[index(primitive.indices, accessors, "index accessor")]!;
      if (indices && (indices.type !== "SCALAR" || ![5121,5123,5125].includes(indices.componentType) || indices.normalized === true)) throw new Error("Triangle indices must be non-normalized unsigned SCALAR accessors.");
      const count = indices?.count ?? p.count;
      if (mode === 4 && count % 3) throw new Error("Triangle index count is not divisible by three.");
      vertices += p.count; triangles += mode === 4 ? count / 3 : Math.max(0, count - 2); primitives++;
      if (primitive.material !== undefined) index(primitive.material, materials, "material index");
      for (const [semantic, value] of Object.entries(primitive.attributes)) {
        const attribute = accessors[index(value, accessors, "attribute accessor")]!;
        if (attribute.count !== p.count) throw new Error("Mesh vertex attributes have different counts.");
        const type = semantic === "NORMAL" ? "VEC3" : semantic === "TANGENT" ? "VEC4"
          : /^TEXCOORD_\d+$/.test(semantic) ? "VEC2" : /^(?:JOINTS|WEIGHTS)_\d+$/.test(semantic) ? "VEC4" : undefined;
        if (type && attribute.type !== type) throw new Error(`glTF ${semantic} must use a ${type} accessor.`);
        if (/^COLOR_\d+$/.test(semantic) && !["VEC3","VEC4"].includes(attribute.type)) throw new Error("glTF vertex colors must use VEC3 or VEC4 accessors.");
      }
    }
  }
  if (vertices > IMPORT_LIMITS.vertices || triangles > IMPORT_LIMITS.triangles || primitives > IMPORT_LIMITS.meshes) throw new Error("Model exceeds the geometry complexity limits.");
  const parents = new Map<number, number>();
  nodes.forEach((node, id) => {
    if (node.skin !== undefined || node.weights !== undefined) throw new Error("Skinning and morph targets are unsupported.");
    if (node.mesh !== undefined) index(node.mesh, meshes, "node mesh");
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error("Invalid node children.");
    for (const child of node.children ?? []) {
      const childIndex = index(child, nodes, "child node");
      if (parents.has(childIndex)) throw new Error("A glTF node has multiple parents.");
      parents.set(childIndex, id);
    }
  });
  for (let i = 0; i < nodes.length; i++) {
    let at: number | undefined = i, depth = 0;
    while (at !== undefined) { if (++depth > 128) throw new Error("Cyclic or excessively deep model hierarchy."); at = parents.get(at); }
  }
  if (!scenes.length) throw new Error("glTF has no scene.");
  index(json.scene ?? 0, scenes, "default scene");
  let instances = 0;
  for (const scene of scenes) {
    if (!Array.isArray(scene.nodes)) throw new Error("Invalid scene root nodes.");
    const seen = new Set<number>(), pending = [...scene.nodes];
    while (pending.length) {
      const id = index(pending.pop(), nodes, "scene node");
      if (seen.has(id)) throw new Error("Duplicate node in glTF scene.");
      seen.add(id);
      const node = nodes[id]!;
      if (node.mesh !== undefined) instances += meshes[node.mesh]!.primitives.length;
      pending.push(...(node.children ?? []));
    }
  }
  if (instances > IMPORT_LIMITS.meshes) throw new Error("Too many mesh instances in glTF scenes.");
  const imageData = images.map(image => {
    if (image.uri !== undefined) {
      if (typeof image.uri !== "string") throw new Error("Invalid image URI.");
      return image.uri.startsWith("data:") ? dataBytes(image.uri) : files.resolve(image.uri, entry.path).bytes;
    }
    const view = views[index(image.bufferView, views, "image buffer view")]!;
    if (view.extensions) throw new Error("Compressed image buffer views are unsupported.");
    return bufferData[view.buffer]!.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  });
  for (const texture of textures) {
    index(texture.source, imageData, "texture image");
    if (texture.sampler !== undefined) index(texture.sampler, json.samplers ?? [], "texture sampler");
  }
  return { json, bufferData, imageData };
}

export async function loadGltf(entry: SelectedFile, files: LocalFiles, resources: ImportResources, warnings: string[], signal?: AbortSignal): Promise<THREE.Group> {
  const { json, bufferData, imageData } = preflightGltf(entry, files);
  const images = await decodeImages(imageData, resources, false, signal);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => { throw new Error("Unexpected external resource request was blocked."); });
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  loader.register(parser => {
    // No FileLoader/TextureLoader calls: all bytes and decoded images are owned
    // by this import. A URL-looking string in the document cannot fetch anything.
    parser.loadBuffer = async i => { checkAbort(signal); return bufferData[i]!; };
    parser.loadTexture = async i => {
      checkAbort(signal);
      const definition = json.textures[i], sampler = json.samplers?.[definition.sampler] ?? {};
      const texture = new THREE.Texture(images[definition.source]);
      texture.flipY = false; texture.needsUpdate = true; texture.name = definition.name ?? "";
      const filters: Record<number, THREE.MagnificationTextureFilter | THREE.MinificationTextureFilter> = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
      const wraps: Record<number, THREE.Wrapping> = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
      texture.magFilter = (filters[sampler.magFilter] ?? THREE.LinearFilter) as THREE.MagnificationTextureFilter;
      texture.minFilter = filters[sampler.minFilter] ?? THREE.LinearMipmapLinearFilter;
      texture.wrapS = wraps[sampler.wrapS] ?? THREE.RepeatWrapping; texture.wrapT = wraps[sampler.wrapT] ?? THREE.RepeatWrapping;
      texture.generateMipmaps = texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
      resources.own(texture); return texture;
    };
    const getDependency = parser.getDependency.bind(parser);
    parser.getDependency = (type, i) => getDependency(type, i).then(value => { resources.own(value); return value; });
    const loadGeometries = parser.loadGeometries.bind(parser);
    parser.loadGeometries = primitives => loadGeometries(primitives).then(value => { resources.own(value); return value; });
    return { name: "VISCERA_local_import_resources" };
  });
  const gltf = await loader.parseAsync(JSON.stringify(json), "");
  gltf.scenes.forEach(scene => resources.own(scene)); checkAbort(signal);
  if (gltf.scenes.length > 1) warnings.push("Only the file's default scene is displayed and exported.");
  if ((json.cameras?.length ?? 0) > 0) warnings.push("Imported camera nodes are retained; inspection uses the Studio camera.");
  warnings.push("glTF uses metres and standard PBR materials. Blender/Unity custom shaders must be baked into these maps.");
  const root = new THREE.Group(); root.name = entry.file.name; root.add(gltf.scene);
  return root;
}
