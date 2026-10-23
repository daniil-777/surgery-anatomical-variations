import { describe, expect, it } from "vitest";
import { bakeFatTexture, createFatTextureBaker, FAT_TEXTURE_MAPS } from "./texture";

function range(data: Uint8Array, channel: number): [number, number] {
  let minimum = 255, maximum = 0;
  for (let i = channel; i < data.length; i += 4) { minimum = Math.min(minimum, data[i]!); maximum = Math.max(maximum, data[i]!); }
  return [minimum, maximum];
}
function auditEdges(data: Uint8Array, size: number): void {
  for (let coordinate = 0; coordinate < size; coordinate++) for (let channel = 0; channel < 4; channel++) {
    if (data[(coordinate * size) * 4 + channel] !== data[(coordinate * size + size - 1) * 4 + channel]) throw new Error("Horizontal repeat seam");
    if (data[coordinate * 4 + channel] !== data[((size - 1) * size + coordinate) * 4 + channel]) throw new Error("Vertical repeat seam");
  }
}

describe("worker-compatible adipose texture baking", () => {
  it("reproduces all four maps and varies independent texture seeds", () => {
    const first = createFatTextureBaker({ textureSeed: 62 }, 64);
    const same = createFatTextureBaker({ textureSeed: 62 }, 64);
    const other = createFatTextureBaker({ textureSeed: 63 }, 64);
    for (const map of FAT_TEXTURE_MAPS) {
      expect(first.bake(map)).toEqual(same.bake(map));
      expect(first.bake(map)).not.toEqual(other.bake(map));
    }
  });

  it("has exactly periodic RGBA edges across 100 seeds", () => {
    const fingerprints = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      const baker = createFatTextureBaker({ textureSeed: seed * 19 - 51 }, 32);
      for (const map of FAT_TEXTURE_MAPS) {
        const data = baker.bake(map); auditEdges(data, 32);
        expect(range(data, 3)).toEqual([255, 255]);
      }
      fingerprints.add(baker.bake("color").slice(0, 64).join(","));
    }
    expect(fingerprints.size).toBe(100);
  });

  it("produces identical output in arbitrary row chunks and supplied buffers", () => {
    const baker = createFatTextureBaker({ textureSeed: 912 }, 67);
    for (const map of FAT_TEXTURE_MAPS) {
      const expected = baker.bake(map), actual = new Uint8Array(expected.length);
      for (let start = 0; start < 67; start += 13) {
        const count = Math.min(13, 67 - start), target = new Uint8Array(count * 67 * 4);
        expect(baker.bakeRows(map, start, count, target)).toBe(target);
        actual.set(target, start * 67 * 4);
      }
      expect(actual).toEqual(expected);
    }
  });

  it("keeps normal vectors normalized after encoding and roughness physically bounded", () => {
    const baker = createFatTextureBaker({ textureSeed: 42 }, 256);
    const normals = baker.bake("normal"), roughness = baker.bake("roughness"), height = baker.bake("height");
    let error = 0;
    for (let i = 0; i < normals.length; i += 4) {
      error = Math.max(error, Math.abs(Math.hypot(normals[i]! / 127.5 - 1, normals[i + 1]! / 127.5 - 1, normals[i + 2]! / 127.5 - 1) - 1));
    }
    expect(error).toBeLessThan(.007);
    expect(range(roughness, 0)[0]).toBeGreaterThan(20);
    expect(range(roughness, 0)[1]).toBeLessThan(200);
    const [minimum, maximum] = range(height, 0); expect(maximum - minimum).toBeGreaterThan(40);
  });

  it("responds to wetness, collagen, vascularity and lobule controls", () => {
    const base = { textureSeed: 82 };
    const dry = bakeFatTexture({ ...base, wetness: 0 }, 96, "roughness");
    const wet = bakeFatTexture({ ...base, wetness: 1 }, 96, "roughness");
    expect(wet.reduce((sum, value, index) => sum + (index % 4 === 0 ? value : 0), 0)).toBeLessThan(dry.reduce((sum, value, index) => sum + (index % 4 === 0 ? value : 0), 0));
    expect(bakeFatTexture({ ...base, septaStrength: 0 }, 96, "color")).not.toEqual(bakeFatTexture({ ...base, septaStrength: 2 }, 96, "color"));
    expect(bakeFatTexture({ ...base, vascularity: 0 }, 96, "color")).not.toEqual(bakeFatTexture({ ...base, vascularity: 2 }, 96, "color"));
    expect(bakeFatTexture({ ...base, lobuleScale: .5 }, 96, "height")).not.toEqual(bakeFatTexture({ ...base, lobuleScale: 2 }, 96, "height"));
  });

  it("caps working memory and rejects oversized requests, invalid seeds and row writes", () => {
    expect(() => createFatTextureBaker({ textureSeed: 1 }, 8192)).toThrow(RangeError);
    expect(() => createFatTextureBaker({ textureSeed: NaN }, 32)).toThrow(RangeError);
    expect(() => createFatTextureBaker({ textureSeed: 1, wetness: 1.1 }, 32)).toThrow(RangeError);
    const baker = createFatTextureBaker({ textureSeed: 1 }, 32);
    expect(() => baker.bakeRows("color", -1, 3)).toThrow(RangeError);
    expect(() => baker.bakeRows("color", 31, 2)).toThrow(RangeError);
    expect(() => baker.bakeRows("color", 0, 1, new Uint8Array(1))).toThrow(RangeError);
    expect(baker.bakeRows("color", 0, 0)).toHaveLength(0);
  });

  it.runIf(process.env.VISCERA_FAT_BENCHMARK === "1")("bakes and audits four real 4096² maps with bounded scratch memory", () => {
    const start = performance.now(), baker = createFatTextureBaker({ textureSeed: 20261018 }, 4096);
    console.info(`Fat 4K scalar fields: ${(performance.now() - start).toFixed(0)} ms; scratch ${baker.workingBytes / 1024 ** 2} MiB`);
    expect(baker.workingBytes).toBeLessThanOrEqual(8 * 1024 ** 2);
    for (const map of FAT_TEXTURE_MAPS) {
      const before = performance.now(), data = baker.bake(map);
      expect(data.length).toBe(4096 * 4096 * 4); auditEdges(data, 4096);
      console.info(`Fat 4K ${map}: ${(performance.now() - before).toFixed(0)} ms; ${data.byteLength / 1024 ** 2} MiB; range ${range(data, 0)}`);
    }
  }, 120_000);
});
