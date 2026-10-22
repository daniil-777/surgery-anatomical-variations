// The format loaders and scene statistics, run in node with three.js's own loaders. Image decoding for PNG/JPEG
// textures needs a browser (three's ImageLoader creates <img>), so texture paths here use TGA, which three decodes in
// JavaScript; PNG/JPEG decoding, WebGL thumbnails and texture export are covered by the browser end-to-end tests.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  bytesOf,
  cubeGlb,
  cubeGltf,
  cubeGltfEmbedded,
  fbxBinary,
  fbxText,
  glbOf,
  mtlText,
  NodeProgressEvent,
  objText,
  plyAscii,
  plyBinaryLittleEndian,
  pngHeader,
  stlAscii,
  stlBinary,
  TETRA_TRIANGLES,
  tga2x2,
  usdaLayer,
  zipOf,
  type FbxOptions,
} from "./__fixtures__/builders";
import { isPlatformError, type JsonObject } from "../types";
import { detectSource } from "./detect";
import { importBudget } from "./limits";
import { countObj, loadModel, type LoadedModel } from "./loaders";
import { FileSet, type FileEntry } from "./paths";
import { ImportResources } from "./resources";
import type { ModelFormat } from "./sniff";
import { checkSceneLimits, distinctPositions, measureScene, toImportStats, type SceneMeasure } from "./stats";

const opened: ImportResources[] = [];

beforeAll(() => {
  if (typeof ProgressEvent === "undefined") vi.stubGlobal("ProgressEvent", NodeProgressEvent);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const resources of opened.splice(0)) resources.dispose();
  vi.restoreAllMocks();
});

async function load(format: ModelFormat, main: FileEntry, others: FileEntry[] = []): Promise<LoadedModel> {
  const resources = new ImportResources();
  opened.push(resources);
  return loadModel({ main, format, files: new FileSet([main, ...others]), resources, budget: importBudget() });
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; detail: string | null; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isPlatformError(error)) return { code: error.code, detail: error.detail, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const entry = (path: string, data: Uint8Array | string): FileEntry => ({ path, bytes: typeof data === "string" ? bytesOf(data) : data });

/** three's FileLoader passes a Request to fetch. */
const requestedUrl = (input: unknown): string => (input instanceof Request ? input.url : String(input));

describe("glTF and GLB", () => {
  it("loads a GLB and measures it", async () => {
    const model = await load("glb", entry("cube.glb", cubeGlb({ generator: "Khronos glTF Blender I/O v4.2.70", size: 2 })));
    const measure = measureScene(model.root);
    expect(measure).toMatchObject({ meshes: 1, vertices: 8, triangles: 12, materials: 1, textures: 0, skinned: false, bbox: { x: 2, y: 2, z: 2 } });
    expect(model).toMatchObject({ units: "m", upAxis: "Y", uprightX: 0, toMetres: 1 });
    expect(model.signals.gltf?.generator).toBe("Khronos glTF Blender I/O v4.2.70");
  });

  it("loads a .gltf with its .bin through blob URLs only, never the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { json, bin } = cubeGltf({ bufferUri: "buffers/scene.bin" });
    const model = await load("gltf", entry("Heart/scene.gltf", JSON.stringify(json)), [entry("Heart/buffers/scene.bin", bin)]);
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, triangles: 12 });
    expect(fetchSpy).toHaveBeenCalled();
    for (const [input] of fetchSpy.mock.calls) expect(requestedUrl(input)).toMatch(/^(blob|data):/);
  });

  it("refuses a .gltf whose .bin was not selected, or that loads geometry from the web", async () => {
    const { json } = cubeGltf({ bufferUri: "scene.bin" });
    expect(await refusal(load("gltf", entry("scene.gltf", JSON.stringify(json))))).toMatchObject({ detail: "gltf-missing-buffer", message: expect.stringMatching(/scene\.bin/) });
    const remote = cubeGltf({ bufferUri: "https://example.com/scene.bin" });
    expect(await refusal(load("gltf", entry("scene.gltf", JSON.stringify(remote.json))))).toMatchObject({ detail: "gltf-remote-buffer" });
  });

  it("leaves out textures that were not selected, with a note, without requesting them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const embedded = JSON.parse(cubeGltfEmbedded()) as JsonObject;
    embedded.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 0, 0, 1] } }];
    embedded.textures = [{ source: 0 }];
    embedded.images = [{ uri: "textures/albedo.png" }];
    ((embedded.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.material = 0;
    const model = await load("gltf", entry("scene.gltf", JSON.stringify(embedded)));
    expect(model.notes.join(" ")).toMatch(/Textures referenced but not included.*albedo\.png/);
    const mesh = model.root.getObjectByProperty("isMesh", true) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(mesh.material.map).toBeNull();
    expect(mesh.material.color.r).toBeCloseTo(1);
    for (const [input] of fetchSpy.mock.calls) expect(requestedUrl(input)).toMatch(/^(blob|data):/);
  });

  it("refuses oversized textures from their header, before decoding", async () => {
    const { json, bin } = cubeGltf();
    const png = pngHeader(10000, 16);
    const withImage = new Uint8Array(bin.length + png.length + 3);
    withImage.set(bin);
    withImage.set(png, bin.length);
    json.bufferViews = [...(json.bufferViews as JsonObject[]), { buffer: 0, byteOffset: bin.length, byteLength: png.length }];
    json.images = [{ bufferView: 2, mimeType: "image/png" }];
    (json.buffers as JsonObject[])[0]!.byteLength = withImage.length;
    expect(await refusal(load("glb", entry("big.glb", glbOf(json, withImage))))).toMatchObject({ code: "limit_reached", detail: "limit:image-size" });
  });

  it("refuses more vertices than the limit from the accessors, before three.js allocates", async () => {
    const { json, bin } = cubeGltf();
    (json.accessors as JsonObject[])[0]!.count = 2_500_000;
    expect(await refusal(load("glb", entry("huge.glb", glbOf(json, bin))))).toMatchObject({ code: "limit_reached", detail: "limit:vertices" });
  });
});

describe("FBX", () => {
  const mesh: FbxOptions = { mesh: true, creator: "Blender (stable FBX IO) - 4.2.0 - 5.12.3", lastSaved: { vendor: "Blender Foundation", name: "Blender (stable FBX IO)", version: "4.2.0" } };

  it.each([7400, 7500])("loads binary FBX %i with units and axes from GlobalSettings", async (version) => {
    const model = await load("fbx", entry("quad.fbx", fbxBinary({ ...mesh, version, upAxis: 1, unitScaleFactor: 1 })));
    const measure = measureScene(model.root);
    expect(measure).toMatchObject({ meshes: 1, vertices: 4, triangles: 2, bbox: { x: 10, y: 10, z: 0 } });
    expect(model).toMatchObject({ units: "cm", upAxis: "Y", toMetres: 0.01, uprightX: 0 });
    expect(model.signals.fbx?.lastSaved.name).toBe("Blender (stable FBX IO)");
  });

  it("loads text FBX", async () => {
    const model = await load("fbx", entry("quad.fbx", fbxText({ ...mesh, upAxis: 1, unitScaleFactor: 100 })));
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, vertices: 4, triangles: 2 });
    expect(model).toMatchObject({ units: "m", toMetres: 1 });
  });

  it("stands Z-up files upright the way three's FBXLoader does", async () => {
    const model = await load("fbx", entry("quad.fbx", fbxBinary({ ...mesh, upAxis: 2, unitScaleFactor: 1 })));
    expect(model.upAxis).toBe("Z");
    expect(measureScene(model.root).bbox).toEqual({ x: 10, y: 0, z: 10 });
  });

  it("decodes a selected texture through the import's own texture loader", async () => {
    const model = await load("fbx", entry("model/quad.fbx", fbxBinary({ ...mesh, textureFile: "wood.tga" })), [entry("model/textures/wood.tga", tga2x2())]);
    const measure = measureScene(model.root);
    expect(measure.textures).toBe(1);
    const quad = model.root.getObjectByProperty("isMesh", true) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
    expect(quad.material.map?.image).toMatchObject({ width: 2, height: 2 });
    expect(model.notes).toEqual([]);
  });

  it("names textures that were not selected and removes them from the material", async () => {
    const model = await load("fbx", entry("quad.fbx", fbxBinary({ ...mesh, textureFile: "C:\\Users\\ada\\maps\\wood.png" })));
    expect(model.notes).toEqual(["Textures referenced but not included, so the preview leaves them out: wood.png."]);
    const quad = model.root.getObjectByProperty("isMesh", true) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
    expect(quad.material.map).toBeNull();
    expect(measureScene(model.root).textures).toBe(0);
  });
});

describe("OBJ + MTL", () => {
  it("counts vertex records, triangles and material libraries without parsing", () => {
    expect(countObj(objText({ mtllib: "quad.mtl" }))).toEqual({ vertices: 4, triangles: 2, libraries: ["quad.mtl"] });
  });

  it("loads OBJ with its MTL and texture", async () => {
    const model = await load("obj", entry("quad.obj", objText({ mtllib: "quad.mtl", material: "Paint", comments: ["Blender 4.4.1", "www.blender.org"] })), [
      entry("quad.mtl", mtlText("Paint", "maps/wood.tga")),
      entry("maps/wood.tga", tga2x2()),
    ]);
    const measure = measureScene(model.root);
    expect(measure).toMatchObject({ meshes: 1, vertices: 4, triangles: 2, materials: 1, textures: 1 });
    const quad = model.root.getObjectByProperty("isMesh", true) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
    expect(quad.material.name).toBe("Paint");
    expect(quad.material.color.r).toBeGreaterThan(quad.material.color.g);
    expect(model.notes).toEqual([]);
  });

  it("notes a missing MTL file and missing textures", async () => {
    const withoutMtl = await load("obj", entry("quad.obj", objText({ mtllib: "quad.mtl", material: "Paint" })));
    expect(withoutMtl.notes).toEqual(["Material libraries not included, so neutral materials are shown: quad.mtl."]);
    const withoutTexture = await load("obj", entry("quad.obj", objText({ mtllib: "quad.mtl", material: "Paint" })), [entry("quad.mtl", mtlText("Paint", "wood.png"))]);
    expect(withoutTexture.notes).toEqual(["Textures referenced but not included, so the preview leaves them out: wood.png."]);
  });

  it("reads a unit statement from the header", async () => {
    const model = await load("obj", entry("quad.obj", objText({ comments: ["This file uses centimeters as units for non-parametric coordinates."] })));
    expect(model).toMatchObject({ units: "cm", toMetres: 0.01 });
  });

  it("refuses more triangles than the limit before parsing", async () => {
    const text = `v 0 0 0\nv 1 0 0\nv 0 1 0\n${"f 1 2 3\n".repeat(2_000_001)}`;
    expect(await refusal(load("obj", entry("big.obj", text)))).toMatchObject({ code: "limit_reached", detail: "limit:triangles" });
  });
});

describe("STL and PLY", () => {
  it.each([
    ["binary", stlBinary(TETRA_TRIANGLES, "Exported from Blender-3.3.0")],
    ["text", bytesOf(stlAscii(TETRA_TRIANGLES, "tetra"))],
  ])("loads %s STL, counting distinct vertices, shown Z-up", async (_kind, bytes) => {
    const model = await load("stl", entry("tetra.stl", bytes));
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, vertices: 4, triangles: 4, materials: 1 });
    expect(model).toMatchObject({ upAxis: "Z", uprightX: -Math.PI / 2, units: undefined, toMetres: null });
    expect(model.notes[0]).toMatch(/no units, materials or textures/);
  });

  it("loads PLY meshes (text and binary) and point clouds", async () => {
    const mesh = await load("ply", entry("quad.ply", plyAscii({ comments: ["Created in Blender version 4.2.0"] })));
    expect(measureScene(mesh.root)).toMatchObject({ meshes: 1, vertices: 4, triangles: 2 });
    expect(mesh.signals.ply).toMatch(/Created in Blender version 4\.2\.0/);
    const binary = await load("ply", entry("tri.ply", plyBinaryLittleEndian()));
    expect(measureScene(binary.root)).toMatchObject({ meshes: 1, vertices: 3, triangles: 1 });
    const cloud = await load("ply", entry("scan.ply", plyAscii({ faces: false, colors: true })));
    expect(measureScene(cloud.root)).toMatchObject({ meshes: 1, pointClouds: 1, vertices: 4, triangles: 0 });
    expect(cloud.notes).toEqual(["Point cloud: 4 points and no faces."]);
  });
});

describe("USDZ", () => {
  it("loads a USDZ with its layer metadata (units scaled to metres, Z-up stood upright by the loader)", async () => {
    const usdz = zipOf({ "model.usda": usdaLayer({ creator: "Reality Composer Pro Version 2.0 (494.100.6)", metersPerUnit: 0.01, upAxis: "Z" }) });
    const model = await load("usdz", entry("room.usdz", usdz));
    expect(model).toMatchObject({ units: "m", upAxis: "Z", toMetres: 1 });
    expect(model.signals.usd?.creator).toBe("Reality Composer Pro Version 2.0 (494.100.6)");
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, triangles: 2, bbox: { x: 1, y: 0, z: 1 } });
  });

  it("assumes centimetres when metersPerUnit is not authored", async () => {
    const model = await load("usdz", entry("room.usdz", zipOf({ "model.usda": usdaLayer({ upAxis: "Y" }) })));
    expect(model).toMatchObject({ units: "cm", upAxis: "Y", toMetres: 0.01 });
    expect(measureScene(model.root).bbox).toEqual({ x: 100, y: 100, z: 0 });
  });

  it("reads a binary crate layer written by Blender 5.2 (doc, up axis, units) and loads it", async () => {
    // A 2 KB package exported with Blender 5.2.2 (default cube, no material): the crate path needs a real writer.
    const bytes = new Uint8Array(readFileSync(new URL("./__fixtures__/blender-5.2-cube.usdz", import.meta.url)));
    const model = await load("usdz", entry("cube.usdz", bytes));
    expect(model.signals.usd).toEqual({ creator: null, doc: "Blender v5.2.2 LTS", upAxis: "Z", metersPerUnit: 1, error: null });
    expect(model).toMatchObject({ units: "m", upAxis: "Z", toMetres: 1 });
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, vertices: 8, triangles: 12, bbox: { x: 2, y: 2, z: 2 } });
    expect(detectSource(model.signals)).toMatchObject({ sourceApp: "blender", detectedBy: "metadata", sourceDetail: "Blender v5.2.2 LTS" });
  });

  it("lifts a root layer kept in a folder to the top of the package", async () => {
    const usdz = zipOf({ "scene/model.usda": usdaLayer({ doc: "Blender v4.2.0", upAxis: "Y", metersPerUnit: 1 }), "scene/textures/a.png": pngHeader(2, 2) });
    const model = await load("usdz", entry("nested.usdz", usdz));
    expect(model.signals.usd?.doc).toBe("Blender v4.2.0");
    expect(measureScene(model.root)).toMatchObject({ meshes: 1, triangles: 2 });
  });
});

describe("scene measurements", () => {
  it("counts distinct positions of non-indexed geometry", () => {
    const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    expect(distinctPositions(geometry.getAttribute("position"))).toBe(4);
    const interleaved = new THREE.InterleavedBuffer(new Float32Array([0, 0, 0, 9, 1, 0, 0, 9, 0, 0, 0, 9]), 4);
    expect(distinctPositions(new THREE.InterleavedBufferAttribute(interleaved, 3, 0))).toBe(2);
    expect(distinctPositions(new THREE.Float32BufferAttribute([0, 0, 0, -0, 0, -0, 1, 0, 0], 3))).toBe(2);
    geometry.dispose();
  });

  it("counts instances, point clouds, skinning, images and size", () => {
    const root = new THREE.Group();
    const box = new THREE.BoxGeometry(2, 4, 6);
    const texture = new THREE.DataTexture(new Uint8Array(4 * 16), 4, 4);
    const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
    const instanced = new THREE.InstancedMesh(box, material, 3);
    for (let i = 0; i < 3; i++) instanced.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 10, 0, 0));
    root.add(instanced);
    const points = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1], 3)), new THREE.PointsMaterial());
    root.add(points);
    const bones = [new THREE.Bone()];
    const skinnedGeometry = new THREE.BoxGeometry(1, 1, 1);
    const skinIndex = new Uint16Array(skinnedGeometry.getAttribute("position").count * 4);
    const skinWeight = new Float32Array(skinnedGeometry.getAttribute("position").count * 4).fill(0.25);
    skinnedGeometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    skinnedGeometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    const skinned = new THREE.SkinnedMesh(skinnedGeometry, material);
    skinned.add(bones[0]!);
    skinned.bind(new THREE.Skeleton(bones));
    root.add(skinned);
    const measure = measureScene(root);
    expect(measure).toMatchObject({ meshes: 3, pointClouds: 1, skinned: true, materials: 2, textures: 1, largestImage: { width: 4, height: 4 } });
    expect(measure.vertices).toBe(24 * 3 + 2 + 24);
    expect(measure.triangles).toBe(12 * 3 + 12);
    expect(measure.bbox?.x).toBeCloseTo(22);
    const stats = toImportStats(measure, { animations: 2, units: "m", notes: [] });
    expect(stats).toEqual({ meshes: 3, vertices: 98, triangles: 48, materials: 2, textures: 1, animations: 2, skinned: true, bbox: measure.bbox, units: "m" });
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
  });

  it("refuses scenes over the limits and empty scenes", () => {
    const base: SceneMeasure = { meshes: 1, vertices: 10, triangles: 10, pointClouds: 0, lineSets: 0, materials: 1, textures: 1, skinned: false, morphTargets: false, largestImage: null, bbox: null };
    const reason = (change: Partial<SceneMeasure>) => {
      try {
        checkSceneLimits({ ...base, ...change }, "x.fbx");
      } catch (error) {
        return isPlatformError(error) ? error.detail : "other";
      }
      return null;
    };
    expect(reason({})).toBeNull();
    expect(reason({ vertices: 2_000_001 })).toBe("limit:vertices");
    expect(reason({ triangles: 2_000_001 })).toBe("limit:triangles");
    expect(reason({ textures: 65 })).toBe("limit:textures");
    expect(reason({ largestImage: { width: 8193, height: 16 } })).toBe("limit:image-size");
    expect(reason({ meshes: 0 })).toBe("empty-scene");
  });
});

describe("resource ownership", () => {
  it("disposes every geometry, material, texture and image once, and late arrivals at once", () => {
    const resources = new ImportResources();
    const geometry = new THREE.BoxGeometry();
    const close = vi.fn();
    const texture = new THREE.Texture({ width: 1, height: 1, close } as unknown as HTMLImageElement);
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    const disposals = [vi.spyOn(geometry, "dispose"), vi.spyOn(material, "dispose"), vi.spyOn(texture, "dispose")];
    resources.trackObject(root);
    resources.dispose();
    resources.dispose();
    for (const spy of disposals) expect(spy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const late = new THREE.BufferGeometry();
    const lateDispose = vi.spyOn(late, "dispose");
    resources.trackGeometry(late);
    expect(lateDispose).toHaveBeenCalledOnce();
  });
});
