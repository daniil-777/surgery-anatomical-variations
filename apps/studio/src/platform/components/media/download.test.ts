import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildZip, type ZipProgress, type ZipSource } from "./download";
import { shouldCompress, zipEntryPaths } from "./zipNames";

function source(path: string, text: string, compress = shouldCompress(path)): ZipSource & { reads: number } {
  const blob = new Blob([text]);
  const entry = {
    path,
    size: blob.size,
    compress,
    modified: new Date("2026-10-21T10:00:00Z"),
    reads: 0,
    open: async () => {
      entry.reads += 1;
      return blob;
    },
  };
  return entry;
}

describe("streamed zip", () => {
  it("packs files sequentially and round-trips their bytes", async () => {
    const [paths] = zipEntryPaths([{ title: "Liver", filenames: ["mesh.glb", "data.json", "Data.json"] }]);
    expect(paths).toEqual(["mesh.glb", "data.json", "Data 2.json"]);
    const sources = [source(paths![0]!, "glTF binary bytes"), source(paths![1]!, JSON.stringify({ a: 1, b: "x".repeat(500) })), source(paths![2]!, "{}")];
    const progress: ZipProgress[] = [];
    const zip = await buildZip(sources, { onProgress: (event) => progress.push(event) });
    expect(zip.type).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["Data 2.json", "data.json", "mesh.glb"]);
    expect(new TextDecoder().decode(files["mesh.glb"])).toBe("glTF binary bytes");
    expect(JSON.parse(new TextDecoder().decode(files["data.json"]))).toEqual({ a: 1, b: "x".repeat(500) });
    expect(sources.every((entry) => entry.reads === 1)).toBe(true);
    const last = progress[progress.length - 1];
    expect(last?.loaded).toBe(last?.total);
    expect(progress.map((event) => event.file)).toContain(3);
  });

  it("stops when cancelled and when a file cannot be read", async () => {
    const controller = new AbortController();
    const first = source("a.txt", "a");
    const second: ZipSource = {
      path: "b.txt",
      size: 1,
      compress: false,
      open: async () => {
        controller.abort();
        return new Blob(["b"]);
      },
    };
    await expect(buildZip([first, second], { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    const failing: ZipSource = { path: "c.txt", size: 1, compress: false, open: () => Promise.reject(new Error("gone")) };
    await expect(buildZip([source("a.txt", "a"), failing])).rejects.toThrow("gone");
  });
});
