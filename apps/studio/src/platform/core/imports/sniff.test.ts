import { describe, expect, it } from "vitest";
import {
  bytesOf,
  cubeGlb,
  cubeGltfEmbedded,
  fbxBinary,
  fbxText,
  objText,
  plyAscii,
  plyBinaryLittleEndian,
  pngHeader,
  QUAD_TRIANGLES,
  stlAscii,
  stlBinary,
  tga2x2,
  usdaLayer,
  zipOf,
} from "./__fixtures__/builders";
import { ImportRejectedError } from "./errors";
import { sniffBytes, sniffFile, sniffRefusal, type SniffResult } from "./sniff";

const sniff = (name: string, data: Uint8Array | string) => sniffBytes(name, typeof data === "string" ? bytesOf(data) : data);

function expectModel(result: SniffResult, format: string, encoding?: "binary" | "text"): void {
  expect(result.kind).toBe("model");
  if (result.kind !== "model") return;
  expect(result.format).toBe(format);
  if (encoding) expect(result.encoding).toBe(encoding);
}

/** `text` is matched against the reason and the advice together, as the shell shows them. */
function expectRefusal(result: SniffResult, detail: string, text?: RegExp): void {
  expect(result.kind).toBe("unsupported");
  if (result.kind !== "unsupported") return;
  expect(result.detail).toBe(detail);
  if (text) expect(`${result.reason} ${result.advice ?? ""}`).toMatch(text);
}

describe("sniffing supported formats", () => {
  it("recognises GLB by its glTF magic and version 2, whatever the name", () => {
    const result = sniff("anything.bin", cubeGlb());
    expectModel(result, "glb", "binary");
    expect(result.kind === "model" && result.mime).toBe("model/gltf-binary");
  });

  it("recognises glTF JSON by asset (and by the .gltf extension)", () => {
    expectModel(sniff("scene.gltf", cubeGltfEmbedded()), "gltf", "text");
    expectModel(sniff("scene.json", cubeGltfEmbedded()), "gltf");
    expectModel(sniff("scene.gltf", `﻿  ${cubeGltfEmbedded()}`), "gltf");
    expect(sniff("settings.json", '{"theme":"dark"}').kind).toBe("extra");
  });

  it("refuses glTF 1.0 (JSON and binary)", () => {
    expectRefusal(sniff("old.gltf", '{"asset":{"version":"1.0"},"scenes":{}}'), "unsupported:gltf1", /glTF 1\.0/);
    const glb1 = cubeGlb();
    new DataView(glb1.buffer).setUint32(4, 1, true);
    expectRefusal(sniff("old.glb", glb1), "unsupported:gltf1");
  });

  it("recognises binary FBX with its version, and text FBX by the header comment or FBXHeaderExtension", () => {
    const binary = sniff("model.fbx", fbxBinary({ version: 7500 }));
    expectModel(binary, "fbx", "binary");
    expect(binary.kind === "model" && binary.version).toBe(7500);
    const text = sniff("model.fbx", fbxText({ version: 7400 }));
    expectModel(text, "fbx", "text");
    expect(text.kind === "model" && text.version).toBe(7400);
    expectModel(sniff("model.fbx", "FBXHeaderExtension:  {\n\tFBXVersion: 7300\n}\n"), "fbx", "text");
  });

  it("refuses FBX older than the browser loader reads", () => {
    const old = fbxBinary({ version: 6100 });
    expectRefusal(sniff("max2009.fbx", old), "unsupported:old-fbx", /FBX 6\.1/);
    expectRefusal(sniff("old.fbx", "; FBX 6.1.0 project file\n"), "unsupported:old-fbx");
  });

  it("recognises OBJ from v/f records (mixed line endings and a trailing NUL included)", () => {
    expectModel(sniff("quad.obj", objText()), "obj", "text");
    expectModel(sniff("quad.txt", objText()), "obj");
    expectModel(sniff("zbrush.obj", `# File exported by ZBrush version 2022\r\nmtllib a.mtl\r\nv 0 1.99998998 0.00000017\nv 1 0 0\nv 0 1 0\nf 1 2 3\n\u0000`), "obj");
    expect(sniff("quad.obj", objText()).kind === "model" && sniff("quad.obj", objText())).toMatchObject({ mime: "model/obj" });
  });

  it("tells ASCII STL from binary STL, even when a binary header starts with 'solid'", () => {
    expectModel(sniff("part.stl", stlAscii(QUAD_TRIANGLES)), "stl", "text");
    expectModel(sniff("part.stl", stlBinary(QUAD_TRIANGLES, "binary header")), "stl", "binary");
    expectModel(sniff("part.stl", stlBinary(QUAD_TRIANGLES, "solid but actually binary")), "stl", "binary");
    const truncated = stlBinary(QUAD_TRIANGLES).subarray(0, 120);
    expectRefusal(sniff("part.stl", truncated), "damaged:stl");
  });

  it("recognises PLY (text and binary)", () => {
    expectModel(sniff("scan.ply", plyAscii()), "ply", "text");
    expectModel(sniff("scan.ply", plyBinaryLittleEndian()), "ply", "binary");
    expectRefusal(sniff("scan.ply", "ply\nelement vertex 1\n"), "damaged:ply");
  });

  it("recognises USDZ as a zip whose first entry is a USD layer", () => {
    const usdz = zipOf({ "model.usda": usdaLayer({ upAxis: "Y" }), "textures/a.png": pngHeader(2, 2) });
    expectModel(sniff("thing.usdz", usdz), "usdz", "binary");
    const crate = zipOf({ "scene.usdc": bytesOf("PXR-USDC") });
    expectModel(sniff("thing.usdz", crate), "usdz");
    const notUsd = zipOf({ "textures/a.png": pngHeader(2, 2), "model.usda": usdaLayer() });
    expectRefusal(sniff("thing.usdz", notUsd), "damaged:usdz");
  });

  it("treats other zips as bundles", () => {
    const zip = zipOf({ "scene.gltf": cubeGltfEmbedded() });
    expect(sniff("download.zip", zip)).toMatchObject({ kind: "bundle", format: "zip", mime: "application/zip" });
    expect(sniff("download.zip", new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)]))).toMatchObject({ kind: "unsupported", detail: "unsupported:empty-zip" });
  });

  it("classifies sidecars, documents and clutter", () => {
    expect(sniff("scene.bin", new Uint8Array([1, 2, 3, 4]))).toMatchObject({ kind: "sidecar", role: "buffer" });
    expect(sniff("paint.mtl", "newmtl Paint\nKd 1 0 0\n")).toMatchObject({ kind: "sidecar", role: "material" });
    expect(sniff("albedo.png", pngHeader(4, 4))).toMatchObject({ kind: "sidecar", role: "image", image: "png" });
    expect(sniff("albedo.tga", tga2x2())).toMatchObject({ kind: "sidecar", role: "image", image: "tga" });
    expect(sniff("license.txt", "CC-BY-4.0")).toMatchObject({ kind: "extra" });
    expect(sniff("Model.fbx.meta", "fileFormatVersion: 2\nguid: 0123\n")).toMatchObject({ kind: "extra" });
    expect(sniff("__MACOSX/._scene.gltf", "junk")).toMatchObject({ kind: "junk" });
    expect(sniff("textures/.DS_Store", "junk")).toMatchObject({ kind: "junk" });
  });
});

describe("refusals with advice", () => {
  it("refuses COLLADA as not supported yet (format dae)", () => {
    const result = sniff("model.dae", '<?xml version="1.0"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">');
    expectRefusal(result, "unsupported:dae", /isn't supported yet.*glTF\/GLB or FBX/);
    expect(result.kind === "unsupported" && result.format).toBe("dae");
  });

  it("explains .blend files with the Blender export path, reason and advice apart", () => {
    const result = sniff("heart.blend", "BLENDER-v402RENDH");
    expectRefusal(result, "unsupported:blend", /File › Export › glTF 2\.0/);
    expect(result).toMatchObject({
      app: "blender",
      reason: "heart.blend: Blender project files (.blend) can't be opened in the browser.",
      advice: "In Blender, choose File › Export › glTF 2.0 (.glb) — or FBX (.fbx) — and import that file.",
    });
    const error = result.kind === "unsupported" ? sniffRefusal(result) : null;
    expect(error).toBeInstanceOf(ImportRejectedError);
    expect(error).toMatchObject({ code: "invalid_input", detail: "unsupported:blend", reason: result.kind === "unsupported" ? result.reason : "", advice: result.kind === "unsupported" ? result.advice : "" });
  });

  it("explains Unity packages and prefabs with the Unity export path", () => {
    const unitypackage = sniff("Liver.unitypackage", new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]));
    expectRefusal(unitypackage, "unsupported:unitypackage", /UnityGLTF or glTFast.*FBX Exporter/);
    expect(unitypackage.kind === "unsupported" && unitypackage.app).toBe("unity");
    const prefab = sniff("Liver.prefab", "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &1\nGameObject:\n");
    expectRefusal(prefab, "unsupported:prefab", /export the object as GLB/);
    expectRefusal(sniff("Liver.prefab", new Uint8Array([0, 1, 2, 3])), "unsupported:prefab");
  });

  it("names other applications' project files", () => {
    expectRefusal(sniff("scene.max", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), "unsupported:max", /3ds Max/);
    expectRefusal(sniff("scene.c4d", new Uint8Array([0x51, 0x43, 0x34, 0x44])), "unsupported:c4d", /Cinema 4D/);
    expectRefusal(sniff("scene.skp", new Uint8Array([0xff, 0xfe, 0xff, 0x0e])), "unsupported:skp", /SketchUp/);
    expectRefusal(sniff("scene.ztl", new Uint8Array([0, 0, 0, 1])), "unsupported:ztl", /ZBrush/);
  });

  it("refuses standalone USD layers, gzip, empty and unknown files", () => {
    expectRefusal(sniff("scene.usda", usdaLayer()), "unsupported:usda", /USDZ/);
    expectRefusal(sniff("scene.usdc", bytesOf("PXR-USDC\u0000\u0008")), "unsupported:usdc");
    expectRefusal(sniff("model.glb.gz", new Uint8Array([0x1f, 0x8b, 8, 0])), "unsupported:gzip");
    expectRefusal(sniff("empty.obj", new Uint8Array()), "unsupported:empty");
    expectRefusal(sniff("random.xyz", new Uint8Array([0, 159, 146, 150, 1, 2, 3])), "unsupported:unknown", /Supported: GLB/);
    expectRefusal(sniff("broken.glb", bytesOf("not a glb at all")), "damaged:glb");
  });

  it("sniffs a File from its first bytes", async () => {
    const file = new File([cubeGlb() as Uint8Array<ArrayBuffer>], "cube.glb");
    expectModel(await sniffFile(file), "glb");
  });
});
