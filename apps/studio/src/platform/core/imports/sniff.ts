// What a file is, decided from its first bytes (the file name only breaks ties and explains refusals). Pure: callers
// pass the first IMPORT_LIMITS.sniffBytes bytes and the full size, so the shell can check a drop before reading it.

import type { AllowedMimeType, ImportFormat, SourceApp } from "../types";
import { latin1Text, looksLikeText, readU32, startsWithAscii, utf8Text } from "./bytes";
import { importRefusal, type ImportRejectedError } from "./errors";
import { imageKind, imageKindFromExtension, type ImageKind } from "./images";
import { IMPORT_LIMITS } from "./limits";
import { basename, extension, isJunkPath } from "./paths";
import { firstEntryName, isEmptyZip, isZip } from "./zip";

/** Formats the importer can load. */
export type ModelFormat = "glb" | "gltf" | "fbx" | "obj" | "stl" | "ply" | "usdz";
export type SidecarRole = "buffer" | "material" | "image";

export type SniffResult =
  | { kind: "model"; format: ModelFormat; encoding: "binary" | "text"; version: number | null; mime: AllowedMimeType; evidence: string }
  | { kind: "bundle"; format: "zip"; mime: "application/zip"; evidence: string }
  | { kind: "sidecar"; role: SidecarRole; image: ImageKind | null; evidence: string }
  /** Kept with the original but not used (read-me and licence files, Unity .meta files, Blender backups). */
  | { kind: "extra"; evidence: string }
  /** Operating-system clutter (__MACOSX, .DS_Store …): left out of everything. */
  | { kind: "junk"; evidence: string }
  /** `reason` says what is wrong, `advice` what to do instead (an export path, a format to choose) or null. */
  | { kind: "unsupported"; format: ImportFormat | null; app: SourceApp | null; reason: string; advice: string | null; detail: string };

export const MODEL_MIME: Record<ModelFormat, AllowedMimeType> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  fbx: "application/octet-stream",
  obj: "model/obj",
  stl: "model/stl",
  ply: "application/octet-stream",
  usdz: "model/vnd.usdz+zip",
};

export const FORMAT_LABEL: Record<ImportFormat, string> = {
  glb: "GLB",
  gltf: "glTF",
  fbx: "FBX",
  obj: "OBJ",
  stl: "STL",
  ply: "PLY",
  usdz: "USDZ",
  dae: "COLLADA",
  zip: "ZIP",
};

/** Lowest FBX versions three.js reads: binary 6.4 (FBX 2006), text 7.0 (FBX 2010). */
const FBX_BINARY_MIN = 6400;
const FBX_TEXT_MIN = 7000;

export const SUPPORTED_SUMMARY = "GLB or glTF (with its .bin and textures, or as a .zip), FBX, OBJ (+ MTL), STL, PLY or USDZ";

const UNITY_ADVICE =
  "In Unity, export the object as GLB with UnityGLTF or glTFast (Export › glTF-Binary), or as FBX with the FBX Exporter package (GameObject › Export To FBX…), then import that file.";
const BLENDER_ADVICE = "In Blender, choose File › Export › glTF 2.0 (.glb) — or FBX (.fbx) — and import that file.";

interface ProjectFile {
  app: SourceApp;
  what: string;
  advice: string;
}

const PROJECT_FILES: Record<string, ProjectFile> = {
  blend: { app: "blender", what: "Blender project files (.blend)", advice: BLENDER_ADVICE },
  blend1: { app: "blender", what: "Blender backup files (.blend1)", advice: BLENDER_ADVICE },
  unitypackage: { app: "unity", what: "Unity packages (.unitypackage)", advice: UNITY_ADVICE },
  prefab: { app: "unity", what: "Unity prefabs (.prefab)", advice: UNITY_ADVICE },
  unity: { app: "unity", what: "Unity scenes (.unity)", advice: UNITY_ADVICE },
  max: { app: "3ds-max", what: "3ds Max scenes (.max)", advice: "In 3ds Max, use File › Export › Export Selected as glTF, FBX or OBJ, then import that file." },
  ma: { app: "maya", what: "Maya scenes (.ma)", advice: "In Maya, use File › Export Selection… as FBX (or glTF with a glTF exporter), then import that file." },
  mb: { app: "maya", what: "Maya scenes (.mb)", advice: "In Maya, use File › Export Selection… as FBX (or glTF with a glTF exporter), then import that file." },
  c4d: { app: "cinema-4d", what: "Cinema 4D projects (.c4d)", advice: "In Cinema 4D, use File › Export › glTF (.gltf/.glb) or FBX, then import that file." },
  hip: { app: "houdini", what: "Houdini scenes (.hip)", advice: "In Houdini, write the geometry with the glTF or FBX output node, then import that file." },
  hipnc: { app: "houdini", what: "Houdini scenes (.hipnc)", advice: "In Houdini, write the geometry with the glTF or FBX output node, then import that file." },
  hiplc: { app: "houdini", what: "Houdini scenes (.hiplc)", advice: "In Houdini, write the geometry with the glTF or FBX output node, then import that file." },
  skp: { app: "sketchup", what: "SketchUp models (.skp)", advice: "In SketchUp, use File › Export › 3D Model… as FBX or OBJ, then import that file." },
  ztl: { app: "zbrush", what: "ZBrush tools (.ztl)", advice: "In ZBrush, export the SubTool as OBJ or FBX (FBX ExportImport), then import that file." },
  zpr: { app: "zbrush", what: "ZBrush projects (.zpr)", advice: "In ZBrush, export the SubTool as OBJ or FBX (FBX ExportImport), then import that file." },
  spp: { app: "substance", what: "Substance 3D Painter projects (.spp)", advice: "Export the textured mesh as glTF/GLB, or export the textures and import them with the model's FBX or OBJ." },
  sbsar: { app: "substance", what: "Substance materials (.sbsar)", advice: "Bake the material into PNG textures and import them with a model." },
  sbs: { app: "substance", what: "Substance Designer graphs (.sbs)", advice: "Bake the material into PNG textures and import them with a model." },
  rcproject: { app: "reality-composer", what: "Reality Composer projects (.rcproject)", advice: "Export the scene as USDZ (File › Export), then import that file." },
  reality: { app: "reality-composer", what: "Reality files (.reality)", advice: "Export the scene as USDZ from Reality Composer, then import that file." },
};

const OTHER_FORMATS: Record<string, string> = {
  dae: "COLLADA (.dae)",
  "3ds": "3D Studio (.3ds)",
  "3mf": "3MF",
  amf: "AMF",
  dxf: "DXF",
  abc: "Alembic (.abc)",
  x3d: "X3D",
  wrl: "VRML (.wrl)",
  vrml: "VRML",
  lwo: "LightWave (.lwo)",
  lws: "LightWave scenes (.lws)",
  "3dm": "Rhino (.3dm)",
  step: "STEP (CAD)",
  stp: "STEP (CAD)",
  iges: "IGES (CAD)",
  igs: "IGES (CAD)",
  ifc: "IFC",
  x: "DirectX (.x)",
  vox: "MagicaVoxel (.vox)",
  usd: "Standalone USD layers",
  usda: "Standalone USD layers (.usda)",
  usdc: "Standalone USD layers (.usdc)",
  gcode: "G-code",
  obj2: "OBJ variants",
};

const EXTRA_EXTENSIONS = new Set(["txt", "md", "pdf", "html", "htm", "url", "rtf", "csv", "log", "ini", "cfg", "json", "xml", "meta", "license", "licence", "nfo"]);

function unsupported(format: ImportFormat | null, app: SourceApp | null, reason: string, advice: string | null, detail: string): SniffResult {
  return { kind: "unsupported", format, app, reason, advice, detail };
}

function model(format: ModelFormat, encoding: "binary" | "text", version: number | null, evidence: string): SniffResult {
  return { kind: "model", format, encoding, version, mime: MODEL_MIME[format], evidence };
}

function damaged(name: string, what: string): SniffResult {
  return unsupported(
    null,
    null,
    `${name} doesn't look like a valid ${what} file (its header is missing or damaged).`,
    "The file may be damaged or incomplete. Export or download it again.",
    `damaged:${what.toLowerCase()}`,
  );
}

/** Text at the start of a file, BOM and leading whitespace removed. */
function leadingText(head: Uint8Array): string {
  return utf8Text(head, 0, Math.min(head.length, IMPORT_LIMITS.sniffBytes)).replace(/^\s+/, "");
}

const OBJ_VERTEX = /^v[ \t]+[-+0-9.eE]+[ \t]+[-+0-9.eE]+[ \t]+[-+0-9.eE]+/m;
const OBJ_STRUCTURE = /^(?:f|o|g|usemtl|mtllib|vt|vn)[ \t]/m;

/**
 * Classifies one file. `head` holds at least the first IMPORT_LIMITS.sniffBytes bytes (or the whole file) and `size` is
 * the file's full size in bytes.
 */
export function sniffBytes(name: string, head: Uint8Array, size: number = head.length): SniffResult {
  const ext = extension(name);
  const label = basename(name) || "This file";

  if (isJunkPath(name)) return { kind: "junk", evidence: "operating-system metadata" };
  if (size === 0) return unsupported(null, null, `${label} is empty.`, "Export or download it again.", "unsupported:empty");

  // Binary signatures.
  if (startsWithAscii(head, "glTF")) {
    const version = readU32(head, 4);
    if (version === 2) return model("glb", "binary", 2, 'GLB header "glTF" version 2');
    return unsupported("glb", null, `${label} is a glTF ${version}.0 binary; only glTF 2.0 can be imported.`, "Re-export it as glTF 2.0 (GLB).", "unsupported:gltf1");
  }
  if (startsWithAscii(head, "Kaydara FBX Binary  \0")) {
    const version = readU32(head, 23);
    if (version < FBX_BINARY_MIN) return oldFbx(label, version);
    return model("fbx", "binary", version, `FBX binary header, version ${version}`);
  }
  if (isZip(head)) {
    const first = firstEntryName(head);
    const firstExt = first ? extension(first) : "";
    if (firstExt === "usdc" || firstExt === "usda" || firstExt === "usd") return model("usdz", "binary", null, `zip package whose first entry is the USD layer "${first}"`);
    if (ext === "usdz") return damaged(label, "USDZ");
    if (ext === "3mf" || ext === "kmz" || ext === "docx" || ext === "xlsx" || ext === "pptx") return unsupportedByExtension(label, ext);
    return { kind: "bundle", format: "zip", mime: "application/zip", evidence: "zip archive" };
  }
  if (isEmptyZip(head)) return unsupported("zip", null, `${label} is an empty zip file.`, "Zip the model together with its files.", "unsupported:empty-zip");
  if (startsWithAscii(head, "BLENDER")) return projectFile(label, "blend");
  if (head[0] === 0x1f && head[1] === 0x8b) {
    if (ext === "unitypackage") return projectFile(label, "unitypackage");
    return unsupported(null, null, `${label} is gzip-compressed.`, "Decompress it first, or zip the model instead.", "unsupported:gzip");
  }
  if (startsWithAscii(head, "PXR-USDC")) return unsupportedByExtension(label, "usdc");
  // PLY: a text header ("ply", "format …", … "end_header") even when the body is binary.
  if (startsWithAscii(head, "ply\n") || startsWithAscii(head, "ply\r\n")) {
    const header = latin1Text(head, 0, Math.min(head.length, 4096));
    const format = /^format[ \t]+(ascii|binary_little_endian|binary_big_endian)\b/m.exec(header)?.[1];
    if (!format) return damaged(label, "PLY");
    return model("ply", format === "ascii" ? "text" : "binary", null, `PLY header (${format})`);
  }

  const image = imageKind(head, ext);
  if (image !== "unknown") return { kind: "sidecar", role: "image", image, evidence: `${image.toUpperCase()} image` };

  // Binary STL has no signature: an 84-byte header (which may well start with "solid"), then 50 bytes per triangle.
  if (ext === "stl" && size >= 84 && head.length >= 84 && 84 + 50 * readU32(head, 80) === size) {
    return model("stl", "binary", null, "binary STL (84 + 50 × triangles bytes)");
  }

  // Text formats.
  if (looksLikeText(head)) {
    const text = leadingText(head);
    const fbx = /^;\s*FBX\s+(\d+)\.(\d+)\.(\d+)\s+project file/.exec(text);
    if (fbx || /^\s*FBXHeaderExtension\s*:/m.test(text.slice(0, 8192))) {
      const version = fbx ? Number(fbx[1]) * 1000 + Number(fbx[2]) * 100 + Number(fbx[3]) : Number(/FBXVersion:\s*(\d+)/.exec(text)?.[1] ?? 0);
      if (version > 0 && version < FBX_TEXT_MIN) return oldFbx(label, version);
      return model("fbx", "text", version || null, `FBX text header${version ? `, version ${version}` : ""}`);
    }
    if (text.startsWith("{")) {
      const legacy = /"asset"\s*:\s*\{[^{}]*"version"\s*:\s*"1(\.\d+)?"/.exec(text);
      if (legacy) return unsupported("gltf", null, `${label} is glTF 1.0; only glTF 2.0 can be imported.`, "Re-export it as glTF 2.0.", "unsupported:gltf1");
      if (ext === "gltf" || /"asset"\s*:/.test(text)) return model("gltf", "text", null, "glTF JSON");
      return { kind: "extra", evidence: "JSON document" };
    }
    if (/^solid\b/.test(text) && /\bfacet\s+normal\b/.test(text)) return model("stl", "text", null, 'STL text ("solid … facet normal")');
    if (/^#usda\b/.test(text)) return unsupportedByExtension(label, "usda");
    if (/<COLLADA\b/.test(text.slice(0, 4096))) {
      return unsupported("dae", null, `${label} is COLLADA (.dae), which isn't supported yet.`, "Export glTF/GLB or FBX instead.", "unsupported:dae");
    }
    if (/^%YAML/.test(text) && (/!u!/.test(text) || /unity3d\.com/.test(text))) {
      if (ext === "meta") return { kind: "extra", evidence: "Unity .meta file" };
      return projectFile(label, ext === "unity" ? "unity" : "prefab");
    }
    if (/^\s*newmtl\s/m.test(text)) return { kind: "sidecar", role: "material", image: null, evidence: "MTL material library" };
    if (OBJ_VERTEX.test(text) && (ext === "obj" || OBJ_STRUCTURE.test(text))) return model("obj", "text", null, "OBJ text (v/f records)");
  }

  if (ext === "stl") return damaged(label, "STL");

  // Decided by the name alone.
  if (PROJECT_FILES[ext]) return projectFile(label, ext);
  if (OTHER_FORMATS[ext]) return unsupportedByExtension(label, ext);
  if (ext === "bin") return { kind: "sidecar", role: "buffer", image: null, evidence: "binary buffer (.bin)" };
  if (ext === "mtl") return { kind: "sidecar", role: "material", image: null, evidence: "MTL material library" };
  const imageByName = imageKindFromExtension(ext);
  if (imageByName) return { kind: "sidecar", role: "image", image: null, evidence: `${ext.toUpperCase()} image (by name)` };
  if (EXTRA_EXTENSIONS.has(ext) || /^(readme|license|licence|copying|credits|attribution)/i.test(basename(name))) {
    return { kind: "extra", evidence: ext === "meta" ? "Unity .meta file" : "document" };
  }
  if (ext === "glb" || ext === "gltf" || ext === "fbx" || ext === "obj" || ext === "ply" || ext === "usdz" || ext === "zip") {
    return damaged(label, ext === "zip" ? "zip" : FORMAT_LABEL[ext]);
  }
  return unsupported(null, null, `${label} isn't a 3D format this importer reads.`, `Supported: ${SUPPORTED_SUMMARY}.`, "unsupported:unknown");
}

function oldFbx(label: string, version: number): SniffResult {
  const shown = `${Math.floor(version / 1000)}.${Math.floor((version % 1000) / 100)}`;
  return unsupported(
    "fbx",
    null,
    `${label} uses FBX ${shown}, which the browser loader can't read.`,
    "Re-export it as FBX 2014/2015 (7.4) or newer, or as GLB.",
    "unsupported:old-fbx",
  );
}

function projectFile(label: string, ext: string): SniffResult {
  const project = PROJECT_FILES[ext]!;
  return unsupported(null, project.app, `${label}: ${project.what} can't be opened in the browser.`, project.advice, `unsupported:${ext}`);
}

function unsupportedByExtension(label: string, ext: string): SniffResult {
  const what = OTHER_FORMATS[ext] ?? ext.toUpperCase();
  const advice =
    ext === "usd" || ext === "usda" || ext === "usdc"
      ? "Package it as USDZ (for example with usdzip or Reality Converter), or export GLB."
      : "Export GLB/glTF, FBX or OBJ instead.";
  return unsupported(ext === "dae" ? "dae" : null, null, `${label}: ${what} isn't supported.`, advice, `unsupported:${ext}`);
}

export type UnsupportedFile = Extract<SniffResult, { kind: "unsupported" }>;

/** The refusal analyzeFiles raises for an unsupported file (so a drop can be checked before it is read in full). */
export function sniffRefusal(result: UnsupportedFile): ImportRejectedError {
  return importRefusal(result.reason, result.detail, { advice: result.advice });
}

/** Reads the first bytes of a File and classifies it. */
export async function sniffFile(file: Blob & { name: string }, path: string = file.name): Promise<SniffResult> {
  const head = new Uint8Array(await file.slice(0, IMPORT_LIMITS.sniffBytes).arrayBuffer());
  return sniffBytes(path, head, file.size);
}
