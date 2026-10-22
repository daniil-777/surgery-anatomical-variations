import { describe, expect, it } from "vitest";
import { LABS, LAB_ID_PATTERN, TEST_LAB, getLab, isLabVisible, labForMode, labForPage, labIdFromUrl, labUrl, listLabs } from "./registry";

describe("lab registry", () => {
  it("declares ids the database accepts, each once, with distinct modes", () => {
    const ids = LABS.map((lab) => lab.id);
    for (const id of ids) expect(id).toMatch(LAB_ID_PATTERN);
    expect(new Set(ids).size).toBe(ids.length);
    const modes = LABS.flatMap((lab) => [lab.mode, ...lab.aliases]);
    expect(new Set(modes).size).toBe(modes.length);
  });

  it("offers this branch's labs (and, in development, the test lab) and hides planned ones unless enabled", () => {
    // vitest runs as a development build, like the dev server the editor end-to-end tests use
    expect(import.meta.env.DEV).toBe(true);
    expect(listLabs().map((lab) => lab.id)).toEqual(["organ", "texture-lab", "scene", "test-lab"]);
    expect(listLabs({ enabled: ["tissue"] }).map((lab) => lab.id)).toEqual(["organ", "texture-lab", "scene", "tissue", "test-lab"]);
    expect(listLabs({ enabled: ["no-such-lab"] })).toHaveLength(4);
    const tissue = getLab("tissue");
    expect(tissue).toMatchObject({ availability: "planned", mode: "tissues", title: "Tissue Lab", icon: "Layers" });
    expect(isLabVisible(tissue!)).toBe(false);
    expect(isLabVisible(tissue!, { enabled: new Set(["tissue"]) })).toBe(true);
    expect(getLab("fat")?.availability).toBe("planned");
    expect(getLab("blood")?.availability).toBe("planned");
    expect(getLab("nope")).toBeNull();
  });

  it("states what each available lab supports", () => {
    expect(getLab("organ")).toMatchObject({ mode: "atlas", title: "Organ Design", capabilities: { projects: true, recording: true } });
    expect(getLab("texture-lab")).toMatchObject({ mode: "textures", title: "Texture Lab", capabilities: { projects: true } });
    expect(getLab("scene")).toMatchObject({
      mode: "scene",
      title: "Whole Body",
      capabilities: { projects: false, recording: true, screenshot: true },
    });
    for (const lab of LABS.filter((entry) => entry.availability === "planned")) expect(lab.capabilities.projects).toBe(false);
  });

  it("builds embed URLs relative to the site base", () => {
    expect(labUrl("organ")).toBe("./?mode=atlas&embed=1&lab=organ");
    expect(labUrl(getLab("texture-lab")!)).toBe("./?mode=textures&embed=1&lab=texture-lab");
    expect(labUrl("organ", { params: { template: "female-liver", skipped: undefined, also: null, mode: "legacy" } })).toBe(
      "./?mode=atlas&embed=1&lab=organ&template=female-liver",
    );
    expect(labUrl("scene", { base: "https://daniil-777.github.io/anatomy/" })).toBe(
      "https://daniil-777.github.io/anatomy/?mode=scene&embed=1&lab=scene",
    );
    // a lab about to receive a stored document skips its default generation (DESIGN.md §15.6)
    expect(labUrl("organ", { restorePending: true, params: { restore: "no" } })).toBe("./?mode=atlas&embed=1&lab=organ&restore=pending");
    expect(labUrl("organ", { restorePending: true, extra: { template: "male-liver", embed: "0" } })).toBe(
      "./?mode=atlas&embed=1&lab=organ&restore=pending&template=male-liver",
    );
    expect(() => labUrl("nope")).toThrow(/Unknown lab/);
  });

  it("opens the development test lab from its own page", () => {
    expect(getLab("test-lab")).toBe(TEST_LAB);
    expect(TEST_LAB).toMatchObject({ entry: "px-test-lab.html", capabilities: { projects: true, recording: true } });
    expect(labUrl("test-lab", { restorePending: true })).toBe("./px-test-lab.html?embed=1&lab=test-lab&restore=pending");
    expect(labUrl(TEST_LAB, { base: "http://127.0.0.1:5182/" })).toBe("http://127.0.0.1:5182/px-test-lab.html?embed=1&lab=test-lab");
    expect(labIdFromUrl("http://127.0.0.1:5182/px-test-lab.html?embed=1&lab=test-lab&restore=pending")).toBe("test-lab");
    expect(labIdFromUrl("http://127.0.0.1:5182/px-test-lab.html")).toBe("test-lab");
    expect(labForPage("/px-test-lab.html")?.id).toBe("test-lab");
  });

  it("maps modes, aliases and entry pages back to labs", () => {
    expect(labForMode("atlas")?.id).toBe("organ");
    expect(labForMode("")?.id).toBe("organ");
    expect(labForMode(null)?.id).toBe("organ");
    expect(labForMode("TEXTURES")?.id).toBe("texture-lab");
    expect(labForMode("textures-scene")?.id).toBe("scene");
    expect(labForMode("tissues")?.id).toBe("tissue");
    expect(labForMode("legacy")).toBeNull();
    expect(labForPage("/anatomy/textures.html")?.id).toBe("texture-lab");
    expect(labForPage("/anatomy/tissues.html")?.id).toBe("tissue");
    expect(labForPage("/anatomy/")).toBeNull();
    expect(labForPage("/anatomy/index.html")).toBeNull();
  });

  it("reads the lab a URL opens", () => {
    const base = "https://example.test/anatomy/";
    expect(labIdFromUrl("./?mode=atlas&embed=1&lab=texture-lab", base)).toBe("texture-lab");
    expect(labIdFromUrl("./?mode=textures", base)).toBe("texture-lab");
    expect(labIdFromUrl("./?mode=atlas&lab=unknown", base)).toBe("organ");
    expect(labIdFromUrl("./fat.html", base)).toBe("fat");
    expect(labIdFromUrl("./", base)).toBeNull();
    expect(labIdFromUrl("./?mode=imports", base)).toBeNull();
    expect(labIdFromUrl("not a url")).toBeNull();
  });
});
