// The generic mesh writers of __fixtures__/builders.ts read back by the product loaders. The browser check
// (px-imports-check.html) builds its fixtures with these writers, so they must produce what the loaders expect:
// counts, normals, UVs, colours and materials. Also covers the neutral clay for material-less OBJ/FBX and flat normals
// for meshes that arrive without any.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  bytesOf,
  meshFbxText,
  meshGlb,
  meshGltf,
  meshObj,
  meshPly,
  meshStl,
  meshUsda,
  mtlText,
  NodeProgressEvent,
  tga2x2,
  zipOf,
  type MeshData,
} from "./__fixtures__/builders";
import { detectSource } from "./detect";
import { importBudget } from "./limits";
import { loadModel, type LoadedModel } from "./loaders";
import { prepareDisplay } from "./normalize";
import { FileSet, type FileEntry } from "./paths";
import { ImportResources } from "./resources";
import type { ModelFormat } from "./sniff";
import { measureScene } from "./stats";

const opened: ImportResources[] = [];

beforeAll(() => {
  if (typeof ProgressEvent === "undefined") vi.stubGlobal("ProgressEvent", NodeProgressEvent);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const resources of opened.splice(0)) resources.dispose();
});

/** A UV sphere: 221 vertices (seam and pole duplicates included), 352 triangles. */
function ball(): MeshData {
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  const mesh: MeshData = {
    name: "Ball",
    positions: Float32Array.from(geometry.getAttribute("position").array),
    normals: Float32Array.from(geometry.getAttribute("normal").array),
    uvs: Float32Array.from(geometry.getAttribute("uv").array),
    indices: Uint32Array.from(geometry.index!.array),
  };
  geometry.dispose();
  return mesh;
}

/** Distinct positions (-0 is 0), optionally as written in text with 6 decimals. */
function distinctPositions(mesh: MeshData, decimals?: number): number {
  const seen = new Set<string>();
  const show = (value: number) => String(decimals === undefined ? value : Number(value.toFixed(decimals)));
  for (let i = 0; i < mesh.positions.length; i += 3) seen.add(`${show(mesh.positions[i]!)},${show(mesh.positions[i + 1]!)},${show(mesh.positions[i + 2]!)}`);
  return seen.size;
}

const entry = (path: string, data: Uint8Array | string): FileEntry => ({ path, bytes: typeof data === "string" ? bytesOf(data) : data });

async function load(format: ModelFormat, main: FileEntry, others: FileEntry[] = []): Promise<{ model: LoadedModel; resources: ImportResources }> {
  const resources = new ImportResources();
  opened.push(resources);
  const model = await loadModel({ main, format, files: new FileSet([main, ...others]), resources, budget: importBudget() });
  return { model, resources };
}

function firstMesh(root: THREE.Object3D): THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
  const mesh = root.getObjectByProperty("isMesh", true);
  if (!(mesh instanceof THREE.Mesh)) throw new Error("no mesh");
  return mesh as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
}

describe("generic mesh writers through the loaders", () => {
  const mesh = ball();

  it("GLB keeps indexed vertices, normals and UVs, and the generator", async () => {
    const { model } = await load("glb", entry("ball.glb", meshGlb(mesh, { generator: "Khronos glTF Blender I/O v4.2.70", baseColor: [0.8, 0.3, 0.3, 1] })));
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, vertices: 221, triangles: 352, materials: 1 });
    const loaded = firstMesh(model.root);
    expect(loaded.geometry.hasAttribute("normal") && loaded.geometry.hasAttribute("uv")).toBe(true);
    // glTF stores v down and GLTFLoader keeps it so (its textures are not flipped).
    expect(loaded.geometry.getAttribute("uv").getY(0)).toBeCloseTo(1 - mesh.uvs![1]!);
    expect(detectSource(model.signals)).toMatchObject({ sourceApp: "blender", detectedBy: "metadata" });
  });

  it(".gltf with a separate .bin resolves the buffer from the selection", async () => {
    const { json, bin } = meshGltf(mesh, { bufferUri: "ball.bin", generator: "UnityGltf 2.14.0, Unity 2022.3.20f1, URP" });
    const { model } = await load("gltf", entry("Ball/ball.gltf", JSON.stringify(json)), [entry("Ball/ball.bin", bin)]);
    expect(measureScene(model.root)).toMatchObject({ vertices: 221, triangles: 352 });
    expect(detectSource(model.signals).sourceApp).toBe("unity");
  });

  it("OBJ with an MTL and a texture keeps the material and the map", async () => {
    const obj = meshObj(mesh, { comments: ["Blender 4.4.1", "www.blender.org"], mtllib: "ball.mtl", material: "Tissue" });
    const { model } = await load("obj", entry("ball.obj", obj), [entry("ball.mtl", mtlText("Tissue", "textures/ball.tga", [1, 1, 1])), entry("textures/ball.tga", tga2x2())]);
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, vertices: distinctPositions(mesh, 6), triangles: 352, textures: 1 });
    const material = firstMesh(model.root).material as THREE.MeshPhongMaterial;
    expect(material.name).toBe("Tissue");
    expect(material.map?.image).toMatchObject({ width: 2, height: 2 });
    expect(detectSource(model.signals)).toMatchObject({ sourceApp: "blender", sourceDetail: "Blender 4.4.1" });
  });

  it("OBJ without a material library is shown in the neutral clay, smooth as written", async () => {
    const { model } = await load("obj", entry("ball.obj", meshObj(mesh)));
    const material = firstMesh(model.root).material;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).toMatchObject({ flatShading: false, metalness: 0 });
  });

  it("binary STL and ASCII PLY (with vertex colours) keep every triangle", async () => {
    const stl = await load("stl", entry("ball.stl", meshStl(mesh, "Exported from Blender-3.3.0")));
    expect(measureScene(stl.model.root)).toMatchObject({ triangles: 352, vertices: distinctPositions(mesh) });
    const colors = Float32Array.from({ length: mesh.positions.length }, (_, i) => (i % 3 === 0 ? 0.9 : 0.4));
    const ply = await load("ply", entry("ball.ply", meshPly({ ...mesh, colors }, { comments: ["Created in Blender version 4.2.0"] })));
    expect(measureScene(ply.model.root)).toMatchObject({ triangles: 352, vertices: 221 });
    const material = firstMesh(ply.model.root).material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    expect(detectSource(ply.model.signals).sourceApp).toBe("blender");
  });

  it("ASCII FBX keeps normals, UVs and a selected texture, with units and the saving application", async () => {
    const fbx = meshFbxText(mesh, {
      textureFile: "textures/ball.tga",
      upAxis: 1,
      unitScaleFactor: 1,
      creator: "FBX SDK/FBX Plugins version 2020.3.4",
      lastSaved: { vendor: "Autodesk", name: "Maya", version: "2024" },
    });
    const { model } = await load("fbx", entry("Ball/ball.fbx", fbx), [entry("Ball/textures/ball.tga", tga2x2())]);
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, triangles: 352, textures: 1 });
    const loaded = firstMesh(model.root);
    expect(loaded.geometry.hasAttribute("normal") && loaded.geometry.hasAttribute("uv")).toBe(true);
    expect((loaded.material as THREE.MeshPhongMaterial).map?.image).toMatchObject({ width: 2, height: 2 });
    expect(model).toMatchObject({ units: "cm", toMetres: 0.01, upAxis: "Y" });
    expect(detectSource(model.signals)).toMatchObject({ sourceApp: "maya", sourceDetail: "Maya 2024" });
  });

  it("ASCII FBX without normals or materials gets the clay and flat normals for the preview", async () => {
    const { model, resources } = await load("fbx", entry("bare.fbx", meshFbxText({ ...mesh, normals: undefined, uvs: undefined })));
    const loaded = firstMesh(model.root);
    expect(loaded.geometry.hasAttribute("normal")).toBe(false);
    const display = prepareDisplay(model, resources);
    expect(loaded.geometry.hasAttribute("normal")).toBe(true);
    expect(display.notes).toContain("The file has no normals for some meshes; the preview shades them flat.");
    // The mesh has a material record of its own (the writer always adds one), so it keeps Phong turned PBR.
    expect(loaded.material).toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  it("USDZ from a USDA mesh keeps its triangles, units and display colour", async () => {
    const usda = meshUsda(mesh, { creator: "Reality Composer Pro Version 2.0 (494.100.6)", upAxis: "Y", metersPerUnit: 1, displayColor: [0.8, 0.4, 0.35] });
    const { model } = await load("usdz", entry("ball.usdz", zipOf({ "ball.usda": usda })));
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, triangles: 352 });
    expect(model).toMatchObject({ units: "m", upAxis: "Y" });
    const material = firstMesh(model.root).material as THREE.MeshStandardMaterial;
    expect(material.color.r).toBeGreaterThan(material.color.b);
    expect(detectSource(model.signals).sourceApp).toBe("reality-composer");
  });
});

describe("material placeholders", () => {
  it("swaps FBXLoader's default material for the clay, keeping vertex colours off", async () => {
    // The writer always declares a material; drop it to get FBXLoader's own placeholder.
    const text = meshFbxText(ball()).replace(/\tMaterial: 2003[\s\S]*?\n\t\}\n/, "").replace('\tC: "OO",2003,2002\n', "");
    const { model } = await load("fbx", entry("bare.fbx", text));
    const material = firstMesh(model.root).material;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.name).toBe("");
    expect((material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
  });
});
