import { describe, expect, it } from "vitest";
import { bytesOf, pngHeader, tga2x2 } from "./__fixtures__/builders";
import { imageKind, imageSize } from "./images";
import { FileSet, basename, dirname, extension, isJunkPath, isLocalUrl, isRemoteReference, normalizePath, stem } from "./paths";

describe("paths", () => {
  it("normalises separators, drive letters and dot segments", () => {
    expect(normalizePath("Heart\\textures\\a.png")).toBe("Heart/textures/a.png");
    expect(normalizePath("C:\\Users\\ada\\a.png")).toBe("Users/ada/a.png");
    expect(normalizePath("./a/./b/../c.png")).toBe("a/c.png");
    expect(normalizePath("/abs/x.obj")).toBe("abs/x.obj");
    expect(normalizePath("../escape.png")).toBeNull();
  });

  it("splits names", () => {
    expect(basename("a/b/Heart.FBX")).toBe("Heart.FBX");
    expect(dirname("a/b/Heart.FBX")).toBe("a/b");
    expect(dirname("Heart.FBX")).toBe("");
    expect(extension("a/b/Heart.FBX")).toBe("fbx");
    expect(extension(".DS_Store")).toBe("");
    expect(stem("model.fbx.meta")).toBe("model.fbx");
  });

  it("recognises clutter, web addresses and local URLs", () => {
    expect(isJunkPath("__MACOSX/Heart/._scene.gltf")).toBe(true);
    expect(isJunkPath("Heart/Thumbs.db")).toBe(true);
    expect(isJunkPath("Heart/scene.gltf")).toBe(false);
    expect(isRemoteReference("https://example.com/a.png")).toBe(true);
    expect(isRemoteReference("//cdn.example.com/a.png")).toBe(true);
    expect(isRemoteReference("C:\\textures\\a.png")).toBe(false);
    expect(isRemoteReference("file:///C:/a.png")).toBe(false);
    expect(isRemoteReference("data:image/png;base64,AAAA")).toBe(false);
    expect(isLocalUrl("blob:https://site/123")).toBe(true);
  });
});

describe("FileSet.resolve", () => {
  const files = new FileSet([
    { path: "Heart/scene.gltf", bytes: bytesOf("{}") },
    { path: "Heart/scene.bin", bytes: bytesOf("bin") },
    { path: "Heart/textures/Albedo.png", bytes: pngHeader(2, 2) },
    { path: "Heart/textures/normal map.png", bytes: pngHeader(2, 2) },
    { path: "other/Albedo.png", bytes: pngHeader(2, 2) },
    { path: "wood.tga", bytes: tga2x2() },
  ]);

  it("resolves relative references from the referring file's folder, case-insensitively and URI-decoded", () => {
    expect(files.resolve("scene.bin", "Heart")?.path).toBe("Heart/scene.bin");
    expect(files.resolve("textures/albedo.PNG", "Heart")?.path).toBe("Heart/textures/Albedo.png");
    expect(files.resolve("textures/normal%20map.png", "Heart")?.path).toBe("Heart/textures/normal map.png");
    expect(files.resolve("./textures/Albedo.png?v=2#x", "Heart")?.path).toBe("Heart/textures/Albedo.png");
  });

  it("falls back to a unique file name for absolute paths from the author's disk", () => {
    expect(files.resolve("C:\\Users\\ada\\Desktop\\wood.tga", "Heart")?.path).toBe("wood.tga");
    expect(files.resolve("/Users/ada/wood.tga", "Heart")?.path).toBe("wood.tga");
    expect(files.resolve("file:///C:/maps/wood.tga", "")?.path).toBe("wood.tga");
  });

  it("disambiguates repeated names by folder, else gives up", () => {
    expect(files.resolve("C:\\maps\\textures\\Albedo.png", "")?.path).toBe("Heart/textures/Albedo.png");
    expect(files.resolve("D:\\Albedo.png", "other")?.path).toBe("other/Albedo.png");
    expect(files.resolve("D:\\Albedo.png", "elsewhere")).toBeUndefined();
  });

  it("treats a leading slash as the selection root", () => {
    expect(files.resolve("/Heart/textures/Albedo.png", "other")?.path).toBe("Heart/textures/Albedo.png");
  });

  it("never resolves web addresses, data or blob URLs, or escapes", () => {
    expect(files.resolve("https://example.com/scene.bin", "Heart")).toBeUndefined();
    expect(files.resolve("data:application/octet-stream;base64,AAAA", "Heart")).toBeUndefined();
    expect(files.resolve("../../../../etc/passwd", "Heart")).toBeUndefined();
    expect(files.resolve("missing.png", "Heart")).toBeUndefined();
  });
});

describe("image headers", () => {
  it("reads the pixel size of PNG, JPEG, GIF, WebP, BMP and TGA", () => {
    expect(imageSize(pngHeader(4096, 2048))).toEqual({ width: 4096, height: 2048 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03]);
    expect(imageKind(jpeg)).toBe("jpeg");
    expect(imageSize(jpeg)).toEqual({ width: 512, height: 256 });
    const gif = bytesOf("GIF89a\u0010\u0000\u0020\u0000");
    expect(imageSize(gif)).toEqual({ width: 16, height: 32 });
    const webp = new Uint8Array(30);
    webp.set(bytesOf("RIFF"), 0);
    webp.set(bytesOf("WEBPVP8X"), 8);
    webp.set([0xff, 0x0f, 0x00, 0xff, 0x07, 0x00], 24);
    expect(imageSize(webp)).toEqual({ width: 4096, height: 2048 });
    const bmp = new Uint8Array(30);
    bmp.set(bytesOf("BM"), 0);
    new DataView(bmp.buffer).setUint32(14, 40, true);
    new DataView(bmp.buffer).setInt32(18, 64, true);
    new DataView(bmp.buffer).setInt32(22, -32, true);
    expect(imageSize(bmp)).toEqual({ width: 64, height: 32 });
    expect(imageKind(tga2x2(), "tga")).toBe("tga");
    expect(imageKind(tga2x2())).toBe("unknown");
    expect(imageSize(tga2x2(), "tga")).toEqual({ width: 2, height: 2 });
  });

  it("recognises formats the preview cannot decode", () => {
    expect(imageKind(new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]))).toBe("ktx2");
    expect(imageKind(bytesOf("DDS |"))).toBe("dds");
    expect(imageKind(bytesOf("8BPS"))).toBe("psd");
  });
});
