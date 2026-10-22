import { describe, expect, it } from "vitest";
import { bytesOf, cubeGltf, fbxBinary, fbxText, objText, plyAscii, stlAscii, stlBinary, QUAD_TRIANGLES, usdaLayer, type FbxOptions, type JsonLike } from "./__fixtures__/builders";
import { latin1Text } from "./bytes";
import { detectSource, matchApplication, objHeaderComments } from "./detect";
import { readFbxHeader } from "./fbx";
import { inspectGltf } from "./gltf";
import type { JsonObject } from "../types";
import { readUsdaMeta } from "./usd";

function gltf(asset: { [key: string]: JsonLike }, extensions?: { [key: string]: JsonLike }) {
  const { json } = cubeGltf();
  json.asset = { version: "2.0", ...asset };
  if (extensions) json.extensions = extensions;
  return detectSource({ gltf: inspectGltf(json as JsonObject) });
}

describe("glTF asset.generator", () => {
  it.each([
    ["Khronos glTF Blender I/O v4.2.70", "blender"],
    ["Khronos glTF Blender I/O v0.9.0", "blender"],
    ["UnityGltf 2.14.0, Unity 2022.3.20f1, URP", "unity"],
    ["UnityGLTF", "unity"],
    ["glTF Tools for Unity", "unity"],
    ["Unity 2022.3.10f1 glTFast 6.0.1", "unity"],
    ["UniGLTF-2.0.0", "unity"],
    ["Sketchfab-12.66.0", "sketchfab"],
    ["Houdini GLTF 2.0 Exporter", "houdini"],
    ["Maxon Cinema 4D 2024.4.1 (#200000219)", "cinema-4d"],
    ["Adobe Substance 3D Stager - 14a015d2d34690a58f7151765a096baa71bff664", "substance"],
    ["babylon.js glTF exporter for 3ds max 2017 v1.2.14", "3ds-max"],
    ["babylon.js glTF exporter for maya 2018 v1.0.5", "maya"],
    ["Maya2glTF", "maya"],
    ["Sketchup glTF Exporter by Centaur", "sketchup"],
    ["ZBrush 2023 glTF", "zbrush"],
    ["Reality Composer 1.5", "reality-composer"],
  ])("%s → %s (metadata)", (generator, app) => {
    const result = gltf({ generator });
    expect(result).toMatchObject({ sourceApp: app, detectedBy: "metadata", sourceDetail: generator });
    expect(result.evidence[0]).toBe(`glTF asset.generator "${generator}"`);
  });

  it.each([
    ["FBX2glTF v0.9.7"],
    ["THREE.GLTFExporter r186"],
    ["COLLADA2GLTF"],
    ["obj2gltf"],
  ])("a converter or library (%s) is 'other' with its own words", (generator) => {
    expect(gltf({ generator })).toMatchObject({ sourceApp: "other", detectedBy: "metadata", sourceDetail: generator });
  });

  it("uses Sketchfab's asset.extras.source when the generator says nothing", () => {
    const result = gltf({ extras: { author: "someone", license: "CC-BY-4.0", source: "https://sketchfab.com/3d-models/heart-123", title: "Heart" } });
    expect(result).toMatchObject({ sourceApp: "sketchfab", detectedBy: "metadata" });
    expect(result.evidence[0]).toMatch(/asset\.extras\.source is a Sketchfab page/);
  });

  it("reads the XMP CreatorTool and app names in asset.copyright", () => {
    expect(gltf({}, { KHR_xmp_json_ld: { packets: [{ "xmp:CreatorTool": "Adobe Substance 3D Stager" }] } })).toMatchObject({ sourceApp: "substance" });
    expect(gltf({ copyright: "Made with Blender by Ada" })).toMatchObject({ sourceApp: "blender", detectedBy: "metadata" });
    expect(gltf({ copyright: "© 2024 Ada Lovelace" })).toMatchObject({ sourceApp: "unknown", detectedBy: "none" });
  });

  it("does not mistake words that merely contain an app name", () => {
    expect(matchApplication("community edition")).toBeNull();
    expect(matchApplication("maximal")).toBeNull();
    expect(matchApplication("Sketchfab-12.68.0")).toBe("sketchfab");
  });
});

describe("FBX header", () => {
  const cases: Array<[string, FbxOptions, string, string]> = [
    [
      "Blender (stable FBX IO)",
      { creator: "Blender (stable FBX IO) - 4.0.2 - 5.8.13", original: { vendor: "Blender Foundation", name: "Blender (stable FBX IO)", version: "4.0.2" }, lastSaved: { vendor: "Blender Foundation", name: "Blender (stable FBX IO)", version: "4.0.2" } },
      "blender",
      "Blender (stable FBX IO) 4.0.2",
    ],
    [
      "Unity FBX Exporter",
      { creator: "FBX SDK/FBX Plugins version 2020.2", title: "Created by FBX Exporter from Unity Technologies", author: "Unity Technologies", original: { vendor: "", name: "Unity FBX Exporter", version: "4.1.2" }, lastSaved: { vendor: "", name: "Unity FBX Exporter", version: "4.1.2" } },
      "unity",
      "Unity FBX Exporter 4.1.2",
    ],
    ["Maya", { creator: "FBX SDK/FBX Plugins version 2019.2", original: { vendor: "Autodesk", name: "Maya", version: "201900" }, lastSaved: { vendor: "Autodesk", name: "Maya", version: "201900" } }, "maya", "Maya 201900"],
    ["3ds Max", { lastSaved: { vendor: "Autodesk", name: "3ds Max", version: "2020" } }, "3ds-max", "3ds Max 2020"],
    ["Cinema 4D", { lastSaved: { vendor: "MAXON", name: "CINEMA 4D R18", version: "18.057" } }, "cinema-4d", "CINEMA 4D R18 18.057"],
    ["Houdini", { lastSaved: { vendor: "SideFX Software", name: "Houdini", version: "19.5.403" } }, "houdini", "Houdini 19.5.403"],
    ["MotionBuilder (no own category)", { lastSaved: { vendor: "Autodesk", name: "MotionBuilder", version: "2023" } }, "other", "MotionBuilder 2023"],
  ];

  it.each(cases)("binary: %s", (_label, options, app, detail) => {
    const result = detectSource({ fbx: readFbxHeader(fbxBinary(options)) });
    expect(result).toMatchObject({ sourceApp: app, detectedBy: "metadata", sourceDetail: detail });
  });

  it.each(cases)("text: %s", (_label, options, app, detail) => {
    const result = detectSource({ fbx: readFbxHeader(bytesOf(fbxText(options))) });
    expect(result).toMatchObject({ sourceApp: app, detectedBy: "metadata", sourceDetail: detail });
  });

  it("prefers the application that last saved the file and mentions the original one", () => {
    const header = readFbxHeader(fbxBinary({ original: { name: "Autodesk 3ds Max 2011.1" }, lastSaved: { vendor: "MAXON", name: "Cinema 4D R20", version: "20.026" } }));
    const result = detectSource({ fbx: header });
    expect(result.sourceApp).toBe("cinema-4d");
    expect(result.evidence[0]).toMatch(/LastSaved\|ApplicationName "Cinema 4D R20 20\.026" \(first created in Autodesk 3ds Max 2011\.1\)/);
  });

  it("recognises Blender from the Creator alone, and Unity from the scene title alone", () => {
    expect(detectSource({ fbx: readFbxHeader(fbxBinary({ creator: "Blender (stable FBX IO) - 2.79 (sub 0) - 3.7.13" })) })).toMatchObject({ sourceApp: "blender" });
    expect(detectSource({ fbx: readFbxHeader(fbxBinary({ title: "Created by FBX Exporter from Unity Technologies" })) })).toMatchObject({ sourceApp: "unity" });
  });

  it("treats the FBX SDK creator string as no evidence (ZBrush, Marvelous … leave the names empty)", () => {
    const result = detectSource({ fbx: readFbxHeader(fbxBinary({ creator: "FBX SDK/FBX Plugins version 2020.0.1", original: {}, lastSaved: {} })) });
    expect(result).toEqual({ sourceApp: "unknown", sourceDetail: null, detectedBy: "none", evidence: [] });
  });

  it("uses the native file extension and SketchUp's export path when the names are empty", () => {
    expect(detectSource({ fbx: readFbxHeader(fbxBinary({ nativeFile: "C:\\work\\heart.blend" })) })).toMatchObject({ sourceApp: "blender", detectedBy: "metadata" });
    expect(detectSource({ fbx: readFbxHeader(fbxBinary({ documentUrl: "/var/folders/16/T/com.sketchup.SketchUp.2016.peter.fbx" })) })).toMatchObject({ sourceApp: "sketchup" });
  });
});

describe("OBJ, PLY and STL headers", () => {
  it.each([
    ["Blender 4.4.1", "blender"],
    ["Blender v2.79 (sub 0) OBJ File: ''", "blender"],
    ["3ds Max Wavefront OBJ Exporter v0.94b - (c)2007 guruware", "3ds-max"],
    ["File exported by ZBrush version 2022", "zbrush"],
    ["File exported by Houdini 16.5.439 (www.sidefx.com)", "houdini"],
    ["WaveFront *.obj file (generated by CINEMA 4D)", "cinema-4d"],
    ["Exported from SketchUp, (c) 2000-2012 Trimble Navigation Limited", "sketchup"],
    ["OBJ File Generated by Meshlab", "other"],
  ])("OBJ comment %s → %s", (comment, app) => {
    const result = detectSource({ obj: objText({ comments: [comment] }) });
    expect(result).toMatchObject({ sourceApp: app, detectedBy: "metadata", sourceDetail: comment });
  });

  it("ignores OBJ comments that only state units, and comments after the data starts", () => {
    expect(detectSource({ obj: objText({ comments: ["This file uses centimeters as units for non-parametric coordinates."] }) }).sourceApp).toBe("unknown");
    expect(objHeaderComments("v 0 0 0\n# Blender 4.0\n")).toEqual([]);
  });

  it("reads PLY comments", () => {
    expect(detectSource({ ply: plyAscii({ comments: ["Created in Blender version 4.2.0"] }) })).toMatchObject({ sourceApp: "blender", sourceDetail: "Created in Blender version 4.2.0" });
    expect(detectSource({ ply: plyAscii({ comments: ["Created by Blender 3.3.0 - www.blender.org"] }) })).toMatchObject({ sourceApp: "blender" });
    expect(detectSource({ ply: plyAscii({ comments: ["VCGLIB generated"] }) }).sourceApp).toBe("unknown");
  });

  it("reads the STL solid line and binary header, but not object names", () => {
    const ascii = stlAscii(QUAD_TRIANGLES, "Exported from Blender-3.3.0");
    expect(detectSource({ stl: { header: ascii.split("\n")[0]!, binary: false } })).toMatchObject({ sourceApp: "blender", sourceDetail: "Exported from Blender-3.3.0" });
    const binary = stlBinary(QUAD_TRIANGLES, "Exported from Blender-2.93.0");
    expect(detectSource({ stl: { header: latin1Text(binary, 0, 80), binary: true } })).toMatchObject({ sourceApp: "blender" });
    expect(detectSource({ stl: { header: "solid Cube", binary: false } }).sourceApp).toBe("unknown");
  });
});

describe("USD layer metadata", () => {
  it.each([
    [{ creator: "Reality Composer Pro Version 2.0 (494.100.6)" }, "reality-composer"],
    [{ doc: "Blender v4.2.0" }, "blender"],
    [{ creator: "Three.js USDZExporter" }, "other"],
    [{ creator: "usdzconvert preview 0.67" }, "other"],
  ] as const)("%o → %s", (fields, app) => {
    const meta = readUsdaMeta(usdaLayer({ ...fields, upAxis: "Y" }));
    expect(detectSource({ usd: meta })).toMatchObject({ sourceApp: app, detectedBy: "metadata" });
  });
});

describe("names in the selection (weaker signal)", () => {
  it("finds application words in the main file and zip names", () => {
    expect(detectSource({ names: ["Liver_unity.fbx"] })).toMatchObject({ sourceApp: "unity", detectedBy: "filename", sourceDetail: null });
    expect(detectSource({ names: ["exports/heart-blender.obj"] })).toMatchObject({ sourceApp: "blender", detectedBy: "filename" });
    expect(detectSource({ names: ["community.fbx"] })).toMatchObject({ sourceApp: "unknown", detectedBy: "none" });
  });

  it("finds companion files: Unity .meta files and .blend projects", () => {
    expect(detectSource({ names: ["Assets/Models/Liver.fbx"], paths: ["Assets/Models/Liver.fbx", "Assets/Models/Liver.fbx.meta"] })).toMatchObject({
      sourceApp: "unity",
      detectedBy: "filename",
      evidence: ["Unity .meta files are included"],
    });
    expect(detectSource({ paths: ["heart.obj", "heart.blend"] })).toMatchObject({ sourceApp: "blender", detectedBy: "filename" });
  });

  it("decides nothing when the hints disagree, but reports them", () => {
    const result = detectSource({ names: ["unity-export.fbx"], paths: ["unity-export.fbx", "source.blend"] });
    expect(result).toMatchObject({ sourceApp: "unknown", detectedBy: "none" });
    expect(result.evidence).toHaveLength(2);
  });

  it("lets metadata win over names and keeps the name hint as evidence", () => {
    const { json } = cubeGltf({ generator: "Khronos glTF Blender I/O v4.1.63" });
    const result = detectSource({ gltf: inspectGltf(json as JsonObject), names: ["for_unity.glb"] });
    expect(result).toMatchObject({ sourceApp: "blender", detectedBy: "metadata" });
    expect(result.evidence).toEqual(['glTF asset.generator "Khronos glTF Blender I/O v4.1.63"', 'The name "for_unity.glb" mentions Unity']);
  });

  it("reports an unknown source with no signals", () => {
    expect(detectSource({})).toEqual({ sourceApp: "unknown", sourceDetail: null, detectedBy: "none", evidence: [] });
  });
});
