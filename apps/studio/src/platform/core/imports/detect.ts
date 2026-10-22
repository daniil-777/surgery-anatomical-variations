// Which application wrote an imported file, with the evidence behind the answer. Metadata the exporter wrote wins
// (detectedBy "metadata"); words and companion files in the selection are a weaker signal ("filename"); otherwise the
// source stays unknown. Pure: callers pass the facts read by gltf.ts, fbx.ts, usd.ts and the text headers.
//
// Signatures, checked against exporter sources and real files on 2026-10-21:
//
// | Where                         | Written as                                                         | Source                                                                                     |
// |-------------------------------|--------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
// | glTF asset.generator          | "Khronos glTF Blender I/O v4.2.70"                                 | KhronosGroup/glTF-Blender-IO addons/io_scene_gltf2/blender/exp/exporter.py                 |
// |                               | "UnityGltf 2.14.0, Unity 2022.3.20f1, URP" (older: "UnityGLTF")    | KhronosGroup/UnityGLTF Runtime/Scripts/GLTFSettings.cs GetGenerator()                      |
// |                               | "Unity 2022.3.10f1 glTFast 6.0.1"                                  | atteneder/glTFast (com.unity.cloud.gltfast) Runtime/Scripts/Export/GltfWriter.cs           |
// |                               | "UniGLTF-2.0.0"                                                    | vrm-c/UniVRM Packages/UniGLTF/Runtime/UniGLTF/IO/gltfExporter.cs                          |
// |                               | "FBX2glTF v0.9.7"                                                  | facebookincubator/FBX2glTF src/gltf/Raw2Gltf.cpp                                           |
// |                               | "Sketchfab-12.66.0" + asset.extras {author, license, source, title}| Sketchfab downloads (e.g. NVIDIAGameWorks/Path-Tracing-SDK-Media mech_drone/scene.gltf)    |
// |                               | "THREE.GLTFExporter r186"                                          | three/examples/jsm/exporters/GLTFExporter.js                                               |
// |                               | "Houdini GLTF 2.0 Exporter"                                        | sideeffects/HoudiniGLTF src/ROP/ROP_GLTF_ExportRoot.h                                      |
// |                               | "Maxon Cinema 4D 2024.4.1 (#200000219)"                            | Cinema 4D glTF exports on GitHub                                                           |
// |                               | "Adobe Substance 3D Stager - <hash>" (+ XMP xmp:CreatorTool)       | KhronosGroup/glTF-Sample-Assets Models/ScatteringSkull                                     |
// |                               | "babylon.js glTF exporter for 3ds max 2017 v1.2.14", "… for maya", | KhronosGroup/glTF-Generator-Registry registry.json, BabylonJS/Exporters samples            |
// |                               | "Maya2glTF", "Sketchup glTF Exporter by Centaur", "obj2gltf"       |                                                                                            |
// | FBX Creator / SceneInfo       | Creator "Blender (stable FBX IO) - 4.0.2 - 5.8.13";                | blender/blender scripts/addons_core/io_scene_fbx/export_fbx_bin.py fbx_header_elements()  |
// | (Original|… and LastSaved|…   |   vendor "Blender Foundation", name "Blender (stable FBX IO)"      |                                                                                            |
// |  ApplicationVendor/Name/      | name "Unity FBX Exporter" (vendor empty), MetaData Title "Created  | Unity-Technologies/com.unity.formats.fbx com.unity.formats.fbx/Editor/FbxExporter.cs      |
// |  Version)                     |   by FBX Exporter from Unity Technologies"                         |                                                                                            |
// |                               | "Autodesk" / "Maya" / "201900"; "Autodesk" / "3ds Max" / "2020";   | ufbx/ufbx data/*.fbx test files                                                            |
// |                               |   "Autodesk" / "MotionBuilder" / "2023"                            |                                                                                            |
// |                               | "MAXON" / "CINEMA 4D R18" (Original: "MAXON CINEMA 4D Studio …")   | Cinema 4D FBX files on GitHub                                                              |
// |                               | "SideFX Software" / "Houdini" / "19.5.403"                         | zenustech/zeno projects/FBX/meshs/Sphere.fbx                                               |
// |                               | Creator "FBX SDK/FBX Plugins version 2020.0.1" names only the SDK  | written by Maya, Max, ZBrush, Marvelous Designer, Unity … alike                            |
// | OBJ header comments           | "# Blender 4.4.1" / "# Blender v2.79 (sub 0) OBJ File: ''"         | blender/blender source/blender/io/wavefront_obj/exporter; blender-addons io_scene_obj      |
// |                               | "# 3ds Max Wavefront OBJ Exporter v0.94b - (c)2007 guruware",      | ufbx/ufbx data/*.obj; OBJ files on GitHub                                                  |
// |                               | "# File exported by ZBrush version 2022", "# File exported by      |                                                                                            |
// |                               | Houdini 16.5.439 (www.sidefx.com)", "# WaveFront *.obj file        |                                                                                            |
// |                               | (generated by CINEMA 4D)", "# Exported from SketchUp, (c) …"       |                                                                                            |
// | PLY header                    | "comment Created in Blender version 4.2.0" (legacy: "comment       | blender/blender source/blender/io/ply/exporter/ply_export_header.cc; blender-addons       |
// |                               |   Created by Blender 3.3.0 - www.blender.org")                     |   io_mesh_ply/export_ply.py                                                                |
// | STL header                    | "solid Exported from Blender-3.3.0" / 80-byte binary header        | blender-addons io_mesh_stl/stl_utils.py (Blender ≥ 4.2 writes "solid " and a blank header) |
// | USD root layer                | doc "Blender v4.2.0"; customLayerData creator "Reality Composer    | blender/blender source/blender/io/usd/intern/usd_capi_export.cc; .usda files on GitHub;   |
// |                               |   Pro Version 2.0 (494.100.6)", "Three.js USDZExporter",           |   three/examples/jsm/exporters/USDZExporter.js                                             |
// |                               |   "usdzconvert preview 0.67", "Reality Converter 47.1 (…)"         |                                                                                            |

import type { DetectedBy, SourceApp } from "../types";
import { cleanLabel } from "./bytes";
import type { FbxHeader } from "./fbx";
import type { GltfFacts } from "./gltf";
import { basename, extension } from "./paths";
import type { UsdLayerMeta } from "./usd";

export interface SourceDetection {
  sourceApp: SourceApp;
  /** The exporter's own words (generator, application name), at most 200 characters; null when unknown. */
  sourceDetail: string | null;
  detectedBy: DetectedBy;
  /** Why: one sentence per finding, the deciding one first. */
  evidence: string[];
}

/** Application words in exporter signatures. Order matters: Maxon also sells ZBrush, babylon.js names the host app. */
const APP_RULES: ReadonlyArray<{ app: SourceApp; pattern: RegExp }> = [
  { app: "sketchfab", pattern: /sketchfab/i },
  { app: "reality-composer", pattern: /reality\s*composer/i },
  { app: "zbrush", pattern: /zbrush|pixologic/i },
  { app: "blender", pattern: /\bblender/i },
  { app: "unity", pattern: /\bunity|unigltf|gltfast/i },
  { app: "3ds-max", pattern: /\b3ds\s*max\b|\b3dsmax\b|\bmax20\d\d\b/i },
  { app: "maya", pattern: /\bmaya(\b|2gltf)/i },
  { app: "cinema-4d", pattern: /cinema\s*4d|\bc4d\b|\bmaxon\b/i },
  { app: "houdini", pattern: /houdini|\bside\s*fx\b|side effects software/i },
  { app: "sketchup", pattern: /sketch\s*up/i },
  { app: "substance", pattern: /substance/i },
];

/** Signatures that name a library, not an application. */
const SDK_ONLY = /^\s*fbx\s*sdk\b|^\s*fbx\s*sdk\/fbx\s*plugins/i;

export const SOURCE_APP_LABEL: Record<SourceApp, string> = {
  unity: "Unity",
  blender: "Blender",
  maya: "Maya",
  "3ds-max": "3ds Max",
  "cinema-4d": "Cinema 4D",
  houdini: "Houdini",
  sketchup: "SketchUp",
  substance: "Substance",
  zbrush: "ZBrush",
  "reality-composer": "Reality Composer",
  sketchfab: "Sketchfab",
  other: "Other app",
  unknown: "Unknown",
};

export function matchApplication(signature: string | null | undefined): SourceApp | null {
  if (!signature) return null;
  for (const rule of APP_RULES) if (rule.pattern.test(signature)) return rule.app;
  return null;
}

interface Finding {
  app: SourceApp;
  detail: string | null;
  evidence: string;
}

const quote = (value: string) => `"${cleanLabel(value, 160)}"`;

function finding(app: SourceApp, detail: string | null, evidence: string): Finding {
  return { app, detail: detail === null ? null : cleanLabel(detail) || null, evidence };
}

/** A signature string: the named app when it is recognised, "other" when it names something else. */
function fromSignature(signature: string | null, evidence: string, allowOther: boolean): Finding | null {
  if (!signature || SDK_ONLY.test(signature)) return null;
  const app = matchApplication(signature);
  if (app) return finding(app, signature, evidence);
  return allowOther ? finding("other", signature, evidence) : null;
}

// Per format ---------------------------------------------------------------------------------------------------------

export function gltfFindings(facts: GltfFacts): Finding[] {
  const findings: Finding[] = [];
  const generator = facts.generator;
  const named = fromSignature(generator, `glTF asset.generator ${quote(generator ?? "")}`, false);
  if (named) findings.push(named);
  if (facts.extras.source && /(^|\/\/|\.)sketchfab\.com\b/i.test(facts.extras.source)) {
    findings.push(finding("sketchfab", generator ?? "Sketchfab", `glTF asset.extras.source is a Sketchfab page ${quote(facts.extras.source)}`));
  }
  const tool = fromSignature(facts.creatorTool, `glTF XMP xmp:CreatorTool ${quote(facts.creatorTool ?? "")}`, false);
  if (tool) findings.push(tool);
  const copyright = matchApplication(facts.copyright);
  if (copyright && facts.copyright) findings.push(finding(copyright, generator, `glTF asset.copyright ${quote(facts.copyright)}`));
  if (findings.length === 0) {
    const other = fromSignature(generator, `glTF asset.generator ${quote(generator ?? "")}`, true) ?? fromSignature(facts.creatorTool, `glTF XMP xmp:CreatorTool ${quote(facts.creatorTool ?? "")}`, true);
    if (other) findings.push(other);
  }
  return findings;
}

function applicationLabel(app: { vendor: string | null; name: string | null; version: string | null }): string | null {
  if (!app.name && !app.vendor) return null;
  const name = app.name ?? "";
  const version = app.version && !name.includes(app.version) ? ` ${app.version}` : "";
  return `${name || app.vendor}${version}`.trim() || null;
}

const NATIVE_FILE_APPS: Record<string, SourceApp> = {
  blend: "blender",
  max: "3ds-max",
  ma: "maya",
  mb: "maya",
  c4d: "cinema-4d",
  hip: "houdini",
  hipnc: "houdini",
  hiplc: "houdini",
  skp: "sketchup",
  ztl: "zbrush",
  zpr: "zbrush",
};

export function fbxFindings(header: FbxHeader): Finding[] {
  const findings: Finding[] = [];
  const saved = applicationLabel(header.lastSaved);
  const original = applicationLabel(header.original);
  const savedSignature = [header.lastSaved.vendor, header.lastSaved.name].filter(Boolean).join(" ");
  const originalSignature = [header.original.vendor, header.original.name].filter(Boolean).join(" ");
  const originally = original && original !== saved ? ` (first created in ${original})` : "";
  if (saved) {
    const found = fromSignature(savedSignature, `FBX SceneInfo LastSaved|ApplicationName ${quote(saved)}${originally}`, true);
    if (found) findings.push({ ...found, detail: cleanLabel(saved) });
  }
  if (original && findings.length === 0) {
    const found = fromSignature(originalSignature, `FBX SceneInfo Original|ApplicationName ${quote(original)}`, true);
    if (found) findings.push({ ...found, detail: cleanLabel(original) });
  }
  const creator = fromSignature(header.creator, `FBX Creator ${quote(header.creator ?? "")}`, false);
  if (creator) findings.push(creator);
  if (header.title && /from unity technologies/i.test(header.title)) {
    findings.push(finding("unity", saved ?? "Unity FBX Exporter", `FBX SceneInfo title ${quote(header.title)}`));
  } else if (header.author && /^unity technologies$/i.test(header.author)) {
    findings.push(finding("unity", saved ?? "Unity FBX Exporter", `FBX SceneInfo author ${quote(header.author)}`));
  }
  const nativeExtension = header.nativeFile ? extension(header.nativeFile.replace(/\\/g, "/")) : "";
  const nativeApp = NATIVE_FILE_APPS[nativeExtension];
  if (nativeApp) findings.push(finding(nativeApp, saved, `FBX SceneInfo names a .${nativeExtension} source file`));
  if (header.documentUrl && /com\.sketchup\.sketchup/i.test(header.documentUrl)) {
    findings.push(finding("sketchup", saved, "FBX SceneInfo DocumentUrl is a SketchUp export path"));
  }
  return findings;
}

/** Leading comment lines of an OBJ file (before the first data record). */
export function objHeaderComments(text: string): string[] {
  const comments: string[] = [];
  for (const line of text.split(/\r?\n/, 200)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("#")) break;
    const comment = trimmed.replace(/^#+\s*/, "");
    if (comment) comments.push(comment);
    if (comments.length >= 40) break;
  }
  return comments;
}

const GENERIC_EXPORTER = /\b(?:exported|generated|created|written)\s+(?:by|from|with|in)\s+(.{2,80})/i;

function commentFindings(comments: string[], where: string, allowGeneric: boolean): Finding[] {
  for (const comment of comments) {
    const app = matchApplication(comment);
    if (app) return [finding(app, comment, `${where} ${quote(comment)}`)];
  }
  if (allowGeneric) {
    for (const comment of comments) {
      const named = GENERIC_EXPORTER.exec(comment)?.[1];
      if (named && /[a-z]/i.test(named) && !/^\d/.test(named)) return [finding("other", comment, `${where} ${quote(comment)}`)];
    }
  }
  return [];
}

export function objFindings(text: string): Finding[] {
  return commentFindings(objHeaderComments(text), "OBJ header comment", true);
}

/** "comment …" and "obj_info …" lines of a PLY header. */
export function plyFindings(text: string): Finding[] {
  const end = text.indexOf("end_header");
  const header = end >= 0 ? text.slice(0, end) : text.slice(0, 8192);
  const comments = [...header.matchAll(/^(?:comment|obj_info)[ \t]+(.+)$/gm)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
  return commentFindings(comments, "PLY header comment", true);
}

/** ASCII STL: the text after "solid"; binary STL: the 80-byte header. Object names are not evidence, app words are. */
export function stlFindings(header: string, binary: boolean): Finding[] {
  const text = cleanLabel(binary ? header : header.replace(/^\s*solid\b/i, ""), 120);
  if (!text) return [];
  const where = binary ? "STL binary header" : 'STL "solid" line';
  const app = matchApplication(text);
  if (app) return [finding(app, text, `${where} ${quote(text)}`)];
  const named = GENERIC_EXPORTER.exec(text)?.[1];
  return named && /[a-z]/i.test(named) ? [finding("other", text, `${where} ${quote(text)}`)] : [];
}

export function usdFindings(meta: UsdLayerMeta): Finding[] {
  const findings: Finding[] = [];
  const creator = fromSignature(meta.creator, `USD customLayerData.creator ${quote(meta.creator ?? "")}`, true);
  if (creator) findings.push(creator);
  const doc = matchApplication(meta.doc);
  if (doc && meta.doc) findings.push(finding(doc, meta.doc, `USD layer doc ${quote(meta.doc)}`));
  return findings;
}

// Selection names ----------------------------------------------------------------------------------------------------

const NAME_WORDS: ReadonlyArray<{ app: SourceApp; pattern: RegExp }> = [
  { app: "unity", pattern: /(^|[^a-z0-9])unity([^a-z]|$)/i },
  { app: "blender", pattern: /blender/i },
  { app: "houdini", pattern: /houdini/i },
  { app: "zbrush", pattern: /zbrush/i },
  { app: "sketchup", pattern: /sketch[\s_-]?up/i },
  { app: "cinema-4d", pattern: /cinema[\s_-]?4d|(^|[^a-z0-9])c4d([^a-z0-9]|$)/i },
  { app: "3ds-max", pattern: /3ds[\s_-]?max/i },
  { app: "substance", pattern: /substance/i },
  { app: "sketchfab", pattern: /sketchfab/i },
  { app: "reality-composer", pattern: /reality[\s_-]?composer/i },
];

const COMPANION_EXTENSIONS: Record<string, SourceApp> = {
  ...NATIVE_FILE_APPS,
  blend1: "blender",
  meta: "unity",
  unitypackage: "unity",
  prefab: "unity",
  spp: "substance",
  sbsar: "substance",
  rcproject: "reality-composer",
};

/**
 * Hints from names: application words in `names` (the main file's path and the zip's name — not every texture), and
 * companion files anywhere in `paths` (Unity .meta files, a .blend next to its export).
 */
export function filenameFindings(names: string[], paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const name of names) {
    for (const rule of NAME_WORDS) {
      if (rule.pattern.test(name)) {
        findings.push(finding(rule.app, null, `The name ${quote(name)} mentions ${SOURCE_APP_LABEL[rule.app]}`));
        break;
      }
    }
  }
  for (const path of paths) {
    const ext = extension(path);
    const companion = COMPANION_EXTENSIONS[ext];
    if (!companion) continue;
    const evidence = ext === "meta" ? "Unity .meta files are included" : `A ${SOURCE_APP_LABEL[companion]} file is included (${basename(path)})`;
    if (!findings.some((entry) => entry.evidence === evidence)) findings.push(finding(companion, null, evidence));
  }
  return findings;
}

// Decision -----------------------------------------------------------------------------------------------------------

export interface SourceSignals {
  gltf?: GltfFacts | null;
  fbx?: FbxHeader | null;
  /** First bytes of an OBJ file as text. */
  obj?: string | null;
  /** First bytes of a PLY file as text. */
  ply?: string | null;
  stl?: { header: string; binary: boolean } | null;
  usd?: UsdLayerMeta | null;
  /** The main file's path and the zip's own name (searched for application words). */
  names?: string[];
  /** Every path of the selection (searched for companion files such as Unity .meta files). */
  paths?: string[];
}

export function detectSource(signals: SourceSignals): SourceDetection {
  const metadata: Finding[] = [
    ...(signals.gltf ? gltfFindings(signals.gltf) : []),
    ...(signals.fbx ? fbxFindings(signals.fbx) : []),
    ...(signals.obj ? objFindings(signals.obj) : []),
    ...(signals.ply ? plyFindings(signals.ply) : []),
    ...(signals.stl ? stlFindings(signals.stl.header, signals.stl.binary) : []),
    ...(signals.usd ? usdFindings(signals.usd) : []),
  ];
  const names = filenameFindings(signals.names ?? [], signals.paths ?? []);
  // A named application beats "other": a converter's generator can sit next to an app's own fields.
  const decisive = metadata.find((entry) => entry.app !== "other") ?? metadata[0];
  if (decisive) {
    return {
      sourceApp: decisive.app,
      sourceDetail: decisive.detail,
      detectedBy: "metadata",
      evidence: unique([decisive.evidence, ...metadata.map((entry) => entry.evidence), ...names.map((entry) => entry.evidence)]),
    };
  }
  if (names.length > 0) {
    const counts = new Map<SourceApp, number>();
    for (const entry of names) counts.set(entry.app, (counts.get(entry.app) ?? 0) + 1);
    const apps = [...counts.keys()];
    if (apps.length === 1) {
      return { sourceApp: apps[0]!, sourceDetail: null, detectedBy: "filename", evidence: unique(names.map((entry) => entry.evidence)) };
    }
    // Conflicting hints: report them, decide nothing.
    return { sourceApp: "unknown", sourceDetail: null, detectedBy: "none", evidence: unique(names.map((entry) => entry.evidence)) };
  }
  return { sourceApp: "unknown", sourceDetail: null, detectedBy: "none", evidence: [] };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, 12);
}
