// The browser realizer against the VISCERA API itself. With the API running (VISCERA_API_URL, default port 8000) the
// same specs go to both; without it only the API-free properties are checked. Positions must agree to a micrometre,
// Jacobians and extents likewise, the material uniforms to floating-point noise.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, deformVertices, jacobianRange, realizeLocally, resolveMaterial } from "./atlasLocal";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";

const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES ?? path.resolve(process.cwd(), "datasets/atlas/cohort-v2/templates");
const post = async (route: string, body: unknown) => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!)); return m; };

describe("browser realizer, on its own", () => {
  it("leaves the rest geometry untouched at zero controls and scales it exactly", () => {
    const rest = [10, 20, 30, -5, 4, -8, 1, 1, 1];
    const zero = deformVertices(rest, { scale_x: 0 }, [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 100);
    expect(Array.from(zero)).toEqual(rest);
    const scaled = deformVertices(rest, { scale_x: 1 }, [Math.log(2), 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 100);
    expect(scaled[0]).toBeCloseTo(20, 12); expect(scaled[1]).toBeCloseTo(20, 12);
    expect(jacobianRange(rest, { scale_x: 1 }, [Math.log(2), 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 100)).toEqual([2, 2]);
  });
  it("writes canonical JSON as Python does", () => {
    expect(canonicalJson({ b: 1, a: [1.5, "x", { d: null, c: true }] })).toBe('{"a":[1.5,"x",{"c":true,"d":null}],"b":1}');
  });
  it("resolves a material recipe to the shader's uniforms", () => {
    const resolved = resolveMaterial({ version: "atlas-material-2.0.0", organ: "liver", preset: "rich", seed: 7, tint: 0.3, pigment_contrast: 0.78, mottle_scale_mm: 10, wetness: 0.45, fine_detail: 0.62, structure_strength: 0.45 } as never) as { uniforms: Record<string, unknown>; clearcoat: number };
    expect(resolved.uniforms.uAtlasSeed).toBe(7);
    expect(resolved.uniforms.uAtlasStructureMode).toBe(0);
    expect(resolved.clearcoat).toBeCloseTo(0.06 + 0.54 * 0.45, 12);
  });
});

describe.skipIf(!online)("browser realizer against the API", () => {
  const load = async (templateId: string) => {
    const catalog = await fetch(`${API}/api/atlas/catalog`).then((r) => r.json());
    const organ = catalog.organs.find((o: { templates: { id: string }[] }) => o.templates.some((t) => t.id === templateId));
    const template = { ...organ.templates.find((t: { id: string }) => t.id === templateId) } as AtlasTemplate;
    const meta = JSON.parse(fs.readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8"));
    template.normalization_mm = meta.normalization_mm;
    const spec: AtlasSpec = { ...(catalog.renderer_version ? { renderer_version: catalog.renderer_version } : {}), template_id: templateId, seed: 42,
      controls: Object.fromEntries(catalog.controls.map((c: { key: string; default: number }) => [c.key, c.default])), appearance: "tissue", material: { ...catalog.materials.defaults[organ.id] } };
    const reference = (await post("/api/atlas/generate", spec)) as AtlasGeneration;
    return { template, spec, reference };
  };

  it("matches the API's geometry, Jacobian and extent for shape controls", async () => {
    const { template, spec, reference } = await load("hra-liver-female");
    for (const controls of [{ scale_x: 0.5 }, { bend: -0.7, twist: 0.4 }, { taper: 0.9, asymmetry: -0.6, scale_z: 0.3 }, { scale_x: 1, scale_y: -1, scale_z: 1, bend: 1, twist: -1, taper: 1, asymmetry: 1 }]) {
      const request = { ...spec, controls: { ...spec.controls, ...controls } };
      const api = (await post("/api/atlas/generate", request)) as AtlasGeneration;
      const local = await realizeLocally(reference, request, template);
      const projection = (api.scene.metadata as { disease: { shape_control_projection: { applied_fraction: number; applied_controls: Record<string, number> } } }).disease.shape_control_projection;
      const ours = (local.scene.metadata as typeof api.scene.metadata & { disease: { shape_control_projection: { applied_fraction: number; applied_controls: Record<string, number> } } }).disease.shape_control_projection;
      expect(ours.applied_fraction, `applied fraction for ${JSON.stringify(controls)}`).toBe(projection.applied_fraction);
      expect(maxAbs(local.scene.organs[0]!.positions, api.scene.organs[0]!.positions), `positions for ${JSON.stringify(controls)}`).toBeLessThan(1e-6);
      // the API reports a conservative lower bound of the continuous Jacobian over its certified faces; ours is the exact
      // value at the vertices, which that bound must not exceed
      expect(local.summary.min_jacobian as number).toBeGreaterThan(0);
      expect(local.summary.min_jacobian as number).toBeGreaterThanOrEqual((api.summary.min_jacobian as number) - 1e-9);
      expect(maxAbs(local.summary.extent_mm as number[], api.summary.extent_mm as number[])).toBeLessThan(1e-6);
      // normals: ours are area-weighted, the API's are transported source normals; they agree in direction almost everywhere
      const a = local.scene.organs[0]!.normals!, b = api.scene.organs[0]!.normals!;
      let agree = 0; for (let i = 0; i < a.length; i += 3) if (a[i]! * b[i]! + a[i + 1]! * b[i + 1]! + a[i + 2]! * b[i + 2]! > Math.cos(Math.PI / 12)) agree++;
      expect(agree / (a.length / 3), "normals within 15°").toBeGreaterThan(0.97);
    }
  }, 120000);

  it("matches the API's material uniforms and finish for a surface recipe", async () => {
    const { template, spec, reference } = await load("hra-kidney-male-left");
    const material = { ...spec.material!, preset: "rich" as const, seed: 7, tint: 0.3, wetness: 0.8, pigment_contrast: 0.7 };
    const request = { ...spec, material };
    const api = (await post("/api/atlas/generate", request)) as AtlasGeneration;
    const local = await realizeLocally(reference, request, template);
    const pick = (g: AtlasGeneration) => (g.scene.metadata as { material_v2: { resolved: { uniforms: Record<string, number | number[]>; clearcoat: number; clearcoat_roughness: number; shader_sha256: string } } }).material_v2.resolved;
    const a = pick(api), b = pick(local);
    for (const [key, value] of Object.entries(a.uniforms)) {
      if (Array.isArray(value)) expect(maxAbs(value, b.uniforms[key] as number[]), key).toBeLessThan(1e-9);
      else expect(b.uniforms[key], key).toBeCloseTo(value, 9);
    }
    expect(b.clearcoat).toBeCloseTo(a.clearcoat, 12); expect(b.clearcoat_roughness).toBeCloseTo(a.clearcoat_roughness, 12);
    expect(b.shader_sha256).toBe(a.shader_sha256);
    expect(maxAbs(local.scene.organs[0]!.positions, api.scene.organs[0]!.positions)).toBe(0);
    // the same doubles hash the same way: a surface-only edit keeps the API's geometry identity (the physics cage's key)
    expect((local.scene.metadata as { geometry_sha256: string }).geometry_sha256).toBe((api.scene.metadata as { geometry_sha256: string }).geometry_sha256);
  }, 120000);

  it("matches the API's base colour after a photographed reference colour is transferred", async () => {
    const { template, spec, reference } = await load("hra-liver-female");
    const observed = { version: "reference-color-1", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), organ: "liver", observed_srgb: [0.2516, 0.1123, 0.1163], strength: 0.8, mode: "chroma" };
    for (const mode of ["chroma", "color"] as const) {
      const request = { ...spec, material: { ...spec.material!, reference_color: { ...observed, mode } } } as AtlasSpec;
      const api = (await post("/api/atlas/generate", request)) as AtlasGeneration;
      const local = await realizeLocally(reference, request, template);
      const pick = (g: AtlasGeneration) => (g.scene.metadata as { material_v2: { resolved: { uniforms: Record<string, number | number[]>; base_color_srgb: number[] } } }).material_v2.resolved;
      expect(maxAbs(pick(local).base_color_srgb, pick(api).base_color_srgb), mode).toBeLessThan(1e-7);
      expect(maxAbs(pick(local).uniforms.uAtlasBaseColor as number[], pick(api).uniforms.uAtlasBaseColor as number[]), mode).toBeLessThan(1e-7);
    }
  }, 120000);

  it("matches the API's clay colours and refuses what needs the API", async () => {
    const { template, spec, reference } = await load("bp3d-stomach-male");
    const clay = { ...spec, appearance: "clay" as const }; delete clay.material;
    const api = (await post("/api/atlas/generate", clay)) as AtlasGeneration;
    const local = await realizeLocally(reference, clay, template);
    expect(maxAbs(local.scene.organs[0]!.colors!, api.scene.organs[0]!.colors!)).toBeLessThan(1e-9);
    expect((local.scene.metadata as { appearance: { roughness: number } }).appearance.roughness).toBe((api.scene.metadata as { appearance: { roughness: number } }).appearance.roughness);
    // the seed only colours the vertex noise the tissue shader does not read: a tissue specimen with a recipe takes any
    // seed and matches the API's geometry (the joint flow samples with the request seed); other appearances keep refusing
    const reseeded = (await post("/api/atlas/generate", { ...spec, seed: 43 })) as AtlasGeneration;
    const localReseeded = await realizeLocally(reference, { ...spec, seed: 43 }, template);
    expect(localReseeded.spec.seed).toBe(43);
    expect(maxAbs(localReseeded.scene.organs[0]!.positions, reseeded.scene.organs[0]!.positions)).toBeLessThan(1e-6);
    await expect(realizeLocally(reference, { ...clay, seed: 43 }, template)).rejects.toThrow(/seed/);
    await expect(realizeLocally(reference, { ...spec, disease: { profile_id: "x", seed: 1, severity: 0.5 } } as never, template)).rejects.toThrow(/Disease/);
  }, 120000);
});
