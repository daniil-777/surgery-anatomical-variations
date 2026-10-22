import { describe, expect, it } from "vitest";
import { safeFileName, shouldCompress, uniqueName, zipEntryPaths, zipFileName } from "./zipNames";

describe("download names", () => {
  it("makes names safe on every desktop system", () => {
    expect(safeFileName("Liver v2")).toBe("Liver v2");
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("trailing dots...")).toBe("trailing dots");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("", "Item")).toBe("Item");
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("nul.txt")).toBe("_nul.txt");
    expect(safeFileName("tab\there")).toBe("tab here");
    const long = safeFileName(`${"a".repeat(200)}.png`);
    expect([...long].length).toBe(120);
    expect(long.endsWith(".png")).toBe(true);
  });

  it("numbers duplicates case-insensitively", () => {
    const used = new Set<string>();
    expect(uniqueName("still.png", used)).toBe("still.png");
    expect(uniqueName("Still.PNG", used)).toBe("Still 2.PNG");
    expect(uniqueName("still.png", used)).toBe("still 3.png");
    expect(uniqueName("README", used)).toBe("README");
    expect(uniqueName("readme", used)).toBe("readme 2");
  });

  it("lays out zip entries for one or several items", () => {
    expect(zipEntryPaths([{ title: "Liver", filenames: ["liver.glb", "albedo.png", "Albedo.png"] }])).toEqual([
      ["liver.glb", "albedo.png", "Albedo 2.png"],
    ]);
    expect(
      zipEntryPaths([
        { title: "Liver", filenames: ["mesh.glb"] },
        { title: "Liver", filenames: ["mesh.glb"] },
        { title: "Run / 1", filenames: ["run.webm", "data.json"] },
      ]),
    ).toEqual([["Liver/mesh.glb"], ["Liver 2/mesh.glb"], ["Run 1/run.webm", "Run 1/data.json"]]);
  });

  it("names the zip and compresses only text", () => {
    expect(zipFileName(["Liver: v2"])).toBe("Liver v2.zip");
    expect(zipFileName(["a", "b"])).toBe("Library Items.zip");
    expect(zipFileName([""])).toBe("Library Item.zip");
    expect(shouldCompress("data.json")).toBe(true);
    expect(shouldCompress("x", "application/json")).toBe(true);
    expect(shouldCompress("run.webm", "video/webm")).toBe(false);
    expect(shouldCompress("mesh.glb")).toBe(false);
  });
});
