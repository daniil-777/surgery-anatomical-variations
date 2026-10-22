import { describe, expect, it } from "vitest";
import { bytesOf, cubeGlb, cubeGltf, cubeGltfEmbedded, glbOf, pngHeader } from "./__fixtures__/builders";
import { isPlatformError, type JsonObject } from "../types";
import {
  checkGltfExtensions,
  dropTextureReferences,
  glbImageBytes,
  inspectGltf,
  parseGltfJson,
  readGlb,
  readGltf,
  texturesUsingImages,
  writeGlb,
} from "./gltf";

function refusal(run: () => unknown): { detail: string | null; message: string } {
  try {
    run();
  } catch (error) {
    if (isPlatformError(error)) return { detail: error.detail, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("GLB container", () => {
  it("reads the JSON and BIN chunks", () => {
    const { json, bin } = cubeGltf({ generator: "test" });
    const { jsonText, bin: chunk } = readGlb(glbOf(json, bin));
    expect(JSON.parse(jsonText)).toEqual(json);
    expect(chunk && Array.from(chunk.subarray(0, bin.length))).toEqual(Array.from(bin));
  });

  it("writes GLB files the reader (and the fixture writer's layout) agree on", () => {
    const { json, bin } = cubeGltf({ generator: "round trip" });
    const written = writeGlb(json as JsonObject, bin);
    expect(Array.from(written)).toEqual(Array.from(glbOf(json, bin)));
    expect(readGltf(written, true).json).toEqual(json);
  });

  it("refuses truncated, foreign and glTF 1 binaries", () => {
    expect(refusal(() => readGlb(cubeGlb().subarray(0, 40))).detail).toBe("gltf-container");
    expect(refusal(() => readGlb(bytesOf("PK\u0003\u0004 not a glb at all"))).detail).toBe("gltf-container");
    const v1 = cubeGlb();
    new DataView(v1.buffer).setUint32(4, 1, true);
    expect(refusal(() => readGlb(v1)).detail).toBe("unsupported:gltf1");
  });
});

describe("glTF JSON", () => {
  it("accepts glTF 2.x and refuses other versions and non-documents", () => {
    expect(parseGltfJson(cubeGltfEmbedded()).asset).toMatchObject({ version: "2.0" });
    expect(refusal(() => parseGltfJson('{"asset":{"version":"1.0"}}')).detail).toBe("unsupported:gltf1");
    expect(refusal(() => parseGltfJson('{"scenes":[]}')).detail).toBe("gltf-json");
    expect(refusal(() => parseGltfJson("[1,2,3]")).detail).toBe("gltf-json");
    expect(refusal(() => parseGltfJson("{ not json")).detail).toBe("gltf-json");
  });

  it("refuses keys that would reach object prototypes before three.js copies extras", () => {
    const text = cubeGltfEmbedded().replace('"asset":', '"extras":{"__proto__":{"polluted":true}},"asset":');
    expect(refusal(() => parseGltfJson(text)).detail).toBe("gltf-unsafe-key");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("collects generator, Sketchfab extras, counts and external files", () => {
    const { json } = cubeGltf({
      generator: "Sketchfab-12.66.0",
      copyright: "CC-BY",
      extras: { author: "Ada", license: "CC-BY-4.0", source: "https://sketchfab.com/3d-models/x", title: "Liver" },
      bufferUri: "scene.bin",
      imageUri: "textures/albedo.png",
    });
    const facts = inspectGltf(json as JsonObject);
    expect(facts).toMatchObject({
      generator: "Sketchfab-12.66.0",
      copyright: "CC-BY",
      extras: { author: "Ada", license: "CC-BY-4.0", source: "https://sketchfab.com/3d-models/x", title: "Liver" },
      meshes: 1,
      materials: 1,
      images: 1,
      vertices: 8,
      triangles: 12,
      bufferUris: ["scene.bin"],
      imageUris: ["textures/albedo.png"],
      dracoOnly: false,
      ktx2Only: false,
    });
    expect(inspectGltf(parseGltfJson(cubeGltfEmbedded())).bufferUris).toEqual([]);
  });
});

describe("extensions", () => {
  const facts = (change: (json: JsonObject) => void) => {
    const { json } = cubeGltf();
    change(json as JsonObject);
    return inspectGltf(json as JsonObject);
  };

  it("refuses Draco and KTX2 with a clear 'not supported yet'", () => {
    const draco = facts((json) => {
      json.extensionsUsed = ["KHR_draco_mesh_compression"];
      json.extensionsRequired = ["KHR_draco_mesh_compression"];
    });
    expect(refusal(() => checkGltfExtensions(draco, "heart.glb"))).toMatchObject({ detail: "unsupported:draco", message: expect.stringMatching(/Draco.*isn't supported yet/) });
    const ktx2 = facts((json) => {
      json.extensionsRequired = ["KHR_texture_basisu"];
    });
    expect(refusal(() => checkGltfExtensions(ktx2, "heart.glb"))).toMatchObject({ detail: "unsupported:ktx2", message: expect.stringMatching(/KTX2/) });
  });

  it("finds Draco-only primitives even when the extension is not declared required", () => {
    const draco = facts((json) => {
      const meshes = json.meshes as JsonObject[];
      const primitive = (meshes[0]!.primitives as JsonObject[])[0]!;
      primitive.extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
      const accessors = json.accessors as JsonObject[];
      delete accessors[0]!.bufferView;
    });
    expect(draco.dracoOnly).toBe(true);
    expect(refusal(() => checkGltfExtensions(draco, "a.glb")).detail).toBe("unsupported:draco");
  });

  it("refuses unknown required extensions and notes ignored optional ones", () => {
    const required = facts((json) => {
      json.extensionsRequired = ["VENDOR_magic"];
    });
    expect(refusal(() => checkGltfExtensions(required, "a.glb")).detail).toBe("unsupported:gltf-extension");
    const optional = facts((json) => {
      json.extensionsUsed = ["KHR_materials_clearcoat", "VENDOR_extra"];
    });
    expect(checkGltfExtensions(optional, "a.glb")).toEqual(["Optional glTF extensions ignored by the preview: VENDOR_extra."]);
    const meshopt = facts((json) => {
      json.extensionsUsed = ["EXT_meshopt_compression", "KHR_mesh_quantization"];
      json.extensionsRequired = ["EXT_meshopt_compression"];
    });
    expect(checkGltfExtensions(meshopt, "a.glb")).toEqual([]);
  });
});

describe("texture references", () => {
  it("drops material references to textures whose images are missing, keeping the factors", () => {
    const { json } = cubeGltf({ imageUri: "missing.png" });
    const removed = dropTextureReferences(json as JsonObject, texturesUsingImages(json as JsonObject, new Set([0])));
    expect(removed).toBe(1);
    expect((json.materials as JsonObject[])[0]).toEqual({ pbrMetallicRoughness: { metallicFactor: 0 }, name: "Painted" });
  });

  it("reads images stored in GLB buffer views", () => {
    const png = pngHeader(16, 8);
    const { json } = cubeGltf();
    json.bufferViews = [...(json.bufferViews as JsonObject[]), { buffer: 0, byteOffset: 0, byteLength: png.length }];
    json.images = [{ bufferView: 2, mimeType: "image/png" }];
    expect(Array.from(glbImageBytes(json as JsonObject, png, 0) ?? [])).toEqual(Array.from(png));
    expect(glbImageBytes(json as JsonObject, null, 0)).toBeNull();
  });
});
