// A minimal glTF 2.0 binary (GLB) writer for vertex-coloured triangle meshes: what the organ lab's "Add shape to
// Library" bake needs and nothing else (no textures, skins or animation), so the browser bundle carries no exporter.
// Every mesh becomes one node with one indexed triangle primitive: POSITION (metres), NORMAL, COLOR_0 (linear RGB, as
// glTF defines vertex colours) and its own metallic-roughness material, optionally with KHR_materials_clearcoat.
// readGlb() parses the container back (used by the tests and the development harness).

import type { JsonValue } from "../../bridge/labSession";

type JsonRecord = { [key: string]: JsonValue };

export interface GlbMaterialInput {
  name: string;
  /** Linear RGBA multiplied with COLOR_0. */
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  doubleSided: boolean;
  clearcoat?: { factor: number; roughness: number } | null | undefined;
}

export interface GlbMeshInput {
  name: string;
  /** xyz per vertex, in metres. */
  positions: Float32Array;
  /** Unit normals, xyz per vertex. */
  normals?: Float32Array | null | undefined;
  /** Linear RGB per vertex. */
  colors?: Float32Array | null | undefined;
  /** Triangle list. */
  indices: Uint32Array;
  material: GlbMaterialInput;
  extras?: JsonRecord | undefined;
}

export interface GlbInput {
  generator: string;
  sceneName: string;
  meshes: GlbMeshInput[];
  /** Stored on the scene (three.js reads it into gltf.scene.userData). */
  extras?: JsonRecord | undefined;
  copyright?: string | undefined;
}

export interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC3" | "VEC4";
  min?: number[];
  max?: number[];
  normalized?: boolean;
}
export interface GltfBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}
export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices: number;
  material: number;
  mode: number;
}
export interface GltfJson {
  asset: { version: string; generator?: string; copyright?: string };
  scene: number;
  scenes: { name?: string; nodes: number[]; extras?: JsonRecord }[];
  nodes: { name?: string; mesh?: number }[];
  meshes: { name?: string; primitives: GltfPrimitive[]; extras?: JsonRecord }[];
  materials: {
    name?: string;
    pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number };
    doubleSided?: boolean;
    extensions?: { KHR_materials_clearcoat?: { clearcoatFactor: number; clearcoatRoughnessFactor: number } };
  }[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  buffers: { byteLength: number }[];
  extensionsUsed?: string[];
}

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const GLB_JSON_CHUNK = 0x4e4f534a; // "JSON"
export const GLB_BIN_CHUNK = 0x004e4942; // "BIN\0"
export const GL_FLOAT = 5126;
export const GL_UNSIGNED_SHORT = 5123;
export const GL_UNSIGNED_INT = 5125;
export const GL_ARRAY_BUFFER = 34962;
export const GL_ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class GlbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbError";
  }
}

function clamp01(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new GlbError(`${what} is not a finite number.`);
  return Math.min(1, Math.max(0, value));
}

function littleEndianBytes(array: Float32Array | Uint16Array | Uint32Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const out = new Uint8Array(array.byteLength);
  const view = new DataView(out.buffer);
  const size = array.BYTES_PER_ELEMENT;
  for (let i = 0; i < array.length; i++) {
    if (array instanceof Float32Array) view.setFloat32(i * 4, array[i]!, true);
    else if (size === 2) view.setUint16(i * 2, array[i]!, true);
    else view.setUint32(i * 4, array[i]!, true);
  }
  return out;
}

function bounds(values: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const value = values[i + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return { min, max };
}

function checkMesh(mesh: GlbMeshInput, index: number): number {
  const what = `Mesh ${index + 1} (${mesh.name})`;
  const { positions, normals, colors, indices } = mesh;
  if (positions.length === 0 || positions.length % 3 !== 0) throw new GlbError(`${what} has no usable positions.`);
  const vertexCount = positions.length / 3;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) throw new GlbError(`${what} has a position that is not finite.`);
  if (normals && normals.length !== positions.length) throw new GlbError(`${what} has ${normals.length / 3} normals for ${vertexCount} vertices.`);
  if (normals) for (let i = 0; i < normals.length; i++) if (!Number.isFinite(normals[i]!)) throw new GlbError(`${what} has a normal that is not finite.`);
  if (colors && colors.length !== positions.length) throw new GlbError(`${what} has ${colors.length / 3} colours for ${vertexCount} vertices.`);
  if (colors) for (let i = 0; i < colors.length; i++) if (!(colors[i]! >= 0 && colors[i]! <= 1)) throw new GlbError(`${what} has a colour outside 0–1.`);
  if (indices.length === 0 || indices.length % 3 !== 0) throw new GlbError(`${what} has no triangles.`);
  for (let i = 0; i < indices.length; i++) if (indices[i]! >= vertexCount) throw new GlbError(`${what} indexes a vertex it does not have.`);
  return vertexCount;
}

/** The GLB bytes of the meshes (see the header for what is written). */
export function writeGlb(input: GlbInput): Uint8Array<ArrayBuffer> {
  if (input.meshes.length === 0) throw new GlbError("There is nothing to export.");
  const json: GltfJson = {
    asset: { version: "2.0", generator: input.generator, ...(input.copyright ? { copyright: input.copyright } : {}) },
    scene: 0,
    scenes: [{ name: input.sceneName, nodes: [], ...(input.extras ? { extras: input.extras } : {}) }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  const parts: Uint8Array[] = [];
  let length = 0;
  const addView = (bytes: Uint8Array, target: number): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target });
    parts.push(bytes);
    length += bytes.length;
    return json.bufferViews.length - 1;
  };
  const addAccessor = (accessor: GltfAccessor): number => {
    json.accessors.push(accessor);
    return json.accessors.length - 1;
  };
  let clearcoat = false;
  input.meshes.forEach((mesh, index) => {
    const vertexCount = checkMesh(mesh, index);
    const attributes: Record<string, number> = {};
    attributes.POSITION = addAccessor({
      bufferView: addView(littleEndianBytes(mesh.positions), GL_ARRAY_BUFFER), componentType: GL_FLOAT, count: vertexCount, type: "VEC3", ...bounds(mesh.positions),
    });
    if (mesh.normals) attributes.NORMAL = addAccessor({ bufferView: addView(littleEndianBytes(mesh.normals), GL_ARRAY_BUFFER), componentType: GL_FLOAT, count: vertexCount, type: "VEC3" });
    if (mesh.colors) attributes.COLOR_0 = addAccessor({ bufferView: addView(littleEndianBytes(mesh.colors), GL_ARRAY_BUFFER), componentType: GL_FLOAT, count: vertexCount, type: "VEC3" });
    // 65535 is the primitive-restart value of unsigned shorts: glTF forbids it as an index
    const short = vertexCount <= 65535;
    const indexArray = short ? Uint16Array.from(mesh.indices) : mesh.indices;
    const indices = addAccessor({ bufferView: addView(littleEndianBytes(indexArray), GL_ELEMENT_ARRAY_BUFFER), componentType: short ? GL_UNSIGNED_SHORT : GL_UNSIGNED_INT, count: mesh.indices.length, type: "SCALAR" });
    const m = mesh.material;
    const material: GltfJson["materials"][number] = {
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColorFactor.map((value, k) => clamp01(value, `${m.name} base colour ${k}`)),
        metallicFactor: clamp01(m.metallicFactor, `${m.name} metalness`),
        roughnessFactor: clamp01(m.roughnessFactor, `${m.name} roughness`),
      },
      doubleSided: m.doubleSided,
    };
    if (m.clearcoat && m.clearcoat.factor > 0) {
      clearcoat = true;
      material.extensions = { KHR_materials_clearcoat: { clearcoatFactor: clamp01(m.clearcoat.factor, `${m.name} clearcoat`), clearcoatRoughnessFactor: clamp01(m.clearcoat.roughness, `${m.name} clearcoat roughness`) } };
    }
    json.materials.push(material);
    json.meshes.push({ name: mesh.name, primitives: [{ attributes, indices, material: json.materials.length - 1, mode: TRIANGLES }], ...(mesh.extras ? { extras: mesh.extras } : {}) });
    json.nodes.push({ name: mesh.name, mesh: json.meshes.length - 1 });
    json.scenes[0]!.nodes.push(json.nodes.length - 1);
  });
  if (clearcoat) json.extensionsUsed = ["KHR_materials_clearcoat"];
  const binLength = length + ((4 - (length % 4)) % 4);
  json.buffers[0]!.byteLength = binLength;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON_CHUNK, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength); // the JSON chunk pads with spaces
  let offset = 20 + jsonLength;
  view.setUint32(offset, binLength, true);
  view.setUint32(offset + 4, GLB_BIN_CHUNK, true);
  offset += 8;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The JSON and binary chunks of a GLB, with the container checked (magic, version, lengths, chunk types). */
export function readGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new GlbError("Not a GLB file.");
  if (view.getUint32(4, true) !== 2) throw new GlbError("Not a glTF 2.0 binary.");
  if (view.getUint32(8, true) !== bytes.length) throw new GlbError("The GLB length does not match its header.");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== GLB_JSON_CHUNK || jsonLength % 4 !== 0 || 20 + jsonLength > bytes.length) throw new GlbError("The GLB has no JSON chunk.");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
  let offset = 20 + jsonLength;
  if (offset === bytes.length) return { json, bin: null };
  if (offset + 8 > bytes.length) throw new GlbError("The GLB binary chunk is truncated.");
  const binLength = view.getUint32(offset, true);
  if (view.getUint32(offset + 4, true) !== GLB_BIN_CHUNK || binLength % 4 !== 0 || offset + 8 + binLength !== bytes.length) throw new GlbError("The GLB binary chunk is malformed.");
  offset += 8;
  return { json, bin: bytes.subarray(offset, offset + binLength) };
}
