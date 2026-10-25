import { describe, expect, it, vi } from "vitest";
import { BROWSER_GENERATOR_HEALTH, generateBrowserTileBundle } from "./browserTileGenerator";
import { DEFAULT_COLAB_APPEARANCE_MODELS, DEFAULT_COLAB_PBR_BUNDLES, selectBestColabAppearanceModel, selectBestColabPbrBundle } from "./colabModels";
import { validateEntry, type TissueEntry } from "./contracts";
import { AUTHORED_GROUP, catalogGroups, entryFamily, learnedForFamily, shortLearnedLabel } from "./learnedCatalog";
import { checkGenerator, DEFAULT_GENERATOR, generatorBaseUrl, requestGeneratedTile, validateHealth } from "./generatorClient";

const authored = (id: string): TissueEntry => validateEntry({ id, label: id, luminal: false, manifest: `${id}/native/manifest.json`, preview: `${id}/preview/manifest.json` });
const learned = (run: string, family: string, seed: number): TissueEntry => validateEntry({
  id: `learned-${run}-${family}-s${seed}`, label: `${family} · learned ${run} · seed ${seed}`, luminal: false, manifest: null,
  preview: `learned-${run}-${family}-s${seed}/preview/manifest.json`, available_resolutions: [512], family, group: `Learned · ${run}`,
  thumbnail: `learned-${run}-${family}-s${seed}/preview/thumbnail.png` });
const health = { schema: "viscera.tissue-generator/v1", ready: true, busy: false, families: ["liver", "pancreas"], modes: ["clean", "guided", "raw"],
  run_id: "tissue-lora-x", rights: { training_profile: "noncommercial-research", rights: ["noncommercial-research"] } };

describe("learned catalog metadata", () => {
  it("validates family, group and thumbnail fields", () => {
    expect(learned("pilot-ext", "liver", 3).thumbnail).toMatch(/thumbnail\.png$/);
    const base = { id: "x", label: "x", luminal: false, manifest: null, preview: "x/preview/manifest.json", available_resolutions: [512] };
    for (const bad of [{ family: "Liver!" }, { group: "" }, { group: "g".repeat(81) }, { thumbnail: "../t.png" }, { thumbnail: "x/t.jpg" }, { family: 3 }]) {
      expect(() => validateEntry({ ...base, ...bad })).toThrow();
    }
  });
  it("groups authored studies first and filters learned tiles by family", () => {
    const entries = [learned("pilot", "liver", 1), authored("liver"), authored("spleen"), learned("pilot-ext", "liver", 2), learned("pilot", "spleen", 1)];
    const groups = catalogGroups(entries);
    expect(groups.map(g => g.label)).toEqual([AUTHORED_GROUP, "Learned · pilot", "Learned · pilot-ext"]);
    expect(groups[0]!.entries.map(e => e.id)).toEqual(["liver", "spleen"]);
    expect(learnedForFamily(entries, "liver").map(e => e.id)).toEqual(["learned-pilot-liver-s1", "learned-pilot-ext-liver-s2"]);
    expect(learnedForFamily(entries, undefined)).toEqual([]);
    expect(entryFamily(authored("spleen"))).toBe("spleen");
    expect(shortLearnedLabel(learned("pilot", "liver", 7))).toBe("seed 7");
    expect(catalogGroups([])).toEqual([]);
  });
});

describe("local generator client", () => {
  it("accepts only loopback http origins", () => {
    expect(generatorBaseUrl("")).toBe(DEFAULT_GENERATOR);
    expect(generatorBaseUrl("?generator=http://localhost:9000")).toBe("http://localhost:9000");
    for (const bad of ["https://127.0.0.1:8790", "http://evil.example:8790", "http://127.0.0.1:8790/path", "http://user:pw@127.0.0.1:8790", "javascript:alert(1)", "not a url"]) {
      expect(() => generatorBaseUrl(`?generator=${encodeURIComponent(bad)}`)).toThrow();
    }
  });
  it("validates the health answer", () => {
    expect(validateHealth(health).families).toEqual(["liver", "pancreas"]);
    for (const bad of [null, { ...health, schema: "x" }, { ...health, families: [] }, { ...health, families: ["../x"] }, { ...health, modes: ["shell"] }, { ...health, rights: undefined }]) {
      expect(() => validateHealth(bad)).toThrow();
    }
  });
  it("explains an absent generator and propagates server errors", async () => {
    const refused = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(checkGenerator(DEFAULT_GENERATOR, undefined, refused)).rejects.toThrow(/Start scripts\/tissue_lora_server.py/);
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify(health), { status: 200 }));
    await expect(checkGenerator(DEFAULT_GENERATOR, undefined, ok)).resolves.toMatchObject({ run_id: "tissue-lora-x" });
    const busy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "busy" }), { status: 409 }));
    await expect(requestGeneratedTile(DEFAULT_GENERATOR, { family: "liver", mode: "clean" }, undefined, busy)).rejects.toThrow(/busy/);
    const bad = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "family must be one of ['liver']" }), { status: 400 }));
    await expect(requestGeneratedTile(DEFAULT_GENERATOR, { family: "kidney", mode: "clean" }, undefined, bad)).rejects.toThrow(/family must be one of/);
    await expect(requestGeneratedTile(DEFAULT_GENERATOR, { family: "liver", mode: "clean", seed: "007" }, undefined, ok)).rejects.toThrow(/whole number/);
    const bundle = vi.fn().mockResolvedValue(new Response("{\"schema\":\"viscera.tissue-pbr-bundle/v1\"}", { status: 200 }));
    await expect(requestGeneratedTile(DEFAULT_GENERATOR, { family: "liver", mode: "guided" }, undefined, bundle)).resolves.toContain("tissue-pbr-bundle");
    const call = bundle.mock.calls[0]!;
    expect(call[0]).toBe(`${DEFAULT_GENERATOR}/generate`);
    expect(JSON.parse(call[1].body)).toEqual({ family: "liver", mode: "guided" });
  });
  it("does not report an error when the caller cancels", async () => {
    const controller = new AbortController();
    const hanging = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const pending = checkGenerator(DEFAULT_GENERATOR, controller.signal, hanging);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
  it("limits browser generation to fitted tissues and supported modes", async () => {
    expect(validateHealth(BROWSER_GENERATOR_HEALTH).run_id).toBe("browser-exemplar-v1");
    await expect(generateBrowserTileBundle({ family: "kidney", mode: "clean", seed: "42" })).rejects.toThrow("No fitted");
    await expect(generateBrowserTileBundle({ family: "liver", mode: "guided", seed: "42" })).rejects.toThrow("clean appearance");
    await expect(generateBrowserTileBundle({ family: "liver", mode: "clean", seed: "18446744073709551616" })).rejects.toThrow("64-bit");
    expect(selectBestColabAppearanceModel(DEFAULT_COLAB_APPEARANCE_MODELS, "liver")?.id).toBe("exemplar-liver");
    expect(selectBestColabAppearanceModel(DEFAULT_COLAB_APPEARANCE_MODELS, "colonic_mucosa")).toBeUndefined();
    expect(selectBestColabPbrBundle(DEFAULT_COLAB_PBR_BUNDLES, "liver")?.id).toBe("stablematerials-liver43-refined");
    expect(selectBestColabPbrBundle(DEFAULT_COLAB_PBR_BUNDLES, "stomach")).toBeUndefined();
  });
});
