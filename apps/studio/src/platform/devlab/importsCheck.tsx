// Development check of the import analyser in a real browser (apps/studio/px-imports-check.html, served by the Vite
// dev server only; it is not a build input). It writes fixture files here — a GLB from Blender, a glTF + .bin pair from
// Unity, an OBJ + MTL from Blender, a binary STL, an ASCII PLY, an ASCII FBX from Maya, a Sketchfab-style zip and a
// USDZ —, runs analyzeFiles on each, loads every preview GLB back and measures it, checks each thumbnail's pixels, then
// runs the refusals (project files, Draco, KTX2, limits, a zip bomb, an ambiguous selection, cancellation). Results are
// shown and published on window.__importsCheck for scripts; files dropped on the page are analysed the same way.

import { StrictMode, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CircleAlert, CircleCheck, FileUp, ImageOff, Import, RotateCw } from "lucide-react";
import { AppLayout, Badge, Button, Icon, ProgressBar, PxProvider, Toolbar, formatCount, usePx } from "../ui";
import { isPlatformError, type DetectedBy, type ImportFormat, type SourceApp } from "../core/types";
import {
  analyzeFiles,
  FORMAT_LABEL,
  formatBytes,
  ImportChoiceError,
  ImportRejectedError,
  SOURCE_APP_LABEL,
  type AnalyzeOptions,
  type ImportAnalysis,
  type ImportProgress,
  type ImportStage,
} from "../core/imports";
import { blobPart } from "../core/imports/bytes";
import { measureScene } from "../core/imports/stats";
import {
  cubeGlb,
  cubeGltf,
  glbOf,
  meshFbxText,
  meshGlb,
  meshGltf,
  meshObj,
  meshPly,
  meshStl,
  meshUsda,
  mtlText,
  zipOf,
  type MeshData,
} from "../core/imports/__fixtures__/builders";

/** The free plan's per-file limit (DESIGN.md §6). */
const PLAN_MAX_BYTES = 50 * 1024 * 1024;
/** A thumbnail counts as showing something when at least this share of its pixels sits on an edge. */
const MIN_EDGE_FRACTION = 0.002;
const STAGE_LABEL: Record<ImportStage, string> = {
  reading: "Reading files",
  detecting: "Detecting the format",
  loading: "Loading the model",
  measuring: "Measuring",
  converting: "Making the preview GLB",
  thumbnail: "Rendering the thumbnail",
  packaging: "Packaging the original",
};
const CONTAINER_LABEL: Record<ImportAnalysis["container"], string> = { file: "Single File", zip: "Zip Bundle", selection: "Several Files" };

// Fixture geometry and textures ----------------------------------------------------------------------------------------

/** Deterministic pseudo-random numbers (mulberry32): the fixtures are the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normals averaged over every vertex at the same position, so UV seams do not show as creases. */
function smoothNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const count = positions.length / 3;
  const keys = Array.from({ length: count }, (_, i) => `${Math.round(positions[i * 3]! * 1e5)},${Math.round(positions[i * 3 + 1]! * 1e5)},${Math.round(positions[i * 3 + 2]! * 1e5)}`);
  const sums = new Map<string, THREE.Vector3>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const face = new THREE.Vector3();
  const edge = new THREE.Vector3();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    a.fromArray(positions, corners[0]! * 3);
    b.fromArray(positions, corners[1]! * 3);
    c.fromArray(positions, corners[2]! * 3);
    face.subVectors(c, b).cross(edge.subVectors(a, b));
    for (const corner of corners) {
      const key = keys[corner]!;
      const sum = sums.get(key) ?? new THREE.Vector3();
      sums.set(key, sum.add(face));
    }
  }
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const normal = (sums.get(keys[i]!) ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
    normals[i * 3] = normal.x;
    normals[i * 3 + 1] = normal.y;
    normals[i * 3 + 2] = normal.z;
  }
  return normals;
}

/** A three.js geometry bent by `deform`, scaled by `size`, as arrays for the fixture writers. */
function shape(name: string, geometry: THREE.BufferGeometry, deform: (point: THREE.Vector3) => void, size: number): MeshData {
  const position = geometry.getAttribute("position");
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    deform(point);
    position.setXYZ(i, point.x * size, point.y * size, point.z * size);
  }
  const positions = Float32Array.from(position.array as ArrayLike<number>);
  const indices = Uint32Array.from(geometry.index ? (geometry.index.array as ArrayLike<number>) : Array.from({ length: position.count }, (_, i) => i));
  const uv = geometry.getAttribute("uv");
  const mesh: MeshData = { name, positions, normals: smoothNormals(positions, indices), indices };
  if (uv) mesh.uvs = Float32Array.from(uv.array as ArrayLike<number>);
  geometry.dispose();
  return mesh;
}

/** A closed tube along `points` whose radius follows `radius(t)`; both ends round off to a point. */
function tube(name: string, points: THREE.Vector3[], radius: (t: number) => number, size: number): MeshData {
  const curve = new THREE.CatmullRomCurve3(points);
  const tubular = 180;
  const radial = 48;
  const geometry = new THREE.TubeGeometry(curve, tubular, 1, radial, false);
  const position = geometry.getAttribute("position");
  const center = new THREE.Vector3();
  const point = new THREE.Vector3();
  for (let ring = 0; ring <= tubular; ring++) {
    const t = ring / tubular;
    curve.getPointAt(t, center);
    const end = Math.sin((Math.min(1, Math.min(t, 1 - t) / 0.06) * Math.PI) / 2);
    const scale = radius(t) * end;
    for (let k = 0; k <= radial; k++) {
      const index = ring * (radial + 1) + k;
      point.fromBufferAttribute(position, index).sub(center).multiplyScalar(scale).add(center);
      position.setXYZ(index, point.x, point.y, point.z);
    }
  }
  return shape(name, geometry, () => undefined, size);
}

const lerp = THREE.MathUtils.lerp;

function liver(): MeshData {
  return shape("Liver", new THREE.SphereGeometry(1, 128, 96), (p) => {
    // A broad right lobe tapering into a thin left lobe, a flattened underside and a gentle swell on top.
    const t = (p.x + 1) / 2;
    p.x *= 1.55;
    p.y *= lerp(0.95, 0.36, t);
    p.z *= lerp(1, 0.6, t);
    if (p.y < -0.1) p.y = -0.1 + (p.y + 0.1) * 0.35;
    p.y += 0.05 * Math.sin(p.x * 2.2) * Math.cos(p.z * 2.4);
  }, 0.14);
}

function heart(): MeshData {
  const tilt = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(-28));
  return shape("Heart", new THREE.SphereGeometry(1, 96, 72), (p) => {
    // Apex below, broad base above, a shallow groove down the front, tilted as in the chest.
    const y = p.y;
    const taper = y < 0 ? 1 + y * 0.62 : 1 - y * y * 0.14;
    p.x *= taper * 0.86;
    p.z *= taper * 0.78;
    p.y = y * 1.12;
    if (p.z > 0) p.z -= 0.06 * Math.exp(-((p.x - 0.15 * p.y) ** 2) / 0.008);
    p.applyMatrix4(tilt);
  }, 0.065);
}

function kidney(): MeshData {
  return shape("Kidney", new THREE.SphereGeometry(1, 96, 72), (p) => {
    p.x *= 0.62;
    p.y *= 1.15;
    p.z *= 0.42;
    // The hilum: a dent on the medial side.
    if (p.x < 0) p.x *= 1 - 0.55 * Math.exp(-(p.y * p.y) / 0.12);
  }, 0.055);
}

function femur(): MeshData {
  return shape("Femur", new THREE.CapsuleGeometry(0.13, 2.1, 16, 48, 96), (p) => {
    // A shaft with a rounded head at the top and wide condyles at the bottom.
    const head = 1 + 1.5 * Math.exp(-((p.y - 1.08) ** 2) / 0.03);
    const condyles = 1 + 1.9 * Math.exp(-((p.y + 1.08) ** 2) / 0.022);
    const shaft = 1 + 0.12 * Math.sin(p.y * 2.3);
    const scale = Math.max(head, condyles) * shaft;
    p.x *= scale;
    p.z *= scale * (p.y < -0.8 ? 0.7 : 0.92);
    if (p.y > 0.9) p.x += 0.12 * (p.y - 0.9) * 4;
  }, 210);
}

function lung(): MeshData {
  const mesh = shape("Lung", new THREE.SphereGeometry(1, 96, 72), (p) => {
    p.x *= 0.56;
    p.z *= 0.5;
    p.y *= 1.05;
    if (p.y > 0) {
      const taper = 1 - 0.42 * p.y;
      p.x *= taper;
      p.z *= taper;
    }
    if (p.x > 0.17) p.x = 0.17 + (p.x - 0.17) * 0.35;
    if (p.y < -0.62) p.y = -0.62 + (p.y + 0.62) * 0.35;
  }, 0.12);
  const next = random(7);
  const count = mesh.positions.length / 3;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const height = mesh.positions[i * 3 + 1]! / 0.12;
    const mottle = (next() - 0.5) * 0.08;
    colors[i * 3] = Math.min(1, 0.86 + mottle);
    colors[i * 3 + 1] = Math.min(1, lerp(0.5, 0.64, (height + 1) / 2) + mottle);
    colors[i * 3 + 2] = Math.min(1, lerp(0.55, 0.66, (height + 1) / 2) + mottle);
  }
  mesh.colors = colors;
  return mesh;
}

function pancreas(): MeshData {
  const points = [new THREE.Vector3(-1.15, -0.05, 0.1), new THREE.Vector3(-0.55, 0.12, 0), new THREE.Vector3(0.15, 0.05, -0.08), new THREE.Vector3(0.75, 0.25, 0), new THREE.Vector3(1.2, 0.38, 0.12)];
  return tube("Pancreas", points, (t) => lerp(0.34, 0.12, t ** 0.8) * (1 + 0.05 * Math.sin(t * 46)), 8);
}

function stomach(): MeshData {
  const points = [new THREE.Vector3(-0.25, 1.05, 0), new THREE.Vector3(-0.42, 0.45, 0.05), new THREE.Vector3(-0.2, -0.3, 0), new THREE.Vector3(0.45, -0.55, -0.05), new THREE.Vector3(0.95, -0.22, 0)];
  return tube("Stomach", points, (t) => lerp(0.46, 0.14, Math.max(0, t - 0.15) ** 0.9 / 0.85 ** 0.9), 0.11);
}

function bladder(): MeshData {
  return shape("Bladder", new THREE.SphereGeometry(1, 72, 54), (p) => {
    // A smooth pear: wide dome above, narrowing towards the neck below.
    const narrow = 0.86 + 0.14 * p.y - 0.06 * p.y * p.y;
    p.x *= narrow;
    p.z *= narrow * 0.9;
    p.y *= 0.92;
  }, 0.05);
}

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** A tileable 512² PNG: a base colour mottled with soft spots of nearby tones and a fine grain. */
async function tissueTexture(seed: number, base: string, tones: string[]): Promise<Uint8Array> {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas for the fixture texture.");
  const next = random(seed);
  context.fillStyle = base;
  context.fillRect(0, 0, size, size);
  for (let i = 0; i < 220; i++) {
    const x = next() * size;
    const y = next() * size;
    const radius = 5 + next() ** 2 * 58;
    const tone = tones[Math.floor(next() * tones.length)] ?? base;
    // Drawn at x and at x ± size so the left and right edges meet without a seam.
    for (const offset of [-size, 0, size]) {
      const gradient = context.createRadialGradient(x + offset, y, 0, x + offset, y, radius);
      gradient.addColorStop(0, rgba(tone, 0.5));
      gradient.addColorStop(1, rgba(tone, 0));
      context.fillStyle = gradient;
      context.fillRect(x + offset - radius, y - radius, radius * 2, radius * 2);
    }
  }
  const pixels = context.getImageData(0, 0, size, size);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const grain = (next() - 0.5) * 16;
    pixels.data[i] = pixels.data[i]! + grain;
    pixels.data[i + 1] = pixels.data[i + 1]! + grain;
    pixels.data[i + 2] = pixels.data[i + 2]! + grain;
  }
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The fixture texture could not be encoded.");
  return new Uint8Array(await blob.arrayBuffer());
}

function file(data: Uint8Array | string, name: string, relativePath?: string): File {
  const created = new File([typeof data === "string" ? data : blobPart(data)], name, { lastModified: Date.UTC(2026, 9, 21) });
  if (relativePath) Object.defineProperty(created, "webkitRelativePath", { value: relativePath });
  return created;
}

function triangles(mesh: MeshData): number {
  return Math.floor(mesh.indices.length / 3);
}

// Fixtures and refusals -----------------------------------------------------------------------------------------------

interface Expectation {
  format: ImportFormat;
  sourceApp: SourceApp;
  detectedBy: DetectedBy;
  container: ImportAnalysis["container"];
  title: string;
  textures: number;
}

interface Fixture {
  id: string;
  name: string;
  summary: string;
  expect: Expectation;
  build(): Promise<{ files: File[]; triangles: number }>;
}

const FIXTURES: Fixture[] = [
  {
    id: "glb-blender",
    name: "Liver",
    summary: "One GLB with an embedded PNG texture, written with the generator string of Blender's glTF exporter.",
    expect: { format: "glb", sourceApp: "blender", detectedBy: "metadata", container: "file", title: "Liver", textures: 1 },
    async build() {
      const mesh = liver();
      const png = await tissueTexture(11, "#7b2d26", ["#5c1f1b", "#94443a", "#6b2620"]);
      const glb = meshGlb(mesh, { generator: "Khronos glTF Blender I/O v4.2.70", texture: { mimeType: "image/png", bytes: png }, roughness: 0.42 });
      return { files: [file(glb, "Liver.glb")], triangles: triangles(mesh) };
    },
  },
  {
    id: "gltf-unity",
    name: "Heart",
    summary: "A folder: heart.gltf, its heart.bin and a PNG texture, with the generator string of UnityGLTF.",
    expect: { format: "gltf", sourceApp: "unity", detectedBy: "metadata", container: "selection", title: "heart", textures: 1 },
    async build() {
      const mesh = heart();
      const png = await tissueTexture(23, "#8c2230", ["#6e1a26", "#a3343f", "#d4ad66"]);
      const { json, bin } = meshGltf(mesh, {
        generator: "UnityGltf 2.14.0, Unity 2022.3.20f1, URP",
        bufferUri: "heart.bin",
        texture: { mimeType: "image/png", uri: "textures/heart_baseColor.png" },
        roughness: 0.38,
      });
      return {
        files: [
          file(JSON.stringify(json), "heart.gltf", "Heart/heart.gltf"),
          file(bin, "heart.bin", "Heart/heart.bin"),
          file(png, "heart_baseColor.png", "Heart/textures/heart_baseColor.png"),
        ],
        triangles: triangles(mesh),
      };
    },
  },
  {
    id: "obj-blender",
    name: "Kidney",
    summary: "kidney.obj (Blender 4.4 header comment) selected with kidney.mtl and the PNG it names.",
    expect: { format: "obj", sourceApp: "blender", detectedBy: "metadata", container: "selection", title: "kidney", textures: 1 },
    async build() {
      const mesh = kidney();
      const png = await tissueTexture(37, "#8a3b35", ["#6d2b27", "#a24c43", "#7c332e"]);
      const obj = meshObj(mesh, { comments: ["Blender 4.4.1", "www.blender.org"], mtllib: "kidney.mtl", material: "Kidney" });
      return {
        files: [file(obj, "kidney.obj"), file(mtlText("Kidney", "kidney_diffuse.png", [1, 1, 1]), "kidney.mtl"), file(png, "kidney_diffuse.png")],
        triangles: triangles(mesh),
      };
    },
  },
  {
    id: "stl-binary",
    name: "Femur",
    summary: "A binary STL whose 80-byte header carries the Blender STL exporter's signature; no units or materials.",
    expect: { format: "stl", sourceApp: "blender", detectedBy: "metadata", container: "file", title: "Femur", textures: 0 },
    async build() {
      const mesh = femur();
      return { files: [file(meshStl(mesh, "Exported from Blender-3.3.0"), "Femur.stl")], triangles: triangles(mesh) };
    },
  },
  {
    id: "ply-ascii",
    name: "Lung",
    summary: "An ASCII PLY with normals and per-vertex colours and no header comment, so the source stays unknown.",
    expect: { format: "ply", sourceApp: "unknown", detectedBy: "none", container: "file", title: "Lung", textures: 0 },
    async build() {
      const mesh = lung();
      return { files: [file(meshPly(mesh), "Lung.ply")], triangles: triangles(mesh) };
    },
  },
  {
    id: "fbx-ascii",
    name: "Pancreas",
    summary: "An ASCII FBX 7.4 (normals, UVs, a Phong material with a PNG in a textures folder) last saved by Maya.",
    expect: { format: "fbx", sourceApp: "maya", detectedBy: "metadata", container: "selection", title: "pancreas", textures: 1 },
    async build() {
      const mesh = pancreas();
      const png = await tissueTexture(41, "#ddb088", ["#c99a70", "#ecc7a0", "#d6a47a"]);
      const fbx = meshFbxText(mesh, {
        textureFile: "textures/pancreas_diffuse.png",
        upAxis: 1,
        unitScaleFactor: 1,
        creator: "FBX SDK/FBX Plugins version 2020.3.4",
        original: { vendor: "Autodesk", name: "Maya", version: "2024" },
        lastSaved: { vendor: "Autodesk", name: "Maya", version: "2024" },
      });
      return {
        files: [file(fbx, "pancreas.fbx", "Pancreas/pancreas.fbx"), file(png, "pancreas_diffuse.png", "Pancreas/textures/pancreas_diffuse.png")],
        triangles: triangles(mesh),
      };
    },
  },
  {
    id: "zip-sketchfab",
    name: "Stomach",
    summary: "A Sketchfab-style download: scene.gltf, scene.bin, a texture and a licence file in one zip.",
    expect: { format: "gltf", sourceApp: "sketchfab", detectedBy: "metadata", container: "zip", title: "Stomach", textures: 1 },
    async build() {
      const mesh = stomach();
      const png = await tissueTexture(53, "#d4867c", ["#b8665e", "#e7a39a", "#c97467"]);
      const { json, bin } = meshGltf(mesh, {
        generator: "Sketchfab-12.66.0",
        extras: { title: "Stomach", author: "VISCERA fixtures", license: "CC-BY-4.0" },
        bufferUri: "scene.bin",
        texture: { mimeType: "image/png", uri: "textures/Stomach_baseColor.png" },
        roughness: 0.35,
      });
      const zip = zipOf({ "scene.gltf": JSON.stringify(json), "scene.bin": bin, "textures/Stomach_baseColor.png": png, "license.txt": "CC-BY-4.0 (fixture)" }, 6);
      return { files: [file(zip, "stomach-model.zip")], triangles: triangles(mesh) };
    },
  },
  {
    id: "usdz",
    name: "Bladder",
    summary: "A USDZ whose text root layer names Reality Composer Pro as its creator, with a display colour.",
    expect: { format: "usdz", sourceApp: "reality-composer", detectedBy: "metadata", container: "file", title: "Bladder", textures: 0 },
    async build() {
      const mesh = bladder();
      const usda = meshUsda(mesh, { creator: "Reality Composer Pro Version 2.0 (494.100.6)", upAxis: "Y", metersPerUnit: 1, displayColor: [0.86, 0.6, 0.55] });
      return { files: [file(zipOf({ "bladder.usda": usda }), "Bladder.usdz")], triangles: triangles(mesh) };
    },
  },
];

interface RefusalCase {
  id: string;
  name: string;
  expect: { kind: "rejected" | "choice" | "aborted"; detail: string; code: string };
  options?: Partial<AnalyzeOptions>;
  /** Cancels the import when this stage begins. */
  abortAt?: ImportStage;
  build(): File[];
}

const REFUSALS: RefusalCase[] = [
  {
    id: "blend",
    name: "Blender project",
    expect: { kind: "rejected", detail: "unsupported:blend", code: "invalid_input" },
    build: () => [file(`BLENDER-v402REND${"\u0000".repeat(32)}`, "heart.blend")],
  },
  {
    id: "unitypackage",
    name: "Unity package",
    expect: { kind: "rejected", detail: "unsupported:unitypackage", code: "invalid_input" },
    build: () => [file(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]), "Organs.unitypackage")],
  },
  {
    id: "prefab",
    name: "Unity prefab",
    expect: { kind: "rejected", detail: "unsupported:prefab", code: "invalid_input" },
    build: () => [file("%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &1\nGameObject:\n  m_Name: Liver\n", "Liver.prefab")],
  },
  {
    id: "draco",
    name: "Draco-compressed GLB",
    expect: { kind: "rejected", detail: "unsupported:draco", code: "invalid_input" },
    build: () => [file(cubeGlb({ extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] }), "heart-draco.glb")],
  },
  {
    id: "ktx2",
    name: "KTX2 textures",
    expect: { kind: "rejected", detail: "unsupported:ktx2", code: "invalid_input" },
    build: () => [file(cubeGlb({ extensionsUsed: ["KHR_texture_basisu"], extensionsRequired: ["KHR_texture_basisu"] }), "heart-ktx2.glb")],
  },
  {
    id: "vertices",
    name: "Over 2 million vertices",
    expect: { kind: "rejected", detail: "limit:vertices", code: "limit_reached" },
    build: () => {
      const { json, bin } = cubeGltf();
      (json.accessors as Array<{ count: number }>)[0]!.count = 2_000_001;
      return [file(glbOf(json, bin), "dense.glb")];
    },
  },
  {
    id: "zip-bomb",
    name: "Zip bomb",
    expect: { kind: "rejected", detail: "zip-ratio", code: "limit_reached" },
    build: () => [file(zipOf({ "scene.bin": new Uint8Array(4 * 1024 * 1024) }, 6), "expanding.zip")],
  },
  {
    id: "plan-limit",
    name: "Larger than the plan allows",
    expect: { kind: "rejected", detail: "selection-too-large", code: "file_too_large" },
    options: { maxBytes: 512 },
    build: () => [file(cubeGlb({ size: 2 }), "organ.glb"), file(new Uint8Array(1024), "organ-extra.bin")],
  },
  {
    id: "two-models",
    name: "Two models at once",
    expect: { kind: "choice", detail: "ambiguous-main-file", code: "invalid_input" },
    build: () => [file(cubeGlb(), "left-kidney.glb"), file(cubeGlb({ size: 2 }), "right-kidney.glb")],
  },
  {
    id: "cancelled",
    name: "Cancelled while loading",
    expect: { kind: "aborted", detail: "aborted", code: "aborted" },
    abortAt: "loading",
    build: () => [file(cubeGlb(), "cancelled.glb")],
  },
];

// Checks ----------------------------------------------------------------------------------------------------------------

interface GlbCheck {
  bytes: number;
  loads: boolean;
  meshes: number;
  triangles: number;
  images: string[];
  error: string | null;
}

interface ThumbnailCheck {
  type: string;
  bytes: number;
  width: number;
  height: number;
  /** Share of pixels on an edge (Sobel on luminance): a silhouette or texture detail, not the smooth backdrop. */
  edgeFraction: number;
  url: string;
  dataUrl: string;
}

export interface CheckedImport {
  id: string;
  name: string;
  summary: string;
  ok: boolean;
  problems: string[];
  /** analyzeFiles alone. */
  ms: number;
  /** Writing the fixture files, and checking the preview and thumbnail afterwards. */
  buildMs: number;
  checkMs: number;
  stages: ImportStage[];
  error: { code: string; detail: string | null; reason: string; advice: string | null } | null;
  analysis: Omit<ImportAnalysis, "displayGlb" | "thumbnail" | "original"> | null;
  original: { name: string; mime: string; bytes: number } | null;
  preview: GlbCheck | null;
  previewIsOriginal: boolean;
  thumbnail: ThumbnailCheck | null;
}

export interface CheckedRefusal {
  id: string;
  name: string;
  files: string[];
  ok: boolean;
  kind: "rejected" | "choice" | "aborted" | "other" | "none";
  code: string | null;
  detail: string | null;
  reason: string | null;
  advice: string | null;
  candidates: string[];
  expected: string;
}

export interface ImportsCheckReport {
  done: boolean;
  fixtures: CheckedImport[];
  refusals: CheckedRefusal[];
  dropped: CheckedImport[];
}

declare global {
  interface Window {
    __importsCheck?: ImportsCheckReport;
  }
}

function disposeScene(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) {
          value.dispose();
          const image: unknown = value.image;
          if (image instanceof ImageBitmap) image.close();
        }
      }
      material.dispose();
    }
  });
}

/** Loads a GLB back with three's GLTFLoader, as the viewer will, and measures what it holds. */
async function checkGlb(blob: Blob): Promise<GlbCheck> {
  const buffer = await blob.arrayBuffer();
  let images: string[] = [];
  try {
    const view = new DataView(buffer);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as { images?: Array<{ mimeType?: string }> };
    images = (json.images ?? []).map((image) => image.mimeType ?? "unknown");
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    const measure = measureScene(gltf.scene);
    disposeScene(gltf.scene);
    return { bytes: blob.size, loads: true, meshes: measure.meshes, triangles: measure.triangles, images, error: null };
  } catch (error) {
    return { bytes: blob.size, loads: false, meshes: 0, triangles: 0, images, error: error instanceof Error ? error.message : String(error) };
  }
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The thumbnail could not be read."));
    reader.readAsDataURL(blob);
  });
}

async function checkThumbnail(blob: Blob): Promise<ThumbnailCheck> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to inspect the thumbnail.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, width, height);
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i++) luminance[i] = 0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!;
  let edges = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (dx: number, dy: number) => luminance[(y + dy) * width + x + dx]!;
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      if (Math.abs(gx) + Math.abs(gy) > 60) edges++;
    }
  }
  return { type: blob.type, bytes: blob.size, width, height, edgeFraction: edges / (width * height), url: URL.createObjectURL(blob), dataUrl: await readDataUrl(blob) };
}

function errorSummary(error: unknown): CheckedImport["error"] {
  if (error instanceof ImportRejectedError) return { code: error.code, detail: error.detail, reason: error.reason, advice: error.advice };
  if (isPlatformError(error)) return { code: error.code, detail: error.detail, reason: error.message, advice: null };
  return { code: "unknown", detail: null, reason: error instanceof Error ? error.message : String(error), advice: null };
}

async function checkImport(
  id: string,
  name: string,
  summary: string,
  files: File[],
  expected: (Expectation & { triangles: number }) | null,
  signal: AbortSignal,
  onProgress: (progress: ImportProgress) => void,
): Promise<CheckedImport> {
  const stages: ImportStage[] = [];
  let fraction = 0;
  const started = performance.now();
  const base: CheckedImport = { id, name, summary, ok: false, problems: [], ms: 0, buildMs: 0, checkMs: 0, stages, error: null, analysis: null, original: null, preview: null, previewIsOriginal: false, thumbnail: null };
  let analysis: ImportAnalysis;
  try {
    analysis = await analyzeFiles(files, {
      maxBytes: PLAN_MAX_BYTES,
      signal,
      onProgress: (progress) => {
        if (stages.at(-1) !== progress.stage) stages.push(progress.stage);
        fraction = progress.fraction;
        onProgress(progress);
      },
    });
  } catch (error) {
    if (isPlatformError(error, "aborted") && signal.aborted) throw error;
    const failure = errorSummary(error);
    return { ...base, ms: performance.now() - started, error: failure, problems: [`Refused: ${failure?.reason ?? "unknown error"}`] };
  }
  const ms = performance.now() - started;
  const { displayGlb, thumbnail, original, ...rest } = analysis;
  const previewIsOriginal = displayGlb === null && analysis.format === "glb";
  const problems: string[] = [];
  const preview = displayGlb ? await checkGlb(displayGlb) : previewIsOriginal ? await checkGlb(original) : null;
  let thumbnailCheck: ThumbnailCheck | null = null;
  try {
    thumbnailCheck = thumbnail ? await checkThumbnail(thumbnail) : null;
  } catch (error) {
    problems.push(`The thumbnail could not be decoded: ${error instanceof Error ? error.message : String(error)}.`);
  }

  if (expected) {
    const same = <T,>(label: string, actual: T, wanted: T) => {
      if (actual !== wanted) problems.push(`${label}: expected ${String(wanted)}, got ${String(actual)}.`);
    };
    same("Format", analysis.format, expected.format);
    same("Source", analysis.sourceApp, expected.sourceApp);
    same("Detected by", analysis.detectedBy, expected.detectedBy);
    same("Container", analysis.container, expected.container);
    same("Title", analysis.title, expected.title);
    same("Triangles", analysis.stats.triangles, expected.triangles);
    same("Textures", analysis.stats.textures, expected.textures);
  }
  if (!preview) problems.push("No preview GLB was made.");
  else if (!preview.loads) problems.push(`The preview GLB does not load: ${preview.error ?? "unknown error"}.`);
  else if (preview.triangles !== analysis.stats.triangles) problems.push(`The preview GLB holds ${preview.triangles} triangles, the analysis counted ${analysis.stats.triangles}.`);
  if (!thumbnailCheck) {
    if (!thumbnail) problems.push("No thumbnail was rendered.");
  } else {
    if (thumbnailCheck.width !== 512 || thumbnailCheck.height !== 512) problems.push(`The thumbnail is ${thumbnailCheck.width}×${thumbnailCheck.height}, not 512×512.`);
    if (thumbnailCheck.type !== "image/webp") problems.push(`The thumbnail is ${thumbnailCheck.type}, not WebP.`);
    if (thumbnailCheck.edgeFraction < MIN_EDGE_FRACTION) problems.push("The thumbnail looks blank.");
  }
  if (fraction !== 1) problems.push(`Progress ended at ${fraction}, not 1.`);
  return {
    ...base,
    ok: problems.length === 0,
    problems,
    ms,
    checkMs: performance.now() - started - ms,
    analysis: rest,
    original: { name: analysis.originalName, mime: analysis.originalMime, bytes: original.size },
    preview,
    previewIsOriginal,
    thumbnail: thumbnailCheck,
  };
}

async function checkRefusal(refusal: RefusalCase, signal: AbortSignal): Promise<CheckedRefusal> {
  const files = refusal.build();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  const expected = `${refusal.expect.kind} · ${refusal.expect.detail}`;
  const result: CheckedRefusal = { id: refusal.id, name: refusal.name, files: files.map((entry) => entry.name), ok: false, kind: "none", code: null, detail: null, reason: null, advice: null, candidates: [], expected };
  try {
    await analyzeFiles(files, {
      maxBytes: PLAN_MAX_BYTES,
      ...refusal.options,
      signal: controller.signal,
      onProgress: (progress) => {
        if (refusal.abortAt === progress.stage) controller.abort();
      },
    });
    result.reason = "The files were imported; a refusal was expected.";
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ImportRejectedError) {
      result.kind = error instanceof ImportChoiceError ? "choice" : "rejected";
      result.reason = error.reason;
      result.advice = error.advice;
      if (error instanceof ImportChoiceError) result.candidates = error.candidates;
    } else if (isPlatformError(error, "aborted")) {
      result.kind = "aborted";
      result.reason = error.message;
    } else {
      result.kind = "other";
      result.reason = error instanceof Error ? error.message : String(error);
    }
    if (isPlatformError(error)) {
      result.code = error.code;
      result.detail = error.detail;
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
  result.ok = result.kind === refusal.expect.kind && result.detail === refusal.expect.detail && result.code === refusal.expect.code;
  return result;
}

// Interface -----------------------------------------------------------------------------------------------------------

function grouped(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function sizeLabel(analysis: NonNullable<CheckedImport["analysis"]>): string {
  const box = analysis.stats.bbox;
  if (!box) return "Not measured";
  const value = (n: number) => (n >= 100 ? grouped(Math.round(n)) : String(Number(n.toPrecision(3))));
  return `${value(box.x)} × ${value(box.y)} × ${value(box.z)} ${analysis.stats.units ?? "units (none declared)"}`;
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="px-ic-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultBadge({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <Badge tone={ok ? "success" : "danger"} icon={ok ? CircleCheck : CircleAlert}>
      {label ?? (ok ? "Passed" : "Failed")}
    </Badge>
  );
}

function ImportCard({ result, expectations }: { result: CheckedImport; expectations: boolean }) {
  const titleId = useId();
  const analysis = result.analysis;
  const subtitle = analysis
    ? `${FORMAT_LABEL[analysis.format]} · ${SOURCE_APP_LABEL[analysis.sourceApp]} · ${CONTAINER_LABEL[analysis.container]}`
    : result.error
      ? `Refused · ${result.error.detail ?? result.error.code}`
      : "Not analysed";
  const facts: Array<[string, ReactNode]> = [];
  if (analysis) {
    const stats = analysis.stats;
    facts.push(
      ["Title", analysis.title],
      ["Source", `${SOURCE_APP_LABEL[analysis.sourceApp]}${analysis.sourceDetail ? ` — ${analysis.sourceDetail}` : ""} (${analysis.detectedBy})`],
      ["Geometry", `${formatCount(stats.meshes, "mesh", "meshes")} · ${grouped(stats.vertices)} vertices · ${grouped(stats.triangles)} triangles`],
      ["Materials", `${formatCount(stats.materials, "material")} · ${formatCount(stats.textures, "texture")}${stats.animations ? ` · ${formatCount(stats.animations, "animation")}` : ""}${stats.skinned ? " · skinned" : ""}`],
      ["Size", sizeLabel(analysis)],
    );
    if (result.preview) {
      const loaded = result.preview.loads ? `loads back: ${formatCount(result.preview.meshes, "mesh", "meshes")}, ${grouped(result.preview.triangles)} triangles` : `does not load (${result.preview.error ?? "error"})`;
      const images = result.preview.images.length > 0 ? ` · images ${result.preview.images.map((type) => type.replace("image/", "").toUpperCase()).join(", ")}` : "";
      facts.push(["Preview", `${result.previewIsOriginal ? "The original GLB" : `GLB ${formatBytes(result.preview.bytes)}`} · ${loaded}${images}`]);
    }
    if (result.thumbnail) {
      facts.push(["Thumbnail", `${result.thumbnail.type.replace("image/", "").toUpperCase()} ${result.thumbnail.width} × ${result.thumbnail.height} · ${formatBytes(result.thumbnail.bytes)} · edges ${(result.thumbnail.edgeFraction * 100).toFixed(1)} %`]);
    }
    if (result.original) facts.push(["Original", `${result.original.name} · ${formatBytes(result.original.bytes)} · ${result.original.mime}`]);
    facts.push(["Time", `${(result.ms / 1000).toFixed(2)} s`]);
  } else if (result.error) {
    facts.push(["Reason", result.error.reason]);
    if (result.error.advice) facts.push(["Advice", result.error.advice]);
  }
  const notes = analysis?.notes ?? [];
  return (
    <article className="px-ic-card" aria-labelledby={titleId}>
      <div className="px-ic-thumb">
        {result.thumbnail ? (
          <img src={result.thumbnail.url} alt={`Thumbnail of ${result.name}`} width={512} height={512} decoding="async" />
        ) : (
          <div className="px-ic-thumb__empty">
            <Icon icon={ImageOff} size={28} aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="px-ic-card__body">
        <div className="px-ic-card__head">
          <div className="px-ic-card__titles">
            <h3 id={titleId} className="px-ic-card__title px-truncate">
              {result.name}
            </h3>
            <p className="px-subheadline px-secondary px-truncate">{subtitle}</p>
          </div>
          {expectations || !result.ok ? <ResultBadge ok={result.ok} /> : <ResultBadge ok label="Analysed" />}
        </div>
        {result.summary ? <p className="px-footnote px-secondary">{result.summary}</p> : null}
        <Facts items={facts} />
        {result.problems.length > 0 ? (
          <ul className="px-ic-list px-ic-list--problems" aria-label={`Problems with ${result.name}`}>
            {result.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {notes.length > 0 ? (
          <ul className="px-ic-list" aria-label={`Notes on ${result.name}`}>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

function RefusalRow({ result }: { result: CheckedRefusal }) {
  return (
    <li className="px-ic-row">
      <div className="px-ic-row__name">
        <span className="px-body px-em">{result.name}</span>
        <span className="px-ic-code">{result.files.join(", ")}</span>
      </div>
      <div className="px-ic-row__text">
        <span className="px-body">{result.reason ?? "—"}</span>
        {result.advice ? <span className="px-subheadline px-secondary">{result.advice}</span> : null}
        {result.candidates.length > 0 ? <span className="px-subheadline px-secondary">Candidates: {result.candidates.join(", ")}</span> : null}
      </div>
      <div className="px-ic-row__name">
        <ResultBadge ok={result.ok} />
        <span className="px-ic-code">
          {result.code ?? "none"} · {result.detail ?? "no detail"}
        </span>
      </div>
    </li>
  );
}

interface RunState {
  running: boolean;
  label: string;
  value: number;
  /** Set when the run is over: every check passed or not. */
  passed?: boolean | undefined;
}

/** ?theme=light|dark|system for screenshots and reviews, as px-gallery.html. */
function ThemeFromQuery() {
  const { setAppearance } = usePx();
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") setAppearance({ theme });
  }, [setAppearance]);
  return null;
}

function ImportsCheckApp() {
  const [fixtures, setFixtures] = useState<CheckedImport[]>([]);
  const [refusals, setRefusals] = useState<CheckedRefusal[]>([]);
  const [dropped, setDropped] = useState<CheckedImport[]>([]);
  const [run, setRun] = useState<RunState>({ running: true, label: "Preparing fixtures…", value: 0 });
  const [runId, setRunId] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const urls = useRef<string[]>([]);
  const report = useRef<ImportsCheckReport>({ done: false, fixtures: [], refusals: [], dropped: [] });

  const publish = useCallback((patch: Partial<ImportsCheckReport>) => {
    report.current = { ...report.current, ...patch };
    window.__importsCheck = report.current;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    for (const url of urls.current.splice(0)) URL.revokeObjectURL(url);
    setFixtures([]);
    setRefusals([]);
    publish({ done: false, fixtures: [], refusals: [] });
    const total = FIXTURES.length + REFUSALS.length;
    const started = performance.now();
    void (async () => {
      const checked: CheckedImport[] = [];
      for (const [index, fixture] of FIXTURES.entries()) {
        if (signal.aborted) return;
        setRun({ running: true, label: `${fixture.name}: writing the fixture files`, value: index / total });
        const buildStarted = performance.now();
        const built = await fixture.build();
        const buildMs = performance.now() - buildStarted;
        const result = await checkImport(fixture.id, fixture.name, fixture.summary, built.files, { ...fixture.expect, triangles: built.triangles }, signal, (progress) => {
          setRun({ running: true, label: `${fixture.name}: ${STAGE_LABEL[progress.stage]}`, value: (index + progress.fraction) / total });
        }).catch((error: unknown) => {
          if (signal.aborted) return null;
          throw error;
        });
        if (!result || signal.aborted) return;
        result.buildMs = buildMs;
        if (result.thumbnail) urls.current.push(result.thumbnail.url);
        checked.push(result);
        setFixtures([...checked]);
        publish({ fixtures: [...checked] });
      }
      const refused: CheckedRefusal[] = [];
      for (const [index, refusal] of REFUSALS.entries()) {
        if (signal.aborted) return;
        setRun({ running: true, label: `Refusal: ${refusal.name}`, value: (FIXTURES.length + index) / total });
        const result = await checkRefusal(refusal, signal).catch((error: unknown) => {
          if (signal.aborted) return null;
          throw error;
        });
        if (!result || signal.aborted) return;
        refused.push(result);
        setRefusals([...refused]);
        publish({ refusals: [...refused] });
      }
      const passed = checked.filter((result) => result.ok).length + refused.filter((result) => result.ok).length;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      setRun({ running: false, label: `${passed} of ${total} checks passed in ${seconds} s`, value: 1, passed: passed === total });
      publish({ done: true });
    })();
    return () => controller.abort();
  }, [runId, publish]);

  useEffect(() => () => {
    for (const url of urls.current.splice(0)) URL.revokeObjectURL(url);
  }, []);

  const analyseSelection = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const name = files.length === 1 ? (files[0]?.name ?? "File") : `${files[0]?.name ?? "File"} and ${files.length - 1} more`;
      const result = await checkImport(`dropped-${Date.now()}`, name, "", files, null, new AbortController().signal, () => undefined);
      if (result.thumbnail) urls.current.push(result.thumbnail.url);
      setDropped((current) => {
        const next = [result, ...current];
        publish({ dropped: next });
        return next;
      });
    },
    [publish],
  );

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDragging(false);
      void analyseSelection(Array.from(event.dataTransfer.files));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [analyseSelection]);

  const fixturesPassed = fixtures.filter((result) => result.ok).length;
  const refusalsPassed = refusals.filter((result) => result.ok).length;
  const subtitle = run.running ? "Running…" : `${fixturesPassed} of ${FIXTURES.length} Fixtures · ${refusalsPassed} of ${REFUSALS.length} Refusals Passed`;

  return (
    <AppLayout
      contentLabel="Import check results"
      toolbar={
        <Toolbar
          title="Import Check"
          subtitle={subtitle}
          trailing={
            <>
              <Button variant="bordered" size="toolbar" icon={RotateCw} disabled={run.running} onClick={() => setRunId((id) => id + 1)}>
                Run Again
              </Button>
              <Button variant="borderedProminent" size="toolbar" icon={FileUp} onClick={() => inputRef.current?.click()}>
                Analyze Files…
              </Button>
            </>
          }
        />
      }
    >
      <div className="px-ic">
        <header className="px-ic-intro">
          <p className="px-ic-intro__eyebrow">Development Check · Imports</p>
          <p className="px-large-title px-em">3D Import Analysis</p>
          <p className="px-ic-intro__lede">
            Each fixture is written in this browser and passed to analyzeFiles exactly as a person&rsquo;s files would be. Every preview GLB is loaded back with
            GLTFLoader, and every thumbnail is checked for a 512 × 512 WebP with visible detail. Refusals must carry a reason and advice.
          </p>
        </header>

        <div className="px-ic-status" aria-live="polite">
          {run.running ? (
            <ProgressBar value={run.value} label={run.label} showValue aria-label="Import check progress" />
          ) : (
            <p className="px-ic-done px-body" data-ok={run.passed || undefined}>
              <Icon icon={run.passed ? CircleCheck : CircleAlert} size={18} aria-hidden="true" />
              <span>{run.label}</span>
            </p>
          )}
        </div>

        <section className="px-ic-section" aria-labelledby="px-ic-fixtures">
          <div className="px-ic-section__header">
            <h2 id="px-ic-fixtures" className="px-ic-section__title">
              Fixtures
            </h2>
            <span className="px-subheadline px-ic-section__count px-num">
              {fixtures.length} of {FIXTURES.length}
            </span>
          </div>
          <div className="px-ic-grid">
            {fixtures.map((result) => (
              <ImportCard key={result.id} result={result} expectations />
            ))}
          </div>
        </section>

        <section className="px-ic-section" aria-labelledby="px-ic-refusals">
          <div className="px-ic-section__header">
            <h2 id="px-ic-refusals" className="px-ic-section__title">
              Refusals
            </h2>
            <span className="px-subheadline px-ic-section__count px-num">
              {refusals.length} of {REFUSALS.length}
            </span>
          </div>
          {refusals.length > 0 ? (
            <ul className="px-ic-panel">
              {refusals.map((result) => (
                <RefusalRow key={result.id} result={result} />
              ))}
            </ul>
          ) : null}
        </section>

        <section className="px-ic-section" aria-labelledby="px-ic-yours">
          <div className="px-ic-section__header">
            <h2 id="px-ic-yours" className="px-ic-section__title">
              Your Files
            </h2>
          </div>
          <div className="px-ic-drop" data-active={dragging || undefined}>
            <Icon icon={Import} size={22} aria-hidden="true" />
            <span className="px-body">Drop 3D files anywhere on this page, or choose Analyze Files…, to run the same analysis on them. Nothing is uploaded.</span>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            aria-label="Choose 3D files to analyze"
            onChange={(event) => {
              const chosen = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void analyseSelection(chosen);
            }}
          />
          {dropped.length > 0 ? (
            <div className="px-ic-grid">
              {dropped.map((result) => (
                <ImportCard key={result.id} result={result} expectations={false} />
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </AppLayout>
  );
}

const container = document.getElementById("px-imports-check-root");
if (!container) throw new Error("px-imports-check.html is missing #px-imports-check-root");
createRoot(container).render(
  <StrictMode>
    <PxProvider route="app">
      <ThemeFromQuery />
      <ImportsCheckApp />
    </PxProvider>
  </StrictMode>,
);
