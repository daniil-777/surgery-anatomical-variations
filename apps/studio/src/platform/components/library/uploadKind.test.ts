import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../core/memory";
import { displayName, fileExtension, inferUpload, libraryFilename, sniffUpload, titleFromFilename, UPLOAD_SNIFF_BYTES } from "./uploadKind";

function bytes(...parts: Array<string | number[]>): Uint8Array<ArrayBuffer> {
  const values: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) values.push(char.charCodeAt(0));
    else values.push(...part);
  }
  return new Uint8Array(values);
}

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF");
const WEBP = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ");
const AVIF = bytes([0, 0, 0, 0x1c], "ftypavif", [0, 0, 0, 0]);
const HEIC = bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]);
const MP4 = bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0]);
const MOV = bytes([0, 0, 0, 0x14], "ftypqt  ", [0, 0, 0, 0]);
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], "webm");
const MKV = bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88], "matroska");
const GLB = bytes("glTF", [2, 0, 0, 0, 0, 1, 0, 0]);
const GIF = bytes("GIF89a");

const file = (name: string, type = "", size = 100) => ({ name, type, size });

describe("sniffing uploads", () => {
  it("recognises every accepted signature", () => {
    expect(sniffUpload(PNG)).toBe("png");
    expect(sniffUpload(JPEG)).toBe("jpeg");
    expect(sniffUpload(WEBP)).toBe("webp");
    expect(sniffUpload(AVIF)).toBe("avif");
    expect(sniffUpload(MP4)).toBe("mp4");
    expect(sniffUpload(WEBM)).toBe("webm");
    expect(sniffUpload(GLB)).toBe("glb");
  });

  it("names the formats it refuses", () => {
    expect(sniffUpload(HEIC)).toBe("heic");
    expect(sniffUpload(MOV)).toBe("quicktime");
    expect(sniffUpload(MKV)).toBe("matroska");
    expect(sniffUpload(GIF)).toBe("gif");
    expect(sniffUpload(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">'))).toBe("svg");
    expect(sniffUpload(bytes('{"asset":{"version":"2.0"}}'))).toBe("gltf-json");
    expect(sniffUpload(bytes([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(sniffUpload(bytes("hello world"))).toBeNull();
    expect(sniffUpload(bytes("ab"))).toBeNull();
  });
});

describe("inferring the library kind", () => {
  it("maps images, GLB and video to image, model and recording", () => {
    const image = inferUpload(file("still.png", "image/png"), PNG);
    expect(image).toEqual({ ok: true, plan: { kind: "image", mimeType: "image/png", role: "primary", format: "PNG" } });
    const model = inferUpload(file("Liver.glb", ""), GLB);
    expect(model.ok && model.plan).toMatchObject({ kind: "model", mimeType: "model/gltf-binary", role: "mesh" });
    const video = inferUpload(file("run.webm", "video/webm"), WEBM);
    expect(video.ok && video.plan).toMatchObject({ kind: "recording", mimeType: "video/webm", role: "video" });
    const mp4 = inferUpload(file("run.mp4", "video/mp4"), MP4);
    expect(mp4.ok && mp4.plan).toMatchObject({ kind: "recording", mimeType: "video/mp4" });
  });

  it("trusts the bytes over the name and type", () => {
    const renamed = inferUpload(file("photo.png", "image/png"), JPEG);
    expect(renamed.ok && renamed.plan.mimeType).toBe("image/jpeg");
    const glbAsBin = inferUpload(file("export.bin", "application/octet-stream"), GLB);
    expect(glbAsBin.ok && glbAsBin.plan.kind).toBe("model");
    const fakeMp4 = inferUpload(file("clip.mp4", "video/mp4"), MOV);
    expect(fakeMp4.ok).toBe(false);
  });

  it("falls back to the extension and the type without bytes", () => {
    expect(inferUpload(file("a.JPG")).ok).toBe(true);
    expect(inferUpload(file("model.glb")).ok).toBe(true);
    expect(inferUpload(file("noext", "video/webm")).ok).toBe(true);
  });

  it("refuses with a sentence that says what to do", () => {
    const cases: Array<[ReturnType<typeof file>, Uint8Array | undefined, RegExp]> = [
      [file("anim.gif", "image/gif"), GIF, /GIF/],
      [file("IMG_0001.HEIC", "image/heic"), HEIC, /HEIC.*JPEG/],
      [file("take.mov", "video/quicktime"), MOV, /MP4/],
      [file("scene.gltf", "model/gltf+json"), bytes('{"asset":{}}'), /Imports/],
      [file("cube.obj", ""), bytes("# Blender v4.2 OBJ"), /Imports/],
      [file("rig.fbx", ""), undefined, /FBX.*Imports/],
      [file("notes.docx", ""), bytes([0x50, 0x4b, 0x03, 0x04]), /ZIP|Imports/],
      [file("readme.txt", "text/plain"), bytes("hello"), /can’t store|PNG/],
      [file("drawing.svg", "image/svg+xml"), undefined, /SVG/],
    ];
    for (const [input, head, pattern] of cases) {
      const decision = inferUpload(input, head);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toMatch(pattern);
        expect(decision.reason).toContain(`“${input.name}”`);
      }
    }
    const empty = inferUpload(file("empty.png", "image/png", 0), new Uint8Array());
    expect(empty).toEqual({ ok: false, reason: "“empty.png” is empty." });
    expect(UPLOAD_SNIFF_BYTES).toBeGreaterThanOrEqual(16);
  });
});

describe("names", () => {
  it("reads extensions and display names", () => {
    expect(fileExtension("a/b/Liver.V2.GLB")).toBe("glb");
    expect(fileExtension(".env")).toBe("");
    expect(fileExtension("noext")).toBe("");
    expect(displayName("C:\\Users\\me\\still.png")).toBe("still.png");
    expect(displayName("  ")).toBe("Untitled");
  });

  it("makes titles from file names", () => {
    expect(titleFromFilename("Liver capsule v2.glb")).toBe("Liver capsule v2");
    expect(titleFromFilename("  spaced\tout  name.png")).toBe("spaced out name");
    expect(titleFromFilename(".png")).toBe(".png");
    expect(titleFromFilename("")).toBe("Untitled");
    expect([...titleFromFilename(`${"é".repeat(300)}.png`)].length).toBe(120);
  });

  it("makes filenames the database accepts", async () => {
    expect(libraryFilename("dir/sub/still.png")).toBe("still.png");
    expect(libraryFilename(".hidden.png")).toBe("hidden.png");
    expect(libraryFilename("  ")).toBe("file");
    expect(libraryFilename("", "png")).toBe("file.png");
    expect(libraryFilename("bad\u0007name.png")).toBe("badname.png");
    const long = libraryFilename(`${"x".repeat(400)}.webm`);
    expect([...long].length).toBe(180);
    expect(long.endsWith(".webm")).toBe(true);
    // the memory twin restates the database rule: these names must be accepted as library files
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "names@example.test", password: "correct horse battery" });
    const asset = await backend.assets.put(new Blob([PNG], { type: "image/png" }));
    for (const name of ["still.png", libraryFilename(".hidden.png"), long, libraryFilename("a\\b/c.png")]) {
      const created = await backend.library.create({ kind: "image", title: "Names", files: [{ filename: name, assetId: asset.id, role: "primary" }] });
      expect(created.files?.[0]?.filename).toBe(name);
    }
  });
});
