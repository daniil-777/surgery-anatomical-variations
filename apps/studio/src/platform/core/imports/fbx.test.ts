import { describe, expect, it } from "vitest";
import { bytesOf, fbxBinary, fbxText } from "./__fixtures__/builders";
import { fbxUnits, isBinaryFbx, readFbxHeader } from "./fbx";

const fields = {
  creator: "Blender (stable FBX IO) - 4.2.0 - 5.12.3",
  original: { vendor: "Blender Foundation", name: "Blender (stable FBX IO)", version: "4.2.0" },
  lastSaved: { vendor: "Blender Foundation", name: "Blender (stable FBX IO)", version: "4.2.0" },
  title: "Heart",
  author: "Ada",
  nativeFile: "/Users/ada/heart.blend",
  upAxis: 2,
  unitScaleFactor: 100,
};

describe("readFbxHeader", () => {
  it.each([7400, 7500, 7700])("reads every header field of binary FBX %i (32- and 64-bit records)", (version) => {
    const bytes = fbxBinary({ ...fields, version, mesh: true });
    expect(isBinaryFbx(bytes)).toBe(true);
    expect(readFbxHeader(bytes)).toEqual({
      encoding: "binary",
      version,
      creator: fields.creator,
      original: fields.original,
      lastSaved: fields.lastSaved,
      nativeFile: fields.nativeFile,
      documentUrl: null,
      title: "Heart",
      author: "Ada",
      upAxis: 2,
      unitScaleFactor: 100,
    });
  });

  it("reads the same fields from text FBX", () => {
    const header = readFbxHeader(bytesOf(fbxText({ ...fields, version: 7400, mesh: true })));
    expect(header).toEqual({
      encoding: "text",
      version: 7400,
      creator: fields.creator,
      original: fields.original,
      lastSaved: fields.lastSaved,
      nativeFile: fields.nativeFile,
      documentUrl: null,
      title: "Heart",
      author: "Ada",
      upAxis: 2,
      unitScaleFactor: 100,
    });
  });

  it("reads FBX 6 'Property:' lines and decodes &quot;", () => {
    const text = [
      "; FBX 6.1.0 project file",
      "FBXHeaderExtension:  {",
      '\tCreator: "Exporter &quot;X&quot;"',
      "}",
      "GlobalSettings:  {",
      '\tProperty: "UpAxis", "int", "",2',
      '\tProperty: "UnitScaleFactor", "double", "",2.54',
      "}",
      "",
    ].join("\n");
    const header = readFbxHeader(bytesOf(text));
    expect(header).toMatchObject({ version: 6100, creator: 'Exporter "X"', upAxis: 2, unitScaleFactor: 2.54 });
  });

  it("returns empty facts for damaged or truncated files instead of throwing", () => {
    const bytes = fbxBinary(fields);
    expect(() => readFbxHeader(bytes.subarray(0, 60))).not.toThrow();
    expect(readFbxHeader(bytes.subarray(0, 60))).toMatchObject({ encoding: "binary", version: 7400, creator: null });
    const corrupted = bytes.slice();
    new DataView(corrupted.buffer).setUint32(27, 0xffffff00, true);
    expect(readFbxHeader(corrupted)).toMatchObject({ creator: null, upAxis: null });
    expect(readFbxHeader(bytesOf("; FBX 7.4.0 project file\n"))).toMatchObject({ encoding: "text", version: 7400, creator: null });
  });
});

describe("fbxUnits", () => {
  it.each([
    [1, "cm"],
    [100, "m"],
    [0.1, "mm"],
    [2.54, "in"],
    [30.48, "ft"],
    [5, "5 cm"],
  ])("UnitScaleFactor %d → %s", (factor, units) => {
    expect(fbxUnits(factor)).toBe(units);
  });

  it("has no answer without a positive factor", () => {
    expect(fbxUnits(null)).toBeUndefined();
    expect(fbxUnits(0)).toBeUndefined();
  });
});
