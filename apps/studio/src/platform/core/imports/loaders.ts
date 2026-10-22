// One loader per format, each returning the scene three.js built plus what the file says about itself (detection
// signals, units, up axis, notes). Cheap counts are checked against the limits before a loader allocates geometry.
// Runs in browsers; in node it works for files without texture images (three's image decoders need a DOM).

import * as THREE from "three";
import { unzipSync } from "fflate";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { USDLoader } from "three/examples/jsm/loaders/USDLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { isPlatformError } from "../types";
import { latin1Text, readU32, toArrayBuffer, utf8Text } from "./bytes";
import type { SourceSignals } from "./detect";
import { ADVICE, errorMessage, importRefusal, throwIfAborted, untilAborted, type ImportRejectedError } from "./errors";
import { fbxUnits, readFbxHeader } from "./fbx";
import {
  checkGltfExtensions,
  dropTextureReferences,
  glbImageBytes,
  inspectGltf,
  readGltf,
  texturesUsingImages,
  writeGlb,
} from "./gltf";
import { imageKind, imageSize } from "./images";
import { IMPORT_LIMITS, formatCount, type ImportBudget } from "./limits";
import { basename, dirname, isLocalUrl, isRemoteReference, type FileEntry, type FileSet } from "./paths";
import type { ImportResources } from "./resources";
import type { ModelFormat } from "./sniff";
import { LoadContext, stripEmptyTextures } from "./textures";
import { readUsdLayerMeta } from "./usd";
import { checkZipEntries, firstEntryName, listZip, rezip } from "./zip";

export interface LoadedModel {
  format: ModelFormat;
  /** The scene as the loader built it (FBX and USD loaders already turn Z-up files upright). */
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  notes: string[];
  units: string | undefined;
  upAxis: "Y" | "Z" | undefined;
  /** Rotation about X that stands the model upright in a Y-up viewer (formats whose loader leaves axes alone). */
  uprightX: number;
  /** Factor from file units to metres for the preview GLB, when the unit is known. */
  toMetres: number | null;
  /** Detection inputs read from the file. */
  signals: SourceSignals;
  /** A title written in the file (Sketchfab's asset.extras.title, FBX SceneInfo title). */
  title: string | null;
}

export interface LoadInput {
  main: FileEntry;
  format: ModelFormat;
  files: FileSet;
  resources: ImportResources;
  budget: ImportBudget;
  signal?: AbortSignal | undefined;
}

export async function loadModel(input: LoadInput): Promise<LoadedModel> {
  throwIfAborted(input.signal);
  switch (input.format) {
    case "glb":
    case "gltf":
      return loadGltf(input);
    case "fbx":
      return loadFbx(input);
    case "obj":
      return loadObj(input);
    case "stl":
      return loadStl(input);
    case "ply":
      return loadPly(input);
    case "usdz":
      return loadUsdz(input);
  }
}

function checkCounts(label: string, vertices: number, triangles: number): void {
  if (vertices > IMPORT_LIMITS.vertices) {
    throw importRefusal(`${label} has ${formatCount(vertices)} vertices; imports are limited to ${formatCount(IMPORT_LIMITS.vertices)}.`, "limit:vertices", {
      code: "limit_reached",
      advice: ADVICE.decimate,
    });
  }
  if (triangles > IMPORT_LIMITS.triangles) {
    throw importRefusal(`${label} has ${formatCount(triangles)} triangles; imports are limited to ${formatCount(IMPORT_LIMITS.triangles)}.`, "limit:triangles", {
      code: "limit_reached",
      advice: ADVICE.decimate,
    });
  }
}

function checkImage(label: string, bytes: Uint8Array | null, name: string): void {
  if (!bytes) return;
  const size = imageSize(bytes.subarray(0, 65536), imageKind(bytes.subarray(0, 64), name.split(".").pop() ?? ""));
  if (size && Math.max(size.width, size.height) > IMPORT_LIMITS.imageSide) {
    throw importRefusal(
      `${label} has a ${size.width}×${size.height} texture (${name}); textures are limited to ${IMPORT_LIMITS.imageSide} pixels per side.`,
      "limit:image-size",
      { code: "limit_reached", advice: ADVICE.resizeTextures },
    );
  }
}

const USDZ_ADVICE = "Export it again as USDZ, or as GLB.";

function loadFailed(label: string, error: unknown): ImportRejectedError {
  return importRefusal(`${label} could not be read (${errorMessage(error)}).`, "load-failed", {
    advice: "The file may be damaged or use features the browser can't read. Export it again, preferably as GLB.",
    cause: error,
  });
}

/** A mid-grey clay for models without materials (STL, PLY, bare OBJ and FBX), readable on light and dark backgrounds. */
function neutralMaterial(vertexColors: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : 0x9aa1a9,
    roughness: 0.55,
    metalness: 0,
    vertexColors,
    side: THREE.DoubleSide,
  });
}

/**
 * Swaps a loader's placeholder materials (OBJ without a material library, FBX meshes without materials) for the
 * neutral clay, keeping flat shading and vertex colours, so untextured models look alike whatever their format.
 */
function useNeutralMaterials(root: THREE.Object3D, isPlaceholder: (material: THREE.MeshPhongMaterial) => boolean): void {
  const replaced = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const swap = (material: THREE.Material): THREE.Material => {
    if (!(material instanceof THREE.MeshPhongMaterial) || !isPlaceholder(material)) return material;
    let clay = replaced.get(material);
    if (!clay) {
      clay = neutralMaterial(material.vertexColors);
      clay.name = material.name === THREE.Loader.DEFAULT_MATERIAL_NAME ? "" : material.name;
      clay.flatShading = material.flatShading;
      replaced.set(material, clay);
    }
    return clay;
  };
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
  });
  for (const placeholder of replaced.keys()) placeholder.dispose();
}

// glTF / GLB -----------------------------------------------------------------------------------------------------------

async function loadGltf({ main, format, files, resources, signal }: LoadInput): Promise<LoadedModel> {
  const label = basename(main.path);
  const { json, bin } = readGltf(main.bytes, format === "glb", label);
  const facts = inspectGltf(json);
  const notes = checkGltfExtensions(facts, label);
  checkCounts(label, facts.vertices, facts.triangles);
  const baseDir = dirname(main.path);

  for (const uri of facts.bufferUris) {
    if (isRemoteReference(uri)) {
      throw importRefusal(`${label} loads its geometry from the web (${uri}).`, "gltf-remote-buffer", {
        advice: "Download that file and import it together with the .gltf.",
      });
    }
    if (!isLocalUrl(uri) && !files.resolve(uri, baseDir)) {
      throw importRefusal(`${label} needs ${basename(uri.replace(/\\/g, "/"))}, which wasn't selected.`, "gltf-missing-buffer", {
        advice: "Select it together with the .gltf, or drop the whole folder or a .zip.",
      });
    }
  }

  // Images: refuse oversized ones before decoding; leave out the missing ones (and say so).
  const images = Array.isArray(json.images) ? json.images : [];
  const missingImages = new Set<number>();
  const missingNames: string[] = [];
  images.forEach((image, index) => {
    const uri = typeof image === "object" && image !== null && !Array.isArray(image) && typeof image.uri === "string" ? image.uri : null;
    if (uri === null) {
      checkImage(label, glbImageBytes(json, bin, index), `image ${index}`);
      return;
    }
    if (/^data:/i.test(uri)) return;
    const entry = isRemoteReference(uri) ? undefined : files.resolve(uri, baseDir);
    if (!entry) {
      missingImages.add(index);
      missingNames.push(basename(uri.replace(/\\/g, "/")));
      return;
    }
    checkImage(label, entry.bytes, basename(entry.path));
  });
  let data: ArrayBuffer | string;
  if (missingImages.size > 0) {
    dropTextureReferences(json, texturesUsingImages(json, missingImages));
    notes.push(`Textures referenced but not included, so the preview leaves them out: ${missingNames.slice(0, 6).join(", ")}${missingNames.length > 6 ? ` and ${missingNames.length - 6} more` : ""}.`);
    data = format === "glb" ? toArrayBuffer(writeGlb(json, bin)) : JSON.stringify(json);
  } else {
    data = format === "glb" ? toArrayBuffer(main.bytes) : utf8Text(main.bytes);
  }

  const context = new LoadContext({ files, baseDir, resources });
  const loader = new GLTFLoader(context.manager).setMeshoptDecoder(MeshoptDecoder);
  let gltf: GLTF;
  try {
    gltf = await untilAborted(loader.parseAsync(data, ""), signal);
  } catch (error) {
    if (isPlatformError(error, "aborted")) throw error;
    throw loadFailed(label, error);
  }
  for (const scene of gltf.scenes) resources.trackObject(scene);
  await context.idle(signal);
  notes.push(...context.notes());
  const root = gltf.scene ?? gltf.scenes[0];
  if (!root) throw importRefusal(`${label} has no scene to show.`, "empty-scene", { advice: ADVICE.emptyScene });
  if (gltf.scenes.length > 1) notes.push(`The file has ${gltf.scenes.length} scenes; the preview shows the default one.`);
  return {
    format,
    root,
    animations: gltf.animations,
    notes,
    units: "m",
    upAxis: "Y",
    uprightX: 0,
    toMetres: 1,
    signals: { gltf: facts },
    title: facts.extras.title,
  };
}

// FBX ------------------------------------------------------------------------------------------------------------------

const UNITY_FBX_TITLE = /^created by fbx exporter from unity technologies$/i;

async function loadFbx({ main, files, resources, signal }: LoadInput): Promise<LoadedModel> {
  const label = basename(main.path);
  const header = readFbxHeader(main.bytes);
  const context = new LoadContext({ files, baseDir: dirname(main.path), resources });
  context.installTextureHandler();
  let group: THREE.Group;
  try {
    group = new FBXLoader(context.manager).parse(toArrayBuffer(main.bytes), "");
  } catch (error) {
    throw loadFailed(label, error);
  }
  useNeutralMaterials(group, (material) => material.name === THREE.Loader.DEFAULT_MATERIAL_NAME);
  resources.trackObject(group);
  await context.idle(signal);
  stripEmptyTextures(group);
  const notes = context.notes();
  const upAxis = header.upAxis === 2 ? "Z" : header.upAxis === 1 ? "Y" : undefined;
  const title = header.title && !UNITY_FBX_TITLE.test(header.title) ? header.title : null;
  return {
    format: "fbx",
    root: group,
    animations: group.animations,
    notes,
    units: fbxUnits(header.unitScaleFactor) ?? "cm",
    upAxis,
    uprightX: 0,
    // FBX units are centimetres unless GlobalSettings says otherwise.
    toMetres: (header.unitScaleFactor ?? 1) / 100,
    signals: { fbx: header },
    title,
  };
}

// OBJ + MTL ------------------------------------------------------------------------------------------------------------

const OBJ_UNITS: Record<string, string> = { centimeters: "cm", millimeters: "mm", meters: "m", inches: "in", feet: "ft" };
const UNIT_METRES: Record<string, number> = { cm: 0.01, mm: 0.001, m: 1, in: 0.0254, ft: 0.3048 };
const MTL_MAPS = ["map_kd", "map_ks", "map_ke", "norm", "map_bump", "bump", "map_d"] as const;

/** A path that, appended to "/<dir>/", normalises to `path` (used for MTL references from another folder). */
function relativeFrom(dir: string, path: string): string {
  return `${"../".repeat(dir.split("/").length)}${path}`;
}

/** Vertex records and triangles of an OBJ text, counted without allocating per line. */
export function countObj(text: string): { vertices: number; triangles: number; libraries: string[] } {
  let vertices = 0;
  let triangles = 0;
  const libraries: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const first = text.charCodeAt(at);
    if (first === 118 /* v */) {
      const next = text.charCodeAt(at + 1);
      if (next === 32 || next === 9) vertices++;
    } else if (first === 102 /* f */) {
      const line = text.slice(at + 1, end).trim();
      const corners = line ? line.split(/\s+/).length : 0;
      if (corners >= 3) triangles += corners - 2;
    } else if (first === 109 /* m */ && text.startsWith("mtllib", at)) {
      const value = text.slice(at + 6, end).trim();
      if (value) libraries.push(value);
    }
    at = end + 1;
  }
  return { vertices, triangles, libraries };
}

async function loadObj({ main, files, resources, signal }: LoadInput): Promise<LoadedModel> {
  const label = basename(main.path);
  const text = utf8Text(main.bytes);
  const counts = countObj(text);
  checkCounts(label, counts.vertices, counts.triangles);
  const baseDir = dirname(main.path);
  const notes: string[] = [];
  const context = new LoadContext({ files, baseDir, resources });
  context.installTextureHandler();

  // Material libraries: a name with spaces may be one file or several, so try the whole value first.
  const libraryEntries: FileEntry[] = [];
  const missingLibraries: string[] = [];
  for (const value of counts.libraries) {
    const whole = files.resolve(value, baseDir);
    if (whole) {
      libraryEntries.push(whole);
      continue;
    }
    const parts = value.split(/\s+/).map((part) => ({ part, entry: files.resolve(part, baseDir) }));
    if (parts.every((item) => !item.entry)) {
      missingLibraries.push(basename(value.replace(/\\/g, "/")));
      continue;
    }
    for (const { part, entry } of parts) {
      if (entry) libraryEntries.push(entry);
      else missingLibraries.push(basename(part.replace(/\\/g, "/")));
    }
  }
  if (missingLibraries.length > 0) notes.push(`Material libraries not included, so neutral materials are shown: ${missingLibraries.join(", ")}.`);

  const loader = new OBJLoader(context.manager);
  const unique = [...new Set(libraryEntries)];
  if (unique.length > 0) {
    const first = unique[0]!;
    const mtlDir = dirname(first.path);
    // A leading "/" makes the texture references selection-root-relative for FileSet.resolve (see paths.ts).
    const creator = new MTLLoader(context.manager).parse(utf8Text(first.bytes), mtlDir ? `/${mtlDir}/` : "/");
    const infos = { ...creator.materialsInfo };
    const infoDirs = new Map<object, string>();
    for (const info of Object.values(infos)) infoDirs.set(info, mtlDir);
    for (const extra of unique.slice(1)) {
      const parsed = new MTLLoader(context.manager).parse(utf8Text(extra.bytes), "");
      for (const [name, info] of Object.entries(parsed.materialsInfo)) {
        if (name in infos) continue;
        infos[name] = info;
        infoDirs.set(info, dirname(extra.path));
      }
    }
    const missingMaps = new Set<string>();
    let displacement = false;
    for (const info of Object.values(infos)) {
      if (info.disp) {
        delete info.disp;
        displacement = true;
      }
      const dir = infoDirs.get(info) ?? mtlDir;
      for (const key of MTL_MAPS) {
        const value = info[key];
        if (!value) continue;
        const url = creator.getTextureParams(value, {}).url;
        const entry = isRemoteReference(url) ? undefined : files.resolve(url, dir);
        if (!entry) {
          missingMaps.add(basename(url.replace(/\\/g, "/")));
          delete info[key];
        } else if (dir !== mtlDir) {
          // Libraries in other folders: point the reference at the resolved file from the first library's folder.
          info[key] = value.slice(0, value.length - url.length) + (mtlDir ? relativeFrom(mtlDir, entry.path) : entry.path);
        }
      }
    }
    creator.setMaterials(infos);
    if (missingMaps.size > 0) notes.push(`Textures referenced but not included, so the preview leaves them out: ${[...missingMaps].slice(0, 6).join(", ")}.`);
    if (displacement) notes.push("Displacement maps from the MTL file are not applied in the preview.");
    try {
      creator.preload();
    } catch (error) {
      throw importRefusal(`The materials of ${label} could not be read (${errorMessage(error)}).`, "load-failed", { advice: "Import the model without its .mtl file, or export it again.", cause: error });
    }
    for (const material of Object.values(creator.materials)) resources.trackMaterial(material);
    loader.setMaterials(creator);
  }

  let group: THREE.Group;
  try {
    group = loader.parse(text);
  } catch (error) {
    throw loadFailed(label, error);
  }
  if (unique.length === 0) useNeutralMaterials(group, () => true);
  resources.trackObject(group);
  await context.idle(signal);
  stripEmptyTextures(group);
  notes.push(...context.notes());
  const unitWord = /uses\s+(centimeters|millimeters|meters|inches|feet)\s+as\s+units/i.exec(text.slice(0, 4096))?.[1]?.toLowerCase();
  const units = unitWord ? OBJ_UNITS[unitWord] : undefined;
  return {
    format: "obj",
    root: group,
    animations: [],
    notes,
    units,
    upAxis: undefined,
    uprightX: 0,
    toMetres: units ? (UNIT_METRES[units] ?? null) : null,
    signals: { obj: text.slice(0, IMPORT_LIMITS.sniffBytes) },
    title: null,
  };
}

// STL ------------------------------------------------------------------------------------------------------------------

function hasDegenerateNormals(geometry: THREE.BufferGeometry): boolean {
  const normals = geometry.getAttribute("normal");
  if (!normals) return true;
  for (let i = 0; i < normals.count; i++) {
    if (Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) < 0.5) return true;
  }
  return false;
}

async function loadStl({ main, resources }: LoadInput): Promise<LoadedModel> {
  const label = basename(main.path);
  const bytes = main.bytes;
  const binary = bytes.length >= 84 && 84 + 50 * readU32(bytes, 80) === bytes.length;
  let triangles: number;
  let header: string;
  if (binary) {
    triangles = readU32(bytes, 80);
    header = latin1Text(bytes, 0, 80).replace(/\0+/g, " ");
  } else {
    const text = utf8Text(bytes);
    triangles = 0;
    for (let at = text.indexOf("endfacet"); at >= 0; at = text.indexOf("endfacet", at + 8)) triangles++;
    const lineEnd = text.indexOf("\n");
    header = (lineEnd >= 0 ? text.slice(0, lineEnd) : text.slice(0, 80)).trim();
  }
  // Distinct vertices are counted after loading; the triangle count is known now.
  checkCounts(label, 0, triangles);
  let geometry: THREE.BufferGeometry;
  try {
    geometry = new STLLoader().parse(toArrayBuffer(bytes));
  } catch (error) {
    throw loadFailed(label, error);
  }
  // Many exporters write zero facet normals, which would render black; recompute flat normals then.
  if (hasDegenerateNormals(geometry)) geometry.computeVertexNormals();
  const colored = geometry.hasAttribute("color");
  const material = neutralMaterial(colored);
  const stlAlpha = (geometry as THREE.BufferGeometry & { alpha?: number }).alpha;
  if (colored && typeof stlAlpha === "number" && stlAlpha < 1) {
    material.opacity = stlAlpha;
    material.transparent = true;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = basename(main.path);
  const root = new THREE.Group();
  root.add(mesh);
  resources.trackObject(root);
  return {
    format: "stl",
    root,
    animations: [],
    notes: ["STL holds only triangles: no units, materials or textures. It is shown with a neutral surface, Z axis up (the usual 3D-printing convention)."],
    units: undefined,
    upAxis: "Z",
    uprightX: -Math.PI / 2,
    toMetres: null,
    signals: { stl: { header, binary } },
    title: null,
  };
}

// PLY ------------------------------------------------------------------------------------------------------------------

export function plyHeader(bytes: Uint8Array): { text: string; vertices: number; faces: number } {
  const head = latin1Text(bytes, 0, Math.min(bytes.length, 65536));
  const end = head.indexOf("end_header");
  const text = end >= 0 ? head.slice(0, end) : head;
  const vertices = Number(/^element\s+vertex\s+(\d+)/m.exec(text)?.[1] ?? 0);
  const faces = Number(/^element\s+face\s+(\d+)/m.exec(text)?.[1] ?? 0);
  return { text, vertices, faces };
}

async function loadPly({ main, resources }: LoadInput): Promise<LoadedModel> {
  const label = basename(main.path);
  const header = plyHeader(main.bytes);
  checkCounts(label, header.vertices, header.faces);
  let geometry: THREE.BufferGeometry;
  try {
    geometry = new PLYLoader().parse(toArrayBuffer(main.bytes));
  } catch (error) {
    throw loadFailed(label, error);
  }
  const colored = geometry.hasAttribute("color");
  const notes: string[] = [];
  const root = new THREE.Group();
  if (geometry.index === null && header.faces === 0) {
    geometry.computeBoundingSphere();
    const radius = geometry.boundingSphere?.radius || 1;
    const count = Math.max(1, geometry.getAttribute("position")?.count ?? 1);
    // About the spacing of points spread over the cloud's extent: dense scans stay crisp, sparse ones stay visible.
    const size = Math.min(radius / 30, Math.max(radius / 1000, (3 * radius) / Math.sqrt(count)));
    const material = new THREE.PointsMaterial({ size, sizeAttenuation: true, vertexColors: colored, color: colored ? 0xffffff : 0x6f7780 });
    const points = new THREE.Points(geometry, material);
    points.name = label;
    root.add(points);
    notes.push(`Point cloud: ${formatCount(geometry.getAttribute("position")?.count ?? 0)} points and no faces.`);
  } else {
    if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, neutralMaterial(colored));
    mesh.name = label;
    root.add(mesh);
  }
  resources.trackObject(root);
  const texture = /^comment\s+TextureFile\s+(.+)$/im.exec(header.text)?.[1]?.trim();
  if (texture) notes.push(`The PLY names a texture (${texture}) that the preview doesn't apply.`);
  return {
    format: "ply",
    root,
    animations: [],
    notes,
    units: undefined,
    upAxis: undefined,
    uprightX: 0,
    toMetres: null,
    signals: { ply: header.text },
    title: null,
  };
}

// USDZ -----------------------------------------------------------------------------------------------------------------

type UsdParse = (buffer: ArrayBuffer, path: string, onLoad: (group: THREE.Group) => void, onError: (error: unknown) => void) => THREE.Group;

async function loadUsdz({ main, files, resources, budget, signal }: LoadInput): Promise<LoadedModel> {
  const label = basename(main.path);
  const listing = listZip(main.bytes, label);
  checkZipEntries(listing, budget, label);
  const rootName = firstEntryName(main.bytes);
  if (!rootName) throw importRefusal(`${label} is not a valid USDZ package (no root layer).`, "damaged:usdz", { advice: USDZ_ADVICE });
  let rootBytes: Uint8Array | undefined;
  try {
    rootBytes = unzipSync(main.bytes, { filter: (file) => file.name === rootName })[rootName];
  } catch (error) {
    throw importRefusal(`${label} could not be unpacked (${errorMessage(error)}).`, "zip-corrupt", { advice: USDZ_ADVICE, cause: error });
  }
  if (!rootBytes) throw importRefusal(`${label} is not a valid USDZ package (no root layer).`, "damaged:usdz", { advice: USDZ_ADVICE });
  const meta = readUsdLayerMeta(rootBytes);

  // A root layer inside a folder makes three's composer treat unresolved textures as web URLs; lift the folder to the
  // top so every texture is looked up inside the package only.
  let packageBytes = main.bytes;
  if (rootName.includes("/")) {
    const folder = `${dirname(rootName)}/`;
    const all = unzipSync(main.bytes);
    const entries = Object.entries(all)
      .filter(([name]) => !name.endsWith("/"))
      .map(([name, bytes]) => ({ name: name.startsWith(folder) ? name.slice(folder.length) : name, bytes }));
    entries.sort((a, b) => (a.name === basename(rootName) ? -1 : b.name === basename(rootName) ? 1 : 0));
    packageBytes = rezip(entries);
  }

  const context = new LoadContext({ files, baseDir: dirname(main.path), resources, unresolved: "keep" });
  const loader = new USDLoader(context.manager);
  const parse = (loader.parse as unknown as UsdParse).bind(loader);
  let group: THREE.Group;
  try {
    const loaded = new Promise<THREE.Group>((resolve, reject) => {
      try {
        parse(toArrayBuffer(packageBytes), "", resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
    group = await untilAborted(loaded, signal);
  } catch (error) {
    if (isPlatformError(error, "aborted")) throw error;
    throw loadFailed(label, error);
  }
  resources.trackObject(group);
  await context.idle(signal);
  stripEmptyTextures(group);
  const notes = context.notes();
  if (meta.error) notes.push(`The USD layer metadata could not be read (${meta.error}).`);
  return {
    format: "usdz",
    root: group,
    animations: group.animations,
    notes,
    // The loader scales by an authored metersPerUnit; without one USD means centimetres and nothing is scaled.
    units: meta.metersPerUnit !== null ? "m" : "cm",
    upAxis: meta.upAxis ?? "Y",
    uprightX: 0,
    toMetres: meta.metersPerUnit !== null ? 1 : 0.01,
    signals: { usd: meta },
    title: null,
  };
}
