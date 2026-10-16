/** The browser joint flow against the API's own draws and samples (src/__fixtures__/joint-v2.json, written by
 *  scripts/export_joint_web.py from the active bundle): numpy's generator bit for bit, the uniforms exactly, the
 *  inverse flow and the decoded recipe within float32 rounding. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flowInverse, parseJointModel, sampleJointControls, type JointModelMeta } from "./atlasJointLocal";
import { Pcg64 } from "./numpyRandom";

interface Fixture {
  model_sha256: string;
  rng: { seed: number; raw_uint64: string[]; uint32_pair: number[]; lemire_1_4_after_pair: number; doubles: number[] }[];
  samples: { template_id: string; seed: number; temperature: number; condition: number; renderer_seeds: number[]; z: number[]; warped: number[]; flow_values: number[]; controls: Record<string, number>; material: Record<string, unknown> }[];
}
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const fixture = JSON.parse(read("./__fixtures__/joint-v2.json").toString()) as Fixture;
const meta = JSON.parse(read("../public/models/joint-v2/model.json").toString()) as JointModelMeta;
const weights = read("../public/models/joint-v2/weights.bin");
const model = parseJointModel(meta, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
const maxAbs = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

describe("numpy's generator in the browser", () => {
  it("matches PCG64's raw outputs, uint32 halves, Lemire draws and doubles for every fixture seed", () => {
    for (const row of fixture.rng) {
      const raw = new Pcg64(row.seed);
      expect([raw.nextUint64(), raw.nextUint64(), raw.nextUint64()].map(String)).toEqual(row.raw_uint64);
      const fresh = new Pcg64(row.seed);
      expect(fresh.uint32s(2)).toEqual(row.uint32_pair);
      expect(fresh.integers(1, 4)).toBe(row.lemire_1_4_after_pair);
      expect(new Pcg64(row.seed).uniform(0, 1, 4)).toEqual(row.doubles);
    }
  });
});

describe("the joint flow in the browser", () => {
  it("is the exported active model", () => {
    expect(model.meta.model_sha256).toBe(fixture.model_sha256);
    expect(model.meta.config).toMatchObject({ layers: 6, bins: 8, blocks: 2, hidden: 96 });
  });
  it("replays the API's samples: seeds and uniforms exactly, the flow and recipe within float32 rounding", () => {
    const worst = { warped: 0, flow: 0, controls: 0, material: 0 };
    for (const sample of fixture.samples) {
      const ours = sampleJointControls(model, sample.template_id, sample.seed, sample.temperature);
      expect(ours.condition).toBe(sample.condition);
      expect(ours.rendererSeeds).toEqual(sample.renderer_seeds);
      expect(ours.z).toEqual(sample.z);
      worst.warped = Math.max(worst.warped, maxAbs(ours.warped, sample.warped));
      worst.flow = Math.max(worst.flow, maxAbs(ours.flowValues, sample.flow_values));
      const names = Object.keys(sample.controls);
      expect(Object.keys(ours.controls)).toEqual(names);
      worst.controls = Math.max(worst.controls, maxAbs(names.map((n) => ours.controls[n]!), names.map((n) => sample.controls[n]!)));
      const recipe = ours.material as unknown as Record<string, unknown>;
      expect(Object.keys(recipe)).toEqual(Object.keys(sample.material));
      for (const [key, value] of Object.entries(sample.material)) {
        if (typeof value === "number" && key !== "seed") worst.material = Math.max(worst.material, Math.abs((recipe[key] as number) - value) / Math.max(1, Math.abs(value)));
        else expect(recipe[key]).toBe(value);
      }
      // the API's flow output replayed from the API's own warped draws: the arithmetic alone
      const replayed = flowInverse(model, sample.warped, model.meta.conditions[sample.condition]!, 0);
      expect(maxAbs(Array.from(replayed), sample.flow_values)).toBeLessThan(5e-5);
    }
    console.log(`joint flow vs API (${fixture.samples.length} samples): warped ≤ ${worst.warped.toExponential(2)}, flow ≤ ${worst.flow.toExponential(2)}, controls ≤ ${worst.controls.toExponential(2)}, recipe rel ≤ ${worst.material.toExponential(2)}`);
    expect(worst.warped).toBeLessThan(2e-6);
    expect(worst.flow).toBeLessThan(5e-5);
    expect(worst.controls).toBeLessThan(5e-5);
    expect(worst.material).toBeLessThan(5e-5);
  });
  it("refuses what the API refuses", () => {
    expect(() => sampleJointControls(model, "no-such-template", 1, 1)).toThrow(/absent/);
    expect(() => sampleJointControls(model, fixture.samples[0]!.template_id, 1, 1, "severe")).toThrow(/severity band/);
    expect(() => sampleJointControls(model, fixture.samples[0]!.template_id, -1, 1)).toThrow(/seed/);
    expect(() => sampleJointControls(model, fixture.samples[0]!.template_id, 1, 2)).toThrow(/temperature/);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
import fs from "node:fs";
import path from "node:path";
import { primeJointModel, sampleJointLocally } from "./atlasJointLocal";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";

const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES ?? path.resolve(process.cwd(), "datasets/atlas/cohort-v2/templates");
const post = async (route: string, body: unknown) => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

describe.skipIf(!online)("the browser joint flow against the API's route", () => {
  it("samples the same controls, recipe and geometry as /api/atlas/sample-joint", async () => {
    primeJointModel(model);
    const catalog = await fetch(`${API}/api/atlas/catalog`).then((r) => r.json());
    expect(catalog.renderer_version).toBe("disease-v2");
    for (const [templateId, seed, temperature] of [["hra-liver-female", 7, 0.8], ["hra-liver-female", 42, 1.0], ["bp3d-stomach-male", 1729, 1.5]] as const) {
      const organ = catalog.organs.find((o: { templates: { id: string }[] }) => o.templates.some((t) => t.id === templateId));
      const template = { ...organ.templates.find((t: { id: string }) => t.id === templateId) } as AtlasTemplate;
      template.normalization_mm = JSON.parse(fs.readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8")).normalization_mm;
      const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: templateId, seed, controls: Object.fromEntries(catalog.controls.map((c: { key: string; default: number }) => [c.key, c.default])), appearance: "tissue", material: { ...catalog.materials.defaults[organ.id] } };
      const reference = (await post("/api/atlas/generate", { ...spec, seed: 42 })) as AtlasGeneration;
      const api = (await post("/api/atlas/sample-joint", { spec, seed, temperature })) as AtlasGeneration;
      const ours = await sampleJointLocally(reference, template, spec, temperature, "auto");
      const names = Object.keys(api.spec.controls);
      expect(Object.keys(ours.spec.controls)).toEqual(names);
      expect(maxAbs(names.map((n) => ours.spec.controls[n]!), names.map((n) => api.spec.controls[n]!))).toBeLessThan(1e-6);
      const apiMaterial = api.spec.material as unknown as Record<string, number | string>, ourMaterial = ours.spec.material as unknown as Record<string, number | string>;
      for (const key of Object.keys(apiMaterial)) {
        if (typeof apiMaterial[key] === "number" && key !== "seed") expect(Math.abs((ourMaterial[key] as number) - (apiMaterial[key] as number))).toBeLessThan(1e-6 * Math.max(1, Math.abs(apiMaterial[key] as number)));
        else expect(ourMaterial[key]).toBe(apiMaterial[key]);
      }
      const provenance = ours.summary.joint_model as Record<string, unknown>, theirs = api.summary.joint_model as Record<string, unknown>;
      for (const key of ["method", "model_sha256", "bundle_sha256", "material_seed", "renderer_seeds", "request_seed", "temperature", "model_generation", "severity", "profile_id", "spatial_seed"]) expect(provenance[key]).toEqual(theirs[key]);
      const positions = maxAbs(ours.scene.organs[0]!.positions, api.scene.organs[0]!.positions);
      expect(positions).toBeLessThan(1e-4);
      console.log(`${templateId} seed ${seed} T ${temperature}: controls, recipe and provenance agree; positions within ${positions.toExponential(2)} mm`);
    }
  });
});
