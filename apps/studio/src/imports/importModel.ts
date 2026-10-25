import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader, type MaterialInfo } from "three/examples/jsm/loaders/MTLLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { loadGltf } from "./importGltf";
import { IMPORT_LIMITS, texturePixelCount, ImportResources, LocalFiles, checkAbort, decodeImages, sourceIdentity, textOf, type SelectedFile, type Triple } from "./importResources";
export { IMPORT_LIMITS } from "./importResources";

export interface ImportedModelStats {
  vertices: number; triangles: number; meshes: number; materials: number; textures: number;
  bounds: { min: Triple; max: Triple; size: Triple };
}
export interface ImportedModel {
  root: THREE.Group;
  filename: string;
  format: "glb" | "gltf" | "obj" | "stl";
  stats: ImportedModelStats;
  warnings: string[];
  source: { sha256: string; files: { path: string; sha256: string; bytes: number }[] };
  dispose(): void;
}

/** No normalization, merging or coordinate changes: original material groups,
 * transforms, UVs, normals and vertex alpha remain available to the editor. */
export function inspectImportedRoot(root: THREE.Object3D): ImportedModelStats {
  const materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  let vertices = 0, triangles = 0, meshes = 0;
  root.updateMatrixWorld(true);
  root.traverse(node => {
    if (node instanceof THREE.SkinnedMesh || node instanceof THREE.InstancedMesh) throw new Error("Skinned and instanced meshes are unsupported. Export ordinary static meshes.");
    if (node instanceof THREE.Line || node instanceof THREE.Points) throw new Error("Only triangle surface models are supported.");
    if (!node.matrixWorld.elements.every(Number.isFinite) || node.matrixWorld.determinant() === 0) throw new Error("Model contains an invalid or singular transform.");
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry as THREE.BufferGeometry;
    if (Object.values(geometry.morphAttributes).some(value => value && value.length > 0)) throw new Error("Morph targets must be baked before import.");
    const position = geometry.getAttribute("position");
    if (!position || position.itemSize !== 3 || !position.count) throw new Error("Mesh has no usable positions.");
    vertices += position.count; meshes++;
    const index = geometry.getIndex(), count = index?.count ?? position.count;
    if (count % 3) throw new Error("Mesh contains incomplete triangles.");
    triangles += count / 3;
    if (vertices > IMPORT_LIMITS.vertices || triangles > IMPORT_LIMITS.triangles || meshes > IMPORT_LIMITS.meshes) throw new Error("Displayed scene exceeds the geometry complexity limits.");
    for (const attribute of Object.values(geometry.attributes)) {
      if (attribute.count !== position.count) throw new Error("Mesh vertex attributes have different counts.");
      for (let i = 0; i < attribute.count; i++) for (let k = 0; k < attribute.itemSize; k++) {
        const value = attribute.getComponent(i, k);
        if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new Error("Mesh contains nonfinite or excessive vertex values.");
      }
    }
    const color = geometry.getAttribute("color");
    if (color) {
      if (color.itemSize !== 3 && color.itemSize !== 4) throw new Error("Vertex colors must have RGB or RGBA components.");
      for (let i = 0; i < color.count; i++) for (let k = 0; k < color.itemSize; k++) {
        const value = color.getComponent(i, k);
        if (value < 0 || value > 1) throw new Error("Vertex color values must be within zero and one.");
      }
    }
    if (index) for (let i = 0; i < index.count; i++) {
      const value = index.getX(i);
      if (!Number.isInteger(value) || value < 0 || value >= position.count) throw new Error("Mesh triangle index is out of bounds.");
    }
    const meshMaterials = Array.isArray(node.material) ? node.material : [node.material];
    for (const group of geometry.groups) if (!Number.isSafeInteger(group.start) || !Number.isSafeInteger(group.count) || group.start < 0 || group.count < 0 || group.start + group.count > count
      || (Array.isArray(node.material) && (!Number.isSafeInteger(group.materialIndex ?? 0) || (group.materialIndex ?? 0) < 0 || (group.materialIndex ?? 0) >= meshMaterials.length))) throw new Error("Invalid mesh material group.");
    for (const material of meshMaterials) {
      materials.add(material);
      for (const [key, value] of Object.entries(material)) {
        // Three uses +Infinity to mean no volume attenuation. This is a valid
        // MeshPhysicalMaterial default, including for ordinary clearcoat.
        if (typeof value === "number" && !Number.isFinite(value) && !(key === "attenuationDistance" && value === Infinity)) throw new Error("Material has nonfinite values.");
        if (value instanceof THREE.Color && !value.toArray().every(Number.isFinite)) throw new Error("Material has invalid color.");
        if (key === "color" && value instanceof THREE.Color && !value.toArray().every(v => v >= 0 && v <= 1)) throw new Error("Base color values must be within zero and one.");
        if (["opacity","metalness","roughness","clearcoat","clearcoatRoughness","transmission"].includes(key) && typeof value === "number" && (value < 0 || value > 1)) throw new Error(`Material ${key} must be within zero and one.`);
        if (key === "ior" && typeof value === "number" && value < 1) throw new Error("Material IOR must be at least one.");
        if (key === "attenuationDistance" && typeof value === "number" && value <= 0) throw new Error("Volume attenuation distance must be positive.");
        if (value instanceof THREE.Vector2 || value instanceof THREE.Vector3 || value instanceof THREE.Vector4 || value instanceof THREE.Matrix3 || value instanceof THREE.Matrix4) {
          if (!value.toArray().every(Number.isFinite)) throw new Error("Material has invalid vector or matrix values.");
        }
        if (value instanceof THREE.Texture) {
          if (![...value.offset.toArray(), ...value.repeat.toArray(), ...value.center.toArray(), value.rotation, ...value.matrix.elements].every(Number.isFinite)) throw new Error("Texture has invalid mapping coordinates.");
          textures.add(value);
        }
      }
    }
  });
  if (!meshes || !triangles) throw new Error("No triangle surface was found in this model.");
  if (materials.size > IMPORT_LIMITS.materials || textures.size > IMPORT_LIMITS.textures) throw new Error("Model exceeds the material or texture budget.");
  const pixels = [...textures].reduce((sum, texture) => sum + texturePixelCount(texture), 0);
  if (pixels > IMPORT_LIMITS.imagePixels) throw new Error("Decoded textures exceed the 32 megapixel import budget.");
  const bounds = new THREE.Box3().setFromObject(root, true), size = bounds.getSize(new THREE.Vector3());
  if (![...bounds.min.toArray(), ...bounds.max.toArray()].every(v => Number.isFinite(v) && Math.abs(v) <= 1e9) || size.lengthSq() === 0) throw new Error("Model bounds are invalid or empty.");
  return { vertices, triangles, meshes, materials: materials.size, textures: textures.size,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), size: size.toArray() } };
}
function safeName(name: string) {
  if (["__proto__", "constructor", "prototype"].includes(name) || name.length > 1024) throw new Error("Unsupported material or object name.");
}
async function loadObj(entry: SelectedFile, files: LocalFiles, resources: ImportResources, warnings: string[], signal?: AbortSignal) {
  const text = textOf(entry.bytes, "OBJ", 32 * 1024 * 1024), libraries: SelectedFile[] = [], used = new Set<string>();
  let vertexCount = 0, uvCount = 0, normalCount = 0, triangles = 0, objects = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(), [keyword, ...values] = line.split(/\s+/);
    const value = line.slice(keyword?.length ?? 0).trim();
    if (["v","vt","vn"].includes(keyword ?? "")) {
      if (values.some(v => !Number.isFinite(Number(v)))) throw new Error("OBJ contains invalid vertex values.");
      if (keyword === "v") vertexCount++; else if (keyword === "vt") uvCount++; else normalCount++;
    } else if (keyword === "f") {
      if (values.length < 3) throw new Error("OBJ face has fewer than three vertices.");
      triangles += values.length - 2;
      for (const token of values) token.split("/").forEach((part, i) => {
        if (part === "" && i > 0) return;
        const n = Number(part), count = [vertexCount, uvCount, normalCount][i];
        if (count === undefined || !Number.isSafeInteger(n) || n === 0 || Math.abs(n) > count) throw new Error("OBJ face index is out of bounds.");
      });
    } else if (keyword === "mtllib") {
      try { libraries.push(files.resolve(value, entry.path)); }
      catch (error) {
        // OBJ permits several libraries on one line; try an exact filename
        // first so a selected MTL containing spaces also remains usable.
        if (values.length <= 1) throw error;
        for (const path of values) libraries.push(files.resolve(path, entry.path));
      }
    }
    else if (keyword === "usemtl") { safeName(value); used.add(value); }
    else if (keyword === "o" || keyword === "g") { safeName(value); objects++; }
    else if (keyword === "p" || keyword === "l") throw new Error("OBJ lines and points are unsupported; export triangle surfaces.");
  }
  if (vertexCount > IMPORT_LIMITS.vertices || uvCount > IMPORT_LIMITS.vertices || normalCount > IMPORT_LIMITS.vertices || triangles * 3 > IMPORT_LIMITS.vertices || triangles > IMPORT_LIMITS.triangles || objects > IMPORT_LIMITS.meshes) throw new Error("OBJ exceeds the decoded geometry limits.");
  if (!triangles) throw new Error("OBJ has no surface faces.");
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => { throw new Error("Unexpected texture fetch blocked."); });
  const creator = new MTLLoader(manager).parse("", "");
  const info: Record<string, MaterialInfo> = Object.create(null);
  const imageBytes: ArrayBuffer[] = [], imagePaths = new Map<string, number>();
  for (const library of new Set(libraries)) {
    const mtlText = textOf(library.bytes, "MTL");
    for (const match of mtlText.matchAll(/^\s*newmtl\s+(.+)$/gm)) safeName(match[1]!.trim());
    const parsed = new MTLLoader(manager).parse(mtlText, "");
    for (const [name, definition] of Object.entries(parsed.materialsInfo)) {
      if (Object.hasOwn(info, name)) throw new Error(`Duplicate material name: ${name}`);
      const copy = { ...definition };
      for (const key of ["map_kd","map_ks","map_ke","norm","map_bump","bump","disp","map_d"] as const) {
        if (!copy[key]) continue;
        const params = parsed.getTextureParams(copy[key]!, {});
        const image = files.resolve(params.url, library.path);
        let id = imagePaths.get(image.path);
        if (id === undefined) { id = imageBytes.length; imagePaths.set(image.path, id); imageBytes.push(image.bytes); }
        // Preserve supported map switches; replace just the resolved filename.
        copy[key] = copy[key]!.slice(0, copy[key]!.lastIndexOf(params.url)) + `local-image-${id}`;
      }
      info[name] = copy;
    }
  }
  if (Object.keys(info).length > IMPORT_LIMITS.materials) throw new Error("Too many OBJ materials.");
  for (const name of used) if (!Object.hasOwn(info, name)) throw new Error(`Missing OBJ material '${name}'. Select the MTL file and its textures.`);
  const images = await decodeImages(imageBytes, resources, true, signal);
  creator.setMaterials(info);
  creator.loadTexture = url => {
    const match = /^local-image-(\d+)$/.exec(url), image = match && images[Number(match[1])];
    if (!image) throw new Error("Unresolved OBJ texture.");
    const texture = new THREE.Texture(image);
    texture.flipY = false; texture.needsUpdate = true; resources.own(texture); return texture;
  };
  // Own material creation immediately, including an error partway through OBJ.
  const create = creator.create.bind(creator);
  creator.create = name => { const material = create(name); resources.own(material); return material; };
  checkAbort(signal);
  const root = new OBJLoader(manager).setMaterials(creator).parse(text); resources.own(root);
  warnings.push("OBJ coordinates have no declared physical unit. OBJ/MTL uses a legacy material model; its GLB export approximates this material as standard PBR.");
  if (!libraries.length) warnings.push("This OBJ has no material library; its vertex colors, if present, and a neutral surface are shown.");
  return root;
}
function loadStl(entry: SelectedFile, resources: ImportResources, warnings: string[]) {
  const view = new DataView(entry.bytes);
  const binaryFaces = view.byteLength >= 84 ? view.getUint32(80, true) : 0;
  const isBinary = view.byteLength >= 84 && 84 + binaryFaces * 50 === view.byteLength;
  if (isBinary) {
    if (!binaryFaces || binaryFaces * 3 > IMPORT_LIMITS.vertices || binaryFaces > IMPORT_LIMITS.triangles) throw new Error("STL exceeds the decoded geometry limits.");
  } else {
    const text = textOf(entry.bytes, "ASCII STL", 32 * 1024 * 1024);
    const faces = (text.match(/\bfacet\s+normal\b/g) ?? []).length;
    if (!/^\s*solid\b/.test(text) || !/\bendsolid\b/.test(text) || !faces || faces * 3 > IMPORT_LIMITS.vertices) throw new Error("Invalid, truncated or excessive STL surface.");
  }
  const geometry = new STLLoader().parse(entry.bytes); resources.own(geometry);
  const colored = geometry.hasAttribute("color");
  const material = new THREE.MeshStandardMaterial({ color: colored ? 0xffffff : 0xb7c6cb, roughness: .6, metalness: 0, vertexColors: colored });
  resources.own(material);
  const root = new THREE.Group(); root.name = entry.file.name; root.add(new THREE.Mesh(geometry, material));
  warnings.push("STL does not contain standard materials, UV textures or physical units. A neutral surface is used.");
  if (colored) warnings.push("Nonstandard STL vertex colors were retained; use GLB for portable material/color exchange.");
  return root;
}

export async function loadImportedModel(files: readonly File[], signal?: AbortSignal, options: { allowMultiModelScene?: boolean } = {}): Promise<ImportedModel> {
  const resources = new ImportResources(), selected = new LocalFiles();
  const abort = () => resources.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    checkAbort(signal); await selected.read(files, signal);
    const candidates = selected.entries.filter(entry => /\.(glb|gltf|obj|stl)$/i.test(entry.path));
    if (!candidates.length || (candidates.length !== 1 && !options.allowMultiModelScene)) throw new Error("Select exactly one GLB, glTF, OBJ or STL model, together with its dependency files.");
    const entry = candidates[0]!, format = entry.path.split(".").at(-1)!.toLowerCase() as ImportedModel["format"];
    const warnings: string[] = [];
    const load = async (item: SelectedFile) => {
      const kind = item.path.split(".").at(-1)!.toLowerCase();
      const object = kind === "glb" || kind === "gltf" ? await loadGltf(item, selected, resources, warnings, signal)
        : kind === "obj" ? await loadObj(item, selected, resources, warnings, signal) : loadStl(item, resources, warnings);
      resources.own(object); checkAbort(signal);
      return object;
    };
    const root = candidates.length === 1 ? await load(entry) : new THREE.Group();
    if (candidates.length > 1) {
      for (const item of candidates) {
        const object = await load(item);
        object.name = item.file.name.replace(/\.[^.]+$/, "");
        object.traverse(node => { if (node instanceof THREE.Mesh && !node.name) node.name = object.name; });
        root.add(object);
      }
      warnings.push("Files retain their source coordinates. Use co-registered meshes to preserve anatomical alignment.");
    }
    resources.own(root); checkAbort(signal);
    const stats = inspectImportedRoot(root), source = await sourceIdentity(selected.entries); checkAbort(signal);
    let disposed = false;
    const model: ImportedModel = { root, filename: candidates.length === 1 ? entry.file.name : `${candidates.length}-organ-scene.glb`, format: candidates.length === 1 ? format : "glb", stats, warnings, source,
      dispose() { if (disposed) return; disposed = true; resources.dispose(); root.removeFromParent(); } };
    return model;
  } catch (error) { resources.dispose(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
}

/** Export the currently displayed state, including edited geometry/materials.
 * glTF cannot carry arbitrary Blender nodes or Unity shader programs. */
export async function exportImportedModelGLB(model: ImportedModel): Promise<Blob> {
  inspectImportedRoot(model.root);
  const clone = model.root.clone(true);
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>(), materials = new Map<THREE.Material, THREE.Material>(), textures = new Map<THREE.Texture, THREE.Texture>();
  try {
    clone.traverse(node => {
      node.userData = {};
      if (!(node instanceof THREE.Mesh)) return;
      let geometry = geometries.get(node.geometry);
      if (!geometry) { geometry = node.geometry.clone(); geometry!.userData = {}; geometries.set(node.geometry, geometry!); }
      node.geometry = geometry;
      const copyMaterial = (original: THREE.Material) => {
        let material = materials.get(original);
        if (material) return material;
        material = original.clone(); material.userData = {}; materials.set(original, material);
        for (const [key, value] of Object.entries(material)) if (value instanceof THREE.Texture) {
          let texture = textures.get(value);
          if (!texture) {
            // GLTFExporter's metallic/roughness packer uses drawImage, which
            // cannot consume DataTexture's raw {data,width,height} image.
            // Convert only the export copy; keep live GPU maps and their owner.
            if (value instanceof THREE.DataTexture) {
              const image = value.image;
              if (value.format !== THREE.RGBAFormat || value.type !== THREE.UnsignedByteType || !(image.data instanceof Uint8Array)) {
                throw new Error("GLB export requires unsigned-byte RGBA generated textures.");
              }
              const canvas = document.createElement("canvas");
              canvas.width = image.width; canvas.height = image.height;
              const context = canvas.getContext("2d");
              if (!context) throw new Error("Could not prepare the generated texture for GLB export.");
              const pixels = context.createImageData(image.width, image.height);
              pixels.data.set(image.data); context.putImageData(pixels, 0, 0);
              texture = new THREE.Texture().copy(value);
              texture.source = new THREE.Source(canvas);
            } else texture = value.clone();
            texture.userData = {}; textures.set(value, texture);
          }
          (material as unknown as Record<string, unknown>)[key] = texture;
        }
        return material;
      };
      node.material = Array.isArray(node.material) ? node.material.map(copyMaterial) : copyMaterial(node.material);
    });
    const output = await new GLTFExporter().parseAsync(clone, { binary: true, onlyVisible: false, maxTextureSize: IMPORT_LIMITS.imageSide });
    if (!(output instanceof ArrayBuffer)) throw new Error("Unexpected GLB export result.");
    if (output.byteLength > IMPORT_LIMITS.sourceBytes) throw new Error("Export exceeds the 128 MiB file budget.");
    return new Blob([output], { type: "model/gltf-binary" });
  } finally {
    geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose());
    // Texture clones share decoded image data. Only ImportedModel.dispose owns
    // those ImageBitmaps; export must never close the viewer's images.
  }
}
