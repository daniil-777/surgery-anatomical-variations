// Synthetic 3D files for the import tests, generated in code so every rule can be exercised with exact bytes:
// GLB/glTF with a chosen generator, binary and text FBX with chosen header fields (and optionally a mesh FBXLoader can
// read), STL, PLY, OBJ/MTL, USDZ packages and zips. Independent of the product code on purpose (its own GLB and FBX
// writers), so readers are checked against a second implementation.

import { zipSync, type Zippable } from "fflate";

export type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

const encoder = new TextEncoder();

export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fileOf(bytes: Uint8Array | string, name: string, relativePath?: string): File {
  const data = typeof bytes === "string" ? bytesOf(bytes) : bytes;
  const file = new File([data as Uint8Array<ArrayBuffer>], name);
  if (relativePath) Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// glTF -----------------------------------------------------------------------------------------------------------------

/** A unit cube (8 vertices, 12 triangles) as float32 positions and uint16 indices. */
export function cubeBuffers(size = 1): { positions: Float32Array; indices: Uint16Array } {
  const h = size / 2;
  const positions = new Float32Array([-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices };
}

export interface GltfOptions {
  generator?: string;
  copyright?: string;
  extras?: { [key: string]: JsonLike };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  /** External buffer URI (".gltf" with a .bin) instead of the GLB chunk / data URI. */
  bufferUri?: string;
  /** Adds a material with a base-colour texture whose image has this URI. */
  imageUri?: string;
  size?: number;
}

/** glTF JSON + binary payload for a cube. */
export function cubeGltf(options: GltfOptions = {}): { json: { [key: string]: JsonLike }; bin: Uint8Array } {
  const { positions, indices } = cubeBuffers(options.size ?? 1);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength + ((4 - (indices.byteLength % 4)) % 4));
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const h = (options.size ?? 1) / 2;
  const asset: { [key: string]: JsonLike } = { version: "2.0" };
  if (options.generator !== undefined) asset.generator = options.generator;
  if (options.copyright !== undefined) asset.copyright = options.copyright;
  if (options.extras !== undefined) asset.extras = options.extras;
  const buffer: { [key: string]: JsonLike } = { byteLength: bin.byteLength };
  if (options.bufferUri) buffer.uri = options.bufferUri;
  const json: { [key: string]: JsonLike } = {
    asset,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Cube" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, ...(options.imageUri ? { material: 0 } : {}) }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-h, -h, -h], max: [h, h, h] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    buffers: [buffer],
  };
  if (options.imageUri) {
    json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }, name: "Painted" }];
    json.textures = [{ source: 0 }];
    json.images = [{ uri: options.imageUri }];
  }
  if (options.extensionsUsed) json.extensionsUsed = options.extensionsUsed;
  if (options.extensionsRequired) json.extensionsRequired = options.extensionsRequired;
  return { json, bin };
}

/** A GLB container (own writer, independent of gltf.ts). */
export function glbOf(json: JsonLike, bin: Uint8Array | null): Uint8Array {
  const jsonBytes = bytesOf(JSON.stringify(json));
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  jsonPadded.set(jsonBytes);
  const binPadded = bin ? new Uint8Array(Math.ceil(bin.length / 4) * 4) : null;
  if (bin && binPadded) binPadded.set(bin);
  const chunk = (type: number, data: Uint8Array) => {
    const head = new Uint8Array(8);
    const view = new DataView(head.buffer);
    view.setUint32(0, data.length, true);
    view.setUint32(4, type, true);
    return concat([head, data]);
  };
  const body = concat([chunk(0x4e4f534a, jsonPadded), ...(binPadded ? [chunk(0x004e4942, binPadded)] : [])]);
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 12 + body.length, true);
  return concat([header, body]);
}

export function cubeGlb(options: GltfOptions = {}): Uint8Array {
  const { json, bin } = cubeGltf(options);
  return glbOf(json, bin);
}

/** A self-contained .gltf with the buffer as a data: URI. */
export function cubeGltfEmbedded(options: GltfOptions = {}): string {
  const { json, bin } = cubeGltf(options);
  const buffers = json.buffers as Array<{ [key: string]: JsonLike }>;
  buffers[0]!.uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}`;
  return JSON.stringify(json);
}

// FBX ------------------------------------------------------------------------------------------------------------------

type FbxProperty = { type: "S"; value: string } | { type: "I"; value: number } | { type: "D"; value: number } | { type: "L"; value: number } | { type: "d"; value: number[] } | { type: "i"; value: number[] };

interface FbxRecord {
  name: string;
  properties: FbxProperty[];
  children: FbxRecord[];
}

const S = (value: string): FbxProperty => ({ type: "S", value });
const I = (value: number): FbxProperty => ({ type: "I", value });
const D = (value: number): FbxProperty => ({ type: "D", value });
const L = (value: number): FbxProperty => ({ type: "L", value });

function record(name: string, properties: FbxProperty[] = [], children: FbxRecord[] = []): FbxRecord {
  return { name, properties, children };
}

function encodeProperty(property: FbxProperty): Uint8Array {
  switch (property.type) {
    case "S": {
      const text = bytesOf(property.value);
      const out = new Uint8Array(5 + text.length);
      out[0] = 0x53;
      new DataView(out.buffer).setUint32(1, text.length, true);
      out.set(text, 5);
      return out;
    }
    case "I": {
      const out = new Uint8Array(5);
      out[0] = 0x49;
      new DataView(out.buffer).setInt32(1, property.value, true);
      return out;
    }
    case "D": {
      const out = new Uint8Array(9);
      out[0] = 0x44;
      new DataView(out.buffer).setFloat64(1, property.value, true);
      return out;
    }
    case "L": {
      const out = new Uint8Array(9);
      out[0] = 0x4c;
      new DataView(out.buffer).setBigInt64(1, BigInt(property.value), true);
      return out;
    }
    case "d":
    case "i": {
      const width = property.type === "d" ? 8 : 4;
      const out = new Uint8Array(13 + property.value.length * width);
      const view = new DataView(out.buffer);
      out[0] = property.type.charCodeAt(0);
      view.setUint32(1, property.value.length, true);
      view.setUint32(5, 0, true);
      view.setUint32(9, property.value.length * width, true);
      property.value.forEach((value, index) => {
        if (property.type === "d") view.setFloat64(13 + index * 8, value, true);
        else view.setInt32(13 + index * 4, value, true);
      });
      return out;
    }
  }
}

function encodeRecord(node: FbxRecord, offset: number, wide: boolean): Uint8Array {
  const headerSize = wide ? 25 : 13;
  const name = bytesOf(node.name);
  const properties = concat(node.properties.map(encodeProperty));
  let at = offset + headerSize + name.length + properties.length;
  const children: Uint8Array[] = [];
  for (const child of node.children) {
    const encoded = encodeRecord(child, at, wide);
    children.push(encoded);
    at += encoded.length;
  }
  if (node.children.length > 0) {
    children.push(new Uint8Array(headerSize));
    at += headerSize;
  }
  const header = new Uint8Array(headerSize);
  const view = new DataView(header.buffer);
  if (wide) {
    view.setBigUint64(0, BigInt(at), true);
    view.setBigUint64(8, BigInt(node.properties.length), true);
    view.setBigUint64(16, BigInt(properties.length), true);
    header[24] = name.length;
  } else {
    view.setUint32(0, at, true);
    view.setUint32(4, node.properties.length, true);
    view.setUint32(8, properties.length, true);
    header[12] = name.length;
  }
  return concat([header, name, properties, ...children]);
}

export interface FbxApplicationFields {
  vendor?: string;
  name?: string;
  version?: string;
}

export interface FbxOptions {
  version?: number;
  creator?: string;
  original?: FbxApplicationFields;
  lastSaved?: FbxApplicationFields;
  nativeFile?: string;
  documentUrl?: string;
  title?: string;
  author?: string;
  upAxis?: number;
  unitScaleFactor?: number;
  /** Adds one triangle-quad mesh (4 vertices, 2 triangles) that three's FBXLoader can read. */
  mesh?: boolean;
  /** Adds a material with a diffuse texture referencing this file name. */
  textureFile?: string;
}

function sceneProperties(options: FbxOptions): FbxRecord[] {
  const p = (name: string, value: string) => record("P", [S(name), S("KString"), S(""), S(""), S(value)]);
  const props: FbxRecord[] = [];
  if (options.documentUrl !== undefined) props.push(record("P", [S("DocumentUrl"), S("KString"), S("Url"), S(""), S(options.documentUrl)]));
  for (const [prefix, fields] of [["Original", options.original], ["LastSaved", options.lastSaved]] as const) {
    if (!fields) continue;
    props.push(p(`${prefix}|ApplicationVendor`, fields.vendor ?? ""), p(`${prefix}|ApplicationName`, fields.name ?? ""), p(`${prefix}|ApplicationVersion`, fields.version ?? ""));
  }
  if (options.nativeFile !== undefined) props.push(p("Original|ApplicationNativeFile", options.nativeFile));
  return props;
}

/** A binary FBX file (7.4 with 32-bit offsets, 7.5+ with 64-bit ones). */
export function fbxBinary(options: FbxOptions = {}): Uint8Array {
  const version = options.version ?? 7400;
  const wide = version >= 7500;
  const header: FbxRecord[] = [record("FBXHeaderVersion", [I(1003)]), record("FBXVersion", [I(version)])];
  if (options.creator !== undefined) header.push(record("Creator", [S(options.creator)]));
  header.push(
    record("SceneInfo", [S("GlobalInfo\u0000\u0001SceneInfo"), S("UserData")], [
      record("Type", [S("UserData")]),
      record("Version", [I(100)]),
      record("MetaData", [], [record("Version", [I(100)]), record("Title", [S(options.title ?? "")]), record("Author", [S(options.author ?? "")])]),
      record("Properties70", [], sceneProperties(options)),
    ]),
  );
  const globals: FbxRecord[] = [];
  if (options.upAxis !== undefined) globals.push(record("P", [S("UpAxis"), S("int"), S("Integer"), S(""), I(options.upAxis)]));
  if (options.unitScaleFactor !== undefined) globals.push(record("P", [S("UnitScaleFactor"), S("double"), S("Number"), S(""), D(options.unitScaleFactor)]));
  const top: FbxRecord[] = [record("FBXHeaderExtension", [], header)];
  if (options.creator !== undefined) top.push(record("Creator", [S(options.creator)]));
  top.push(record("GlobalSettings", [], [record("Version", [I(1000)]), record("Properties70", [], globals)]));
  if (options.mesh) {
    const geometry = record("Geometry", [L(1001), S("Quad\u0000\u0001Geometry"), S("Mesh")], [
      record("Vertices", [{ type: "d", value: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0] }]),
      record("PolygonVertexIndex", [{ type: "i", value: [0, 1, ~2, 0, 2, ~3] }]),
      record("GeometryVersion", [I(124)]),
    ]);
    const model = record("Model", [L(1002), S("Quad\u0000\u0001Model"), S("Mesh")], [record("Version", [I(232)]), record("Properties70")]);
    const objects = [geometry, model];
    const connections = [record("C", [S("OO"), L(1001), L(1002)]), record("C", [S("OO"), L(1002), L(0)])];
    if (options.textureFile) {
      objects.push(
        record("Material", [L(1003), S("Paint\u0000\u0001Material"), S("")], [record("ShadingModel", [S("phong")]), record("Properties70")]),
        record("Texture", [L(1004), S("Paint\u0000\u0001Texture"), S("")], [
          record("FileName", [S(options.textureFile)]),
          record("RelativeFilename", [S(options.textureFile)]),
        ]),
        record("Video", [L(1005), S("Paint\u0000\u0001Video"), S("Clip")], [
          record("Type", [S("Clip")]),
          record("FileName", [S(options.textureFile)]),
          record("RelativeFilename", [S(options.textureFile)]),
        ]),
      );
      connections.push(
        record("C", [S("OO"), L(1003), L(1002)]),
        record("C", [S("OP"), L(1004), L(1003), S("DiffuseColor")]),
        record("C", [S("OO"), L(1005), L(1004)]),
      );
    }
    top.push(record("Objects", [], objects), record("Connections", [], connections));
  }
  const magic = concat([bytesOf("Kaydara FBX Binary  \u0000"), new Uint8Array([0x1a, 0x00])]);
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version, true);
  const parts: Uint8Array[] = [magic, versionBytes];
  let offset = 27;
  for (const node of top) {
    const encoded = encodeRecord(node, offset, wide);
    parts.push(encoded);
    offset += encoded.length;
  }
  // Null record, then the footer area FBXLoader's end-of-content test expects (at least 176 bytes).
  parts.push(new Uint8Array(wide ? 25 : 13), new Uint8Array(208));
  return concat(parts);
}

/** The header records of a text FBX (7.x syntax), up to and including GlobalSettings. */
function fbxTextHeader(options: FbxOptions): string[] {
  const version = options.version ?? 7400;
  const major = Math.floor(version / 1000);
  const minor = Math.floor((version % 1000) / 100);
  const lines: string[] = [`; FBX ${major}.${minor}.0 project file`, "; ----------------------------------------------------", "", "FBXHeaderExtension:  {", "\tFBXHeaderVersion: 1003", `\tFBXVersion: ${version}`];
  if (options.creator !== undefined) lines.push(`\tCreator: "${options.creator}"`);
  lines.push('\tSceneInfo: "SceneInfo::GlobalInfo", "UserData" {', '\t\tType: "UserData"', "\t\tVersion: 100", "\t\tMetaData:  {", "\t\t\tVersion: 100");
  lines.push(`\t\t\tTitle: "${options.title ?? ""}"`, `\t\t\tAuthor: "${options.author ?? ""}"`, "\t\t}", "\t\tProperties70:  {");
  for (const property of sceneProperties(options)) {
    const values = property.properties.map((entry) => (entry.type === "S" ? `"${entry.value}"` : String(entry.value)));
    lines.push(`\t\t\tP: ${values.join(", ")}`);
  }
  // No top-level Creator line: FBX SDK text files carry it only in the header, and three's text parser rejects it.
  lines.push("\t\t}", "\t}", "}");
  lines.push("GlobalSettings:  {", "\tVersion: 1000", "\tProperties70:  {");
  if (options.upAxis !== undefined) lines.push(`\t\tP: "UpAxis", "int", "Integer", "",${options.upAxis}`);
  if (options.unitScaleFactor !== undefined) lines.push(`\t\tP: "UnitScaleFactor", "double", "Number", "",${options.unitScaleFactor}`);
  lines.push("\t}", "}");
  return lines;
}

/** A text FBX (7.x syntax) with the same header fields. */
export function fbxText(options: FbxOptions = {}): string {
  const lines = fbxTextHeader(options);
  if (options.mesh) {
    lines.push(
      "Objects:  {",
      '\tGeometry: 1001, "Geometry::Quad", "Mesh" {',
      "\t\tVertices: *12 {",
      "\t\t\ta: 0,0,0,10,0,0,10,10,0,0,10,0",
      "\t\t} ",
      "\t\tPolygonVertexIndex: *6 {",
      "\t\t\ta: 0,1,-3,0,2,-4",
      "\t\t} ",
      "\t\tGeometryVersion: 124",
      "\t}",
      '\tModel: 1002, "Model::Quad", "Mesh" {',
      "\t\tVersion: 232",
      "\t}",
      "}",
      "Connections:  {",
      '\tC: "OO",1001,1002',
      '\tC: "OO",1002,0',
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

// STL, PLY, OBJ -------------------------------------------------------------------------------------------------------

type Triangle = [number, number, number, number, number, number, number, number, number];

export const QUAD_TRIANGLES: Triangle[] = [
  [0, 0, 0, 1, 0, 0, 1, 1, 0],
  [0, 0, 0, 1, 1, 0, 0, 1, 0],
];

/** A tetrahedron: 4 distinct vertices, 4 triangles (12 corners). */
export const TETRA_TRIANGLES: Triangle[] = [
  [0, 0, 0, 1, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 0, 1, 1, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 0, 1, 0],
];

export function stlBinary(triangles: Triangle[], header = ""): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50);
  out.set(bytesOf(header).subarray(0, 80));
  const view = new DataView(out.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    const at = 84 + index * 50 + 12;
    triangle.forEach((value, k) => view.setFloat32(at + k * 4, value, true));
  });
  return out;
}

export function stlAscii(triangles: Triangle[], name = "model"): string {
  const facets = triangles.map(
    (t) => `  facet normal 0 0 1\n    outer loop\n      vertex ${t[0]} ${t[1]} ${t[2]}\n      vertex ${t[3]} ${t[4]} ${t[5]}\n      vertex ${t[6]} ${t[7]} ${t[8]}\n    endloop\n  endfacet`,
  );
  return `solid ${name}\n${facets.join("\n")}\nendsolid ${name}\n`;
}

export function plyAscii(options: { comments?: string[]; faces?: boolean; colors?: boolean } = {}): string {
  const vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const header = ["ply", "format ascii 1.0", ...(options.comments ?? []).map((comment) => `comment ${comment}`), `element vertex ${vertices.length}`, "property float x", "property float y", "property float z"];
  if (options.colors) header.push("property uchar red", "property uchar green", "property uchar blue");
  const withFaces = options.faces ?? true;
  if (withFaces) header.push("element face 2", "property list uchar int vertex_indices");
  header.push("end_header");
  const body = vertices.map((v) => `${v.join(" ")}${options.colors ? " 255 0 0" : ""}`);
  if (withFaces) body.push("3 0 1 2", "3 0 2 3");
  return `${[...header, ...body].join("\n")}\n`;
}

export function plyBinaryLittleEndian(comments: string[] = []): Uint8Array {
  const header = bytesOf(
    `${["ply", "format binary_little_endian 1.0", ...comments.map((c) => `comment ${c}`), "element vertex 3", "property float x", "property float y", "property float z", "element face 1", "property list uchar int vertex_indices", "end_header"].join("\n")}\n`,
  );
  const body = new Uint8Array(3 * 12 + 1 + 12);
  const view = new DataView(body.buffer);
  [0, 0, 0, 2, 0, 0, 0, 2, 0].forEach((value, index) => view.setFloat32(index * 4, value, true));
  body[36] = 3;
  [0, 1, 2].forEach((value, index) => view.setInt32(37 + index * 4, value, true));
  return concat([header, body]);
}

export function objText(options: { comments?: string[]; mtllib?: string; material?: string } = {}): string {
  const lines = [...(options.comments ?? []).map((comment) => `# ${comment}`)];
  if (options.mtllib) lines.push(`mtllib ${options.mtllib}`);
  lines.push("o Quad", "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1");
  if (options.material) lines.push(`usemtl ${options.material}`);
  lines.push("f 1/1 2/2 3/3 4/4");
  return `${lines.join("\n")}\n`;
}

/** `kd` multiplies the diffuse map: keep it white for a texture shown as painted. */
export function mtlText(material: string, diffuseMap?: string, kd: [number, number, number] = [0.8, 0.2, 0.2]): string {
  return `newmtl ${material}\nKd ${kd.join(" ")}\nNs 50\n${diffuseMap ? `map_Kd ${diffuseMap}\n` : ""}`;
}

/** A 2×2 uncompressed 32-bit TGA (three's TGALoader decodes it in node). */
export function tga2x2(): Uint8Array {
  const out = new Uint8Array(18 + 16);
  out[2] = 2;
  new DataView(out.buffer).setUint16(12, 2, true);
  new DataView(out.buffer).setUint16(14, 2, true);
  out[16] = 32;
  out[17] = 8;
  out.fill(200, 18);
  return out;
}

/** The first 33 bytes of a PNG: signature + IHDR with the given size (enough for header checks). */
export function pngHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13);
  out.set(bytesOf("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  out[24] = 8;
  out[25] = 6;
  return out;
}

// USD, zip ------------------------------------------------------------------------------------------------------------

export function usdaLayer(options: { creator?: string; doc?: string; upAxis?: "Y" | "Z"; metersPerUnit?: number } = {}): string {
  const meta: string[] = [];
  if (options.creator !== undefined) meta.push("    customLayerData = {", `        string creator = "${options.creator}"`, "    }");
  meta.push('    defaultPrim = "Root"');
  if (options.doc !== undefined) meta.push(`    doc = "${options.doc}"`);
  if (options.metersPerUnit !== undefined) meta.push(`    metersPerUnit = ${options.metersPerUnit}`);
  if (options.upAxis !== undefined) meta.push(`    upAxis = "${options.upAxis}"`);
  return [
    "#usda 1.0",
    "(",
    ...meta,
    ")",
    "",
    'def Xform "Root"',
    "{",
    '    def Mesh "Quad"',
    "    {",
    "        int[] faceVertexCounts = [3, 3]",
    "        int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]",
    "        point3f[] points = [(0, 0, 0), (100, 0, 0), (100, 100, 0), (0, 100, 0)]",
    "    }",
    "}",
    "",
  ].join("\n");
}

export function zipOf(entries: Record<string, Uint8Array | string>, level: 0 | 6 = 0): Uint8Array {
  const input: Zippable = {};
  for (const [name, data] of Object.entries(entries)) {
    input[name] = [typeof data === "string" ? bytesOf(data) : data, { level, mtime: new Date(2020, 0, 1) }];
  }
  return zipSync(input);
}

/** Sets a central-directory field of every entry (flags at +8, method at +10) to show refusals. */
export function patchCentralDirectory(zip: Uint8Array, field: "flags" | "method", value: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let at = 0; at + 46 <= out.length; at++) {
    if (view.getUint32(at, true) === 0x02014b50) view.setUint16(at + (field === "flags" ? 8 : 10), value, true);
  }
  return out;
}

/** three's FileLoader reports progress with the DOM's ProgressEvent, which node lacks (a test seam only). */
export class NodeProgressEvent extends Event {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;

  constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
    super(type);
    this.lengthComputable = init.lengthComputable ?? false;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
}

/** A minimal FileReader for GLTFExporter in node (it reads its Blob output through one). */
export class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onloadend?.();
    });
  }
}

// Any triangle mesh ---------------------------------------------------------------------------------------------------
// Writers for a mesh given as arrays, used by the browser check (px-imports-check.html builds organ-like shapes with
// three.js) and by round trips through the loaders. UVs follow three.js, OBJ, FBX and USD (v up); the glTF writer
// flips them to glTF's v down. Colours are sRGB 0–1 as shown; glTF stores them linear.

export interface MeshData {
  name: string;
  /** xyz per vertex. */
  positions: Float32Array;
  /** A unit normal per vertex. */
  normals?: Float32Array | undefined;
  /** uv per vertex, v pointing up. */
  uvs?: Float32Array | undefined;
  /** sRGB colour (0–1) per vertex. */
  colors?: Float32Array | undefined;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

function padTo4(length: number): number {
  return Math.ceil(length / 4) * 4;
}

/** Shortest decimal for a float32 (no exponent for the small values these meshes hold). */
function num(value: number): string {
  return String(Number(value.toFixed(6)));
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function triangleCount(mesh: MeshData): number {
  return Math.floor(mesh.indices.length / 3);
}

function vertexOf(mesh: MeshData, index: number): [number, number, number] {
  return [mesh.positions[index * 3]!, mesh.positions[index * 3 + 1]!, mesh.positions[index * 3 + 2]!];
}

export interface MeshGltfOptions {
  generator?: string;
  copyright?: string;
  extras?: { [key: string]: JsonLike };
  /** Base-colour texture: `bytes` are stored in the binary buffer, `uri` names a separate file. */
  texture?: { mimeType: "image/png" | "image/jpeg"; bytes?: Uint8Array; uri?: string };
  baseColor?: [number, number, number, number];
  metallic?: number;
  roughness?: number;
  /** File name of a separate .bin (for .gltf output); without it the buffer is the GLB binary chunk. */
  bufferUri?: string;
}

/** glTF JSON and binary buffer for one mesh with one PBR material. */
export function meshGltf(mesh: MeshData, options: MeshGltfOptions = {}): { json: { [key: string]: JsonLike }; bin: Uint8Array } {
  const count = mesh.positions.length / 3;
  const chunks: Uint8Array[] = [];
  const bufferViews: JsonLike[] = [];
  const accessors: JsonLike[] = [];
  let offset = 0;
  const view = (bytes: Uint8Array, target?: number): number => {
    const entry: { [key: string]: JsonLike } = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
    if (target !== undefined) entry.target = target;
    bufferViews.push(entry);
    chunks.push(bytes, new Uint8Array(padTo4(bytes.length) - bytes.length));
    offset += padTo4(bytes.length);
    return bufferViews.length - 1;
  };
  const accessor = (fields: { [key: string]: JsonLike }): number => accessors.push(fields) - 1;
  const bytes = (array: Float32Array | Uint16Array | Uint32Array) => new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, mesh.positions[i * 3 + k]!);
      max[k] = Math.max(max[k]!, mesh.positions[i * 3 + k]!);
    }
  }
  const attributes: { [key: string]: JsonLike } = {};
  attributes.POSITION = accessor({ bufferView: view(bytes(mesh.positions), 34962), componentType: 5126, count, type: "VEC3", min, max });
  if (mesh.normals) attributes.NORMAL = accessor({ bufferView: view(bytes(mesh.normals), 34962), componentType: 5126, count, type: "VEC3" });
  if (mesh.uvs) {
    const flipped = Float32Array.from(mesh.uvs, (value, index) => (index % 2 === 1 ? 1 - value : value));
    attributes.TEXCOORD_0 = accessor({ bufferView: view(bytes(flipped), 34962), componentType: 5126, count, type: "VEC2" });
  }
  if (mesh.colors) {
    const linear = Float32Array.from(mesh.colors, srgbToLinear);
    attributes.COLOR_0 = accessor({ bufferView: view(bytes(linear), 34962), componentType: 5126, count, type: "VEC3" });
  }
  const wide = count > 65535;
  const indexData = wide ? Uint32Array.from(mesh.indices) : Uint16Array.from(mesh.indices);
  const indices = accessor({ bufferView: view(bytes(indexData), 34963), componentType: wide ? 5125 : 5123, count: mesh.indices.length, type: "SCALAR" });

  const pbr: { [key: string]: JsonLike } = {
    baseColorFactor: options.baseColor ?? [1, 1, 1, 1],
    metallicFactor: options.metallic ?? 0,
    roughnessFactor: options.roughness ?? 0.6,
  };
  const json: { [key: string]: JsonLike } = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ name: "Scene", nodes: [0] }],
    nodes: [{ mesh: 0, name: mesh.name }],
    meshes: [{ name: mesh.name, primitives: [{ attributes, indices, material: 0 }] }],
    materials: [{ name: `${mesh.name} material`, pbrMetallicRoughness: pbr }],
    accessors,
    bufferViews,
  };
  if (options.texture) {
    const image: { [key: string]: JsonLike } = { mimeType: options.texture.mimeType };
    if (options.texture.bytes) image.bufferView = view(options.texture.bytes);
    else image.uri = options.texture.uri ?? "texture.png";
    json.images = [image];
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    json.textures = [{ source: 0, sampler: 0 }];
    pbr.baseColorTexture = { index: 0 };
  }
  const asset = json.asset as { [key: string]: JsonLike };
  if (options.generator !== undefined) asset.generator = options.generator;
  if (options.copyright !== undefined) asset.copyright = options.copyright;
  if (options.extras !== undefined) asset.extras = options.extras;
  const bin = concat(chunks);
  const buffer: { [key: string]: JsonLike } = { byteLength: bin.length };
  if (options.bufferUri) buffer.uri = options.bufferUri;
  json.buffers = [buffer];
  return { json, bin };
}

export function meshGlb(mesh: MeshData, options: Omit<MeshGltfOptions, "bufferUri"> = {}): Uint8Array {
  const { json, bin } = meshGltf(mesh, options);
  return glbOf(json, bin);
}

/** OBJ text: v (with vertex colours when given), vt, vn and f records sharing one index per corner. */
export function meshObj(mesh: MeshData, options: { comments?: string[]; mtllib?: string; material?: string } = {}): string {
  const lines = (options.comments ?? []).map((comment) => `# ${comment}`);
  if (options.mtllib) lines.push(`mtllib ${options.mtllib}`);
  lines.push(`o ${mesh.name}`);
  const count = mesh.positions.length / 3;
  for (let i = 0; i < count; i++) {
    const [x, y, z] = vertexOf(mesh, i);
    const color = mesh.colors ? ` ${num(mesh.colors[i * 3]!)} ${num(mesh.colors[i * 3 + 1]!)} ${num(mesh.colors[i * 3 + 2]!)}` : "";
    lines.push(`v ${num(x)} ${num(y)} ${num(z)}${color}`);
  }
  if (mesh.uvs) for (let i = 0; i < count; i++) lines.push(`vt ${num(mesh.uvs[i * 2]!)} ${num(mesh.uvs[i * 2 + 1]!)}`);
  if (mesh.normals) for (let i = 0; i < count; i++) lines.push(`vn ${num(mesh.normals[i * 3]!)} ${num(mesh.normals[i * 3 + 1]!)} ${num(mesh.normals[i * 3 + 2]!)}`);
  if (options.material) lines.push(`usemtl ${options.material}`);
  lines.push("s 1");
  const corner = (index: number) => {
    const k = index + 1;
    if (mesh.uvs && mesh.normals) return `${k}/${k}/${k}`;
    if (mesh.uvs) return `${k}/${k}`;
    if (mesh.normals) return `${k}//${k}`;
    return String(k);
  };
  for (let t = 0; t < triangleCount(mesh); t++) {
    lines.push(`f ${corner(mesh.indices[t * 3]!)} ${corner(mesh.indices[t * 3 + 1]!)} ${corner(mesh.indices[t * 3 + 2]!)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Binary STL with facet normals from the triangle winding. */
export function meshStl(mesh: MeshData, header = ""): Uint8Array {
  const triangles = triangleCount(mesh);
  const out = new Uint8Array(84 + triangles * 50);
  out.set(bytesOf(header).subarray(0, 80));
  const view = new DataView(out.buffer);
  view.setUint32(80, triangles, true);
  for (let t = 0; t < triangles; t++) {
    const a = vertexOf(mesh, mesh.indices[t * 3]!);
    const b = vertexOf(mesh, mesh.indices[t * 3 + 1]!);
    const c = vertexOf(mesh, mesh.indices[t * 3 + 2]!);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    const at = 84 + t * 50;
    [...n.map((value) => value / length), ...a, ...b, ...c].forEach((value, k) => view.setFloat32(at + k * 4, value, true));
  }
  return out;
}

/** ASCII PLY: positions, normals and 8-bit colours when given, triangle faces. */
export function meshPly(mesh: MeshData, options: { comments?: string[] } = {}): string {
  const count = mesh.positions.length / 3;
  const header = ["ply", "format ascii 1.0", ...(options.comments ?? []).map((comment) => `comment ${comment}`), `element vertex ${count}`, "property float x", "property float y", "property float z"];
  if (mesh.normals) header.push("property float nx", "property float ny", "property float nz");
  if (mesh.colors) header.push("property uchar red", "property uchar green", "property uchar blue");
  header.push(`element face ${triangleCount(mesh)}`, "property list uchar int vertex_indices", "end_header");
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const fields = vertexOf(mesh, i).map(num);
    if (mesh.normals) fields.push(num(mesh.normals[i * 3]!), num(mesh.normals[i * 3 + 1]!), num(mesh.normals[i * 3 + 2]!));
    if (mesh.colors) for (let k = 0; k < 3; k++) fields.push(String(Math.round(Math.min(1, Math.max(0, mesh.colors[i * 3 + k]!)) * 255)));
    rows.push(fields.join(" "));
  }
  for (let t = 0; t < triangleCount(mesh); t++) rows.push(`3 ${mesh.indices[t * 3]} ${mesh.indices[t * 3 + 1]} ${mesh.indices[t * 3 + 2]}`);
  return `${[...header, ...rows].join("\n")}\n`;
}

export interface MeshFbxOptions extends Omit<FbxOptions, "mesh" | "textureFile"> {
  /** A diffuse texture referenced by this (relative) file name. */
  textureFile?: string;
  /** Phong diffuse colour, multiplied by the texture. */
  diffuse?: [number, number, number];
}

/** A text FBX 7.x with one mesh: normals and UVs by polygon vertex, a Phong material, optionally a diffuse texture. */
export function meshFbxText(mesh: MeshData, options: MeshFbxOptions = {}): string {
  const lines = fbxTextHeader(options);
  const triangles = triangleCount(mesh);
  const list = (values: ArrayLike<number>, format: (value: number) => string = num) => Array.from(values, format).join(",");
  const polygonIndex: number[] = [];
  for (let t = 0; t < triangles; t++) polygonIndex.push(mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, -(mesh.indices[t * 3 + 2]! + 1));
  const corners = Array.from(mesh.indices.subarray(0, triangles * 3));
  const block = (name: string, values: string, count: number) => [`\t\t${name}: *${count} {`, `\t\t\ta: ${values}`, "\t\t} "];
  const name = mesh.name.replace(/"/g, "'");
  lines.push("Objects:  {", `\tGeometry: 2001, "Geometry::${name}", "Mesh" {`);
  lines.push(...block("Vertices", list(mesh.positions), mesh.positions.length));
  lines.push(...block("PolygonVertexIndex", polygonIndex.join(","), polygonIndex.length), "\t\tGeometryVersion: 124");
  const layers: string[] = [];
  if (mesh.normals) {
    const normals = corners.flatMap((index) => [mesh.normals![index * 3]!, mesh.normals![index * 3 + 1]!, mesh.normals![index * 3 + 2]!]);
    lines.push("\t\tLayerElementNormal: 0 {", "\t\t\tVersion: 101", '\t\t\tName: ""', '\t\t\tMappingInformationType: "ByPolygonVertex"', '\t\t\tReferenceInformationType: "Direct"');
    lines.push(...block("Normals", list(normals), normals.length).map((line) => `\t${line}`), "\t\t}");
    layers.push("LayerElementNormal");
  }
  if (mesh.uvs) {
    lines.push("\t\tLayerElementUV: 0 {", "\t\t\tVersion: 101", '\t\t\tName: "UVMap"', '\t\t\tMappingInformationType: "ByPolygonVertex"', '\t\t\tReferenceInformationType: "IndexToDirect"');
    lines.push(...block("UV", list(mesh.uvs), mesh.uvs.length).map((line) => `\t${line}`));
    lines.push(...block("UVIndex", corners.join(","), corners.length).map((line) => `\t${line}`), "\t\t}");
    layers.push("LayerElementUV");
  }
  lines.push("\t\tLayerElementMaterial: 0 {", "\t\t\tVersion: 101", '\t\t\tName: ""', '\t\t\tMappingInformationType: "AllSame"', '\t\t\tReferenceInformationType: "IndexToDirect"');
  lines.push(...block("Materials", "0", 1).map((line) => `\t${line}`), "\t\t}");
  layers.push("LayerElementMaterial");
  lines.push("\t\tLayer: 0 {", "\t\t\tVersion: 100");
  for (const layer of layers) lines.push("\t\t\tLayerElement:  {", `\t\t\t\tType: "${layer}"`, "\t\t\t\tTypedIndex: 0", "\t\t\t}");
  lines.push("\t\t}", "\t}");
  lines.push(`\tModel: 2002, "Model::${name}", "Mesh" {`, "\t\tVersion: 232", "\t\tProperties70:  {", '\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0', "\t\t}", "\t\tShading: T", '\t\tCulling: "CullingOff"', "\t}");
  const [r, g, b] = options.diffuse ?? [1, 1, 1];
  lines.push(`\tMaterial: 2003, "Material::${name} material", "" {`, "\t\tVersion: 102", '\t\tShadingModel: "phong"', "\t\tMultiLayer: 0", "\t\tProperties70:  {");
  lines.push(`\t\t\tP: "DiffuseColor", "Color", "", "A",${num(r)},${num(g)},${num(b)}`, '\t\t\tP: "Shininess", "double", "Number", "",20', "\t\t}", "\t}");
  const connections = ['\tC: "OO",2001,2002', '\tC: "OO",2002,0', '\tC: "OO",2003,2002'];
  if (options.textureFile) {
    const file = options.textureFile.replace(/"/g, "'");
    lines.push('\tTexture: 2004, "Texture::Diffuse", "" {', '\t\tType: "TextureVideoClip"', "\t\tVersion: 202", '\t\tTextureName: "Texture::Diffuse"', `\t\tFileName: "${file}"`, `\t\tRelativeFilename: "${file}"`, "\t}");
    lines.push('\tVideo: 2005, "Video::Diffuse", "Clip" {', '\t\tType: "Clip"', `\t\tFileName: "${file}"`, `\t\tRelativeFilename: "${file}"`, "\t}");
    connections.push('\tC: "OP",2004,2003, "DiffuseColor"', '\tC: "OO",2005,2004');
  }
  lines.push("}", "Connections:  {", ...connections, "}");
  return `${lines.join("\n")}\n`;
}

/** A USDA root layer with one mesh (per-vertex normals, one display colour). Zip it as the first entry for a USDZ. */
export function meshUsda(
  mesh: MeshData,
  options: { creator?: string; doc?: string; upAxis?: "Y" | "Z"; metersPerUnit?: number; displayColor?: [number, number, number] } = {},
): string {
  const tuples = (values: ArrayLike<number>) => {
    const out: string[] = [];
    for (let i = 0; i + 2 < values.length; i += 3) out.push(`(${num(values[i]!)}, ${num(values[i + 1]!)}, ${num(values[i + 2]!)})`);
    return out.join(", ");
  };
  const prim = mesh.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_") || "Mesh";
  const meta: string[] = [];
  if (options.creator !== undefined) meta.push("    customLayerData = {", `        string creator = "${options.creator}"`, "    }");
  meta.push('    defaultPrim = "Root"');
  if (options.doc !== undefined) meta.push(`    doc = "${options.doc}"`);
  if (options.metersPerUnit !== undefined) meta.push(`    metersPerUnit = ${options.metersPerUnit}`);
  if (options.upAxis !== undefined) meta.push(`    upAxis = "${options.upAxis}"`);
  const body = [
    `    def Mesh "${prim}"`,
    "    {",
    `        int[] faceVertexCounts = [${Array.from({ length: triangleCount(mesh) }, () => 3).join(", ")}]`,
    `        int[] faceVertexIndices = [${Array.from(mesh.indices.subarray(0, triangleCount(mesh) * 3)).join(", ")}]`,
  ];
  if (mesh.normals) body.push(`        normal3f[] normals = [${tuples(mesh.normals)}] (`, '            interpolation = "vertex"', "        )");
  body.push(`        point3f[] points = [${tuples(mesh.positions)}]`);
  if (options.displayColor) body.push(`        color3f[] primvars:displayColor = [${tuples(options.displayColor)}]`);
  body.push('        uniform token subdivisionScheme = "none"', "    }");
  return ["#usda 1.0", "(", ...meta, ")", "", 'def Xform "Root"', "{", ...body, "}", ""].join("\n");
}
