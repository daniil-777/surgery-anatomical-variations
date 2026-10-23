/** The browser text compiler (atlasTextCompiler.ts) against the route's own answers: src/__fixtures__/text-compiler.json,
 *  written by scripts/export_text_compiler_web.py from services.api.atlas.compile called in-process for disease-v2
 *  specs (no trained wording bundle), a stratified selection of tracked and adversarial phrases on contexts that cover
 *  healthy and diseased specs, non-default and photo-derived surface recipes, clay and source appearance, controls at
 *  their bounds and the two repaired templates — and, when it runs, against POST /api/atlas/compile itself.
 *  Status, message, plan, fingerprint and every other field must be identical; the floats the bounded least-squares
 *  solver produces (the solved controls, the measured and requested extents, the relative error) within 1e-9, since
 *  the SVD and the transcendental functions are not numpy's to the last bit. The template vertices are the templates-v3
 *  npz arrays, which the bundled reference specimens carry bit for bit (scripts/export_text_compiler_web.py checks). */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AtlasCatalog, AtlasGeneration, AtlasSpec } from "./atlas";
import {
  compileTextLocally, deformedExtents, planFingerprint, primeTextCompilerTables, pyFormatG, pyRepr, pyRound, pythonStrings, sha256Hex, validateSemanticPlan,
  TextCompilerRequestError, type TextCompilerTables,
} from "./atlasTextCompiler";

interface Case { text: string; context: number; origin: string; result: Record<string, unknown> }
interface Fixture {
  format: string; tables_sha256: string; pydantic: string; python: string; route: string; library: AtlasCatalog;
  contexts: { name: string; spec: AtlasSpec }[]; signatures: number; pool: number; cases: Case[];
  python_numbers: [number, number, string, string][]; python_strings: [string, string, string][];
}
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const tablesText = read("../public/models/text-compiler/tables.json").toString("utf8");
const tables = JSON.parse(tablesText) as TextCompilerTables;
const fixture = JSON.parse(read("./__fixtures__/text-compiler.json").toString("utf8")) as Fixture;
primeTextCompilerTables(tables);

// ---------------------------------------------------------------------------------------------- the template vertices
/** One float64 array of a numpy .npz archive (a zip of .npy members, deflated or stored). */
function readNpz(file: string, member: string): Float64Array {
  const zip = readFileSync(file);
  let directoryEnd = zip.length - 22;
  while (directoryEnd >= 0 && zip.readUInt32LE(directoryEnd) !== 0x06054b50) directoryEnd--;
  if (directoryEnd < 0) throw new Error(`${file}: not a zip archive`);
  let offset = zip.readUInt32LE(directoryEnd + 16);
  for (let entry = zip.readUInt16LE(directoryEnd + 10); entry > 0; entry--) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${file}: malformed central directory`);
    const method = zip.readUInt16LE(offset + 10), compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32);
    const localHeader = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== `${member}.npy`) continue;
    const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const npy = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null;
    if (!npy) throw new Error(`${file}: unsupported zip compression ${method}`);
    if (npy.toString("latin1", 0, 6) !== "\x93NUMPY") throw new Error(`${file}: ${name} is not an npy array`);
    const headerStart = npy[6] === 1 ? 10 : 12, headerLength = npy[6] === 1 ? npy.readUInt16LE(8) : npy.readUInt32LE(8);
    const header = npy.toString("latin1", headerStart, headerStart + headerLength);
    if (!header.includes("'descr': '<f8'") || !header.includes("'fortran_order': False")) throw new Error(`${file}: ${name} is not a C-ordered float64 array`);
    const data = npy.subarray(headerStart + headerLength);
    return new Float64Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  throw new Error(`${file}: no member ${member}`);
}
const templateRoot = path.resolve(process.cwd(), tables.template_root);
const specimens = new Map<string, Promise<AtlasGeneration>>();
const loaded: string[] = [];
/** The bundled reference specimen as the public copy hands it over: the templates-v3 vertices as rest_positions. */
const references = (templateId: string): Promise<AtlasGeneration> => {
  loaded.push(templateId);
  let specimen = specimens.get(templateId);
  if (!specimen) {
    const entry = tables.templates.find((t) => t.template_id === templateId)!;
    specimen = Promise.resolve({
      spec: { renderer_version: "disease-v2", template_id: templateId, seed: 42, controls: {}, appearance: "tissue", template_sha256: entry.artifact_sha256 },
      scene: { organs: [{ id: entry.organ, rest_positions: Array.from(readNpz(path.join(templateRoot, `${templateId}.npz`), "vertices_mm")) }] },
      summary: {},
    } as unknown as AtlasGeneration);
    specimens.set(templateId, specimen);
  }
  return specimen;
};

// ---------------------------------------------------------------------------------------------- comparing answers
/** Fields the bounded least-squares solver produces: equal to 1e-9 (absolute); every other value exactly. */
const SOLVED = new Set(["controls", "measured_extent_mm", "requested_extent_mm", "max_dimension_relative_error"]);
function differences(ours: unknown, theirs: unknown, at: string, tolerant: boolean, out: string[], worst: { value: number }): string[] {
  if (typeof ours === "number" && typeof theirs === "number") {
    if (Object.is(ours, theirs) || (ours === theirs && !tolerant)) return out;
    const delta = Math.abs(ours - theirs);
    if (tolerant) { worst.value = Math.max(worst.value, delta); if (delta <= 1e-9) return out; }
    if (ours !== theirs) out.push(`${at}: ${ours} ≠ ${theirs}`);
    return out;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    if (ours.length !== theirs.length) out.push(`${at}: ${ours.length} items ≠ ${theirs.length}`);
    else ours.forEach((value, i) => differences(value, theirs[i], `${at}[${i}]`, tolerant, out, worst));
    return out;
  }
  if (ours && theirs && typeof ours === "object" && typeof theirs === "object") {
    const a = Object.keys(ours), b = Object.keys(theirs);
    // Python's dict order, compared as JSON.parse hands both answers over (integer-like keys come first there)
    if (a.join() !== b.join()) out.push(`${at}: keys ${a.join()} ≠ ${b.join()}`);
    for (const key of a) if (key in theirs) differences((ours as Record<string, unknown>)[key], (theirs as Record<string, unknown>)[key], `${at}.${key}`, tolerant || SOLVED.has(key), out, worst);
    return out;
  }
  if (ours !== theirs) out.push(`${at}: ${JSON.stringify(ours)?.slice(0, 240)} ≠ ${JSON.stringify(theirs)?.slice(0, 240)}`);
  return out;
}
/** Our answer, or the HTTP status and detail a refused request gets. */
async function answer(text: string, spec: AtlasSpec, library: AtlasCatalog): Promise<Record<string, unknown>> {
  try { return await compileTextLocally(text, spec, library, references); }
  catch (error) { if (error instanceof TextCompilerRequestError) return { http_status: error.status, detail: error.message }; throw error; }
}
const detailText = (detail: unknown) => (Array.isArray(detail) ? detail.join("; ") : String(detail));

type SemanticPlan = Parameters<typeof validateSemanticPlan>[1];
interface SemanticCase {
  id: string; context: string; text: string; status: string; operations?: SemanticPlan["operations"];
  overrides?: Partial<AtlasSpec>; width_ratio?: number; height_ratio?: number; appearance?: string; material?: null;
}
const semanticFixture = JSON.parse(read("../../../tests/fixtures/semantic-policy-1.0.1.json").toString("utf8")) as {
  policy_version: string; cases: SemanticCase[];
};
const semanticSpec = (row: SemanticCase): AtlasSpec => {
  const original = fixture.contexts.find((c) => c.name === row.context)!.spec;
  return structuredClone({ ...original, ...row.overrides, controls: { ...original.controls, ...row.overrides?.controls } });
};
let semanticPython: Record<string, unknown>[] | null = null;
function semanticPythonAnswers(): Record<string, unknown>[] {
  if (semanticPython) return semanticPython;
  const store = mkdtempSync(path.join(tmpdir(), "viscera-semantic-parity-"));
  try {
    // Evaluate the authored cases against current Python, not freshly blessed golden outputs.
    const code = `import json,sys\nsys.path[:0]=['py','.']\nfrom scripts.export_text_compiler_web import route_result\nfrom viscera_core.atlas_semantic import context_from_spec,make_plan,validate_plan\nrows=json.load(sys.stdin)\nprint(json.dumps([validate_plan(make_plan(r['operations']),context_from_spec(r['spec']),text=r['text']) if 'operations' in r else route_result(r['text'],r['spec']) for r in rows],allow_nan=False))`;
    semanticPython = JSON.parse(execFileSync(path.resolve(".venv/bin/python"), ["-c", code], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, VISCERA_MODEL_STORE: store, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
      input: JSON.stringify(semanticFixture.cases.map((row) => ({ ...row, spec: semanticSpec(row) }))),
    })) as Record<string, unknown>[];
    return semanticPython;
  } finally { rmSync(store, { recursive: true, force: true }); }
}

describe("semantic policy 1.0.1 independent intent and current Python parity", () => {
  for (const [index, row] of semanticFixture.cases.entries()) {
    it(row.id, async () => {
      const spec = semanticSpec(row), before = structuredClone(spec);
      let ours: Record<string, unknown>;
      if (row.operations) {
        const plan: SemanticPlan = { schema_version: "atlas-semantic-1", status: "accepted", operations: row.operations,
          message: "Prepared bounded anatomy appearance edits.", interpretation: "authored_visual_design_not_clinical_inference" };
        const context = { organ: tables.templates.find((t) => t.template_id === spec.template_id)!.organ,
          disease: spec.disease ?? null, material: spec.material ?? null, controls: spec.controls,
          appearance: spec.appearance, renderer_version: spec.renderer_version } as Parameters<typeof validateSemanticPlan>[2];
        ours = { ...validateSemanticPlan(tables, plan, context, row.text) };
      } else ours = await answer(row.text, spec, fixture.library);
      expect(ours.status).toBe(row.status);
      const theirs = semanticPythonAnswers()[index]!;
      expect(theirs.status).toBe(row.status);
      expect(differences(ours, theirs, "$", false, [], { value: 0 })).toEqual([]);
      expect(spec).toEqual(before);
      if (!row.operations) expect(ours.policy_version).toBe(semanticFixture.policy_version);
      if (row.status !== "accepted") { expect(ours.spec).toBeUndefined(); expect(ours.operations).toEqual([]); }
      if (row.width_ratio !== undefined || row.height_ratio !== undefined) {
        const result = ours.spec as AtlasSpec, meta = tables.templates.find((t) => t.template_id === spec.template_id)!;
        const rest = readNpz(path.join(templateRoot, `${spec.template_id}.npz`), "vertices_mm");
        const old = deformedExtents(rest, spec.controls, meta.control_limits, meta.normalization_mm);
        const updated = deformedExtents(rest, result.controls, meta.control_limits, meta.normalization_mm);
        if (row.width_ratio !== undefined) expect(Math.abs(updated[0]/old[0]-row.width_ratio)).toBeLessThanOrEqual(1e-4);
        if (row.height_ratio !== undefined) expect(Math.abs(updated[1]/old[1]-row.height_ratio)).toBeLessThanOrEqual(1e-4);
      }
      if (row.appearance !== undefined) expect((ours.spec as AtlasSpec).appearance).toBe(row.appearance);
      if ("material" in row) expect((ours.spec as AtlasSpec).material ?? null).toBeNull();
    });
  }
});

describe("Python's arithmetic and strings in the browser compiler", () => {
  it("is the exported table set", () => {
    expect(tables.format).toBe("viscera-atlas-text-compiler-web-1");
    expect(sha256Hex(tablesText)).toBe(fixture.tables_sha256);
    expect(tables.templates.length).toBe(24);
  });
  it("rounds, formats and prints floats as CPython does (exact ties half-even, signed zeros, exponents)", () => {
    for (const [x, rounded, general, repr] of fixture.python_numbers) {
      expect(Object.is(pyRound(x, 8), rounded), `round(${repr}, 8)`).toBe(true);
      expect(pyFormatG(x), `format(${repr}, "g")`).toBe(general);
      expect(pyRepr(x), `repr(${repr})`).toBe(repr);
    }
  });
  it("lowers and strips as CPython does (final sigma, special casing, Unicode whitespace)", () => {
    const { lower, strip } = pythonStrings(tables);
    for (const [s, lowered, stripped] of fixture.python_strings) { expect(lower(s)).toBe(lowered); expect(strip(s)).toBe(stripped); }
  });
  it("fingerprints plans as plan_fingerprint does", () => {
    const accepted = fixture.cases.filter((c) => typeof c.result.plan_sha256 === "string");
    expect(accepted.length).toBeGreaterThan(50);
    for (const c of accepted) expect(planFingerprint(c.result.semantic_plan as Parameters<typeof planFingerprint>[0])).toBe(c.result.plan_sha256);
  });
});

describe("the browser text compiler replays the route's answers", () => {
  it("answers every fixture case as services.api.atlas.compile did", { timeout: 600_000 }, async () => {
    const worst = { value: 0 };
    let identical = 0, tolerated = 0;
    const failures: string[] = [], statuses = new Map<string, number>();
    const started = performance.now();
    for (const c of fixture.cases) {
      const ours = await answer(c.text, fixture.contexts[c.context]!.spec, fixture.library);
      const key = String(c.result.status ?? `HTTP ${String(c.result.http_status)}`);
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
      if ("http_status" in c.result) {
        if (ours.http_status !== c.result.http_status || ours.detail !== detailText(c.result.detail)) failures.push(`${JSON.stringify(c.text.slice(0, 80))}: ${JSON.stringify(ours)} ≠ HTTP ${String(c.result.http_status)} ${detailText(c.result.detail)}`);
        else identical++;
        continue;
      }
      const each = { value: 0 };
      const out = differences(ours, c.result, "$", false, [], each);
      worst.value = Math.max(worst.value, each.value);
      if (out.length) failures.push(`${JSON.stringify(c.text.slice(0, 80))} on ${fixture.contexts[c.context]!.name}: ${out.slice(0, 3).join("; ")}`);
      else if (each.value > 0) tolerated++;
      else identical++;
    }
    const seconds = (performance.now() - started) / 1000;
    console.log(`text compiler vs route (${fixture.cases.length} cases of ${fixture.signatures} answer signatures, ${fixture.contexts.length} contexts; ${[...statuses].map(([k, n]) => `${k} ${n}`).join(", ")}): ` +
      `${identical} identical, ${tolerated} identical but for solver floats within ${worst.value.toExponential(2)}, ${failures.length} different; ${seconds.toFixed(1)} s`);
    expect(failures.slice(0, 20)).toEqual([]);
    expect(worst.value).toBeLessThan(1e-9);
  });
  it("loads a reference only to measure, and refuses a reference of another surface", async () => {
    loaded.length = 0;
    const healthy = fixture.contexts.find((c) => c.name === "stomach-shaped")!.spec;
    await answer("healthier", healthy, fixture.library);
    await answer("make the liver cut", healthy, fixture.library);
    expect(loaded).toEqual([]);
    await answer("make it 5% wider", healthy, fixture.library);
    expect(loaded).toEqual(["bp3d-stomach-male"]);
    const wrong = async () => ({ spec: { template_id: "bp3d-stomach-male", template_sha256: "0".repeat(64) }, scene: { organs: [{ rest_positions: [] }] }, summary: {} }) as unknown as AtlasGeneration;
    await expect(compileTextLocally("make it 5% wider", healthy, fixture.library, wrong)).rejects.toThrow(/not the .* surface the API measures/);
  });
  it("refuses a request FastAPI refuses and a library the tables do not describe", async () => {
    const healthy = fixture.contexts.find((c) => c.name === "liver-default")!.spec;
    await expect(compileTextLocally("", healthy, fixture.library, references)).rejects.toThrow("String should have at least 1 character");
    await expect(compileTextLocally("x".repeat(4001), healthy, fixture.library, references)).rejects.toThrow("String should have at most 4000 characters");
    await expect(compileTextLocally("wider", { ...healthy, renderer_version: undefined } as unknown as AtlasSpec, fixture.library, references)).rejects.toThrow(/disease-v2/);
    await expect(compileTextLocally("wider", { ...healthy, seed: -1 }, fixture.library, references)).rejects.toThrow(TextCompilerRequestError);
    await expect(compileTextLocally("wider", { ...healthy, template_id: "hra-liver-unknown" }, fixture.library, references)).rejects.toThrow("'Template hra-liver-unknown is unavailable'");
    const altered = structuredClone(fixture.library);
    altered.organs[0]!.templates[0]!.control_limits = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    await expect(compileTextLocally("wider", healthy, altered, references)).rejects.toThrow(/do not describe this anatomy library/);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);

describe.skipIf(!online)("the browser text compiler against the API's route", () => {
  it("keeps the same HTTP connection usable after invalid Unicode is refused", { timeout: 35_000 }, async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const send = (route: string, payload?: unknown) => new Promise<{ status: number; text: string; localPort: number | undefined }>((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const req = httpRequest(new URL(route, API), { agent, method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, (response) => {
        const localPort = req.socket?.localPort;
        let text = "";
        response.setEncoding("utf8"); response.on("data", (chunk: string) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, text, localPort }));
      });
      req.setTimeout(10_000, () => req.destroy(new Error("HTTP validation regression timed out")));
      req.on("error", reject); req.end(body);
    });
    try {
      const before = await send("/api/health");
      const invalid = await send("/api/atlas/compile", { text: "\ud800", spec: fixture.contexts.find((c) => c.name === "liver-default")!.spec });
      const after = await send("/api/health");
      expect([before.status, invalid.status, after.status]).toEqual([200, 422, 200]);
      expect(JSON.parse(invalid.text).detail[0].type).toBe("string_unicode");
      expect(before.localPort).toBeTypeOf("number");
      expect([invalid.localPort, after.localPort]).toEqual([before.localPort, before.localPort]);
    } finally { agent.destroy(); }
  });
  it("answers as POST /api/atlas/compile does", { timeout: 600_000 }, async () => {
    const catalog = await fetch(`${API}/api/atlas/catalog`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()) as AtlasCatalog;
    // every fourth fixture case on a light context, every heavy and adversarial-origin case up to a few hundred
    const picked = fixture.cases.filter((c, i) => (c.origin === "heavy" || "http_status" in c.result ? i % 3 === 0 || "http_status" in c.result : i % 9 === 0)).slice(0, 360);
    const worst = { value: 0 };
    let identical = 0, tolerated = 0;
    const failures: string[] = [];
    for (const c of picked) {
      const spec = fixture.contexts[c.context]!.spec;
      const response = await fetch(`${API}/api/atlas/compile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: c.text, spec }), signal: AbortSignal.timeout(30_000) });
      const raw = await response.text();
      const body = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return { detail: raw }; } })();
      const theirs: Record<string, unknown> = response.ok ? body : { http_status: response.status, detail: Array.isArray(body.detail) ? (body.detail as { msg: string }[]).map((d) => d.msg).join("; ") : body.detail };
      const ours = await answer(c.text, spec, catalog);
      const each = { value: 0 };
      const out = "http_status" in theirs ? (ours.http_status === theirs.http_status && ours.detail === theirs.detail ? [] : [`${JSON.stringify(ours)} ≠ ${JSON.stringify(theirs)}`]) : differences(ours, theirs, "$", false, [], each);
      worst.value = Math.max(worst.value, each.value);
      if (out.length) failures.push(`${JSON.stringify(c.text.slice(0, 80))} on ${fixture.contexts[c.context]!.name}: ${out.slice(0, 3).join("; ")}`);
      else if (each.value > 0) tolerated++;
      else identical++;
    }
    console.log(`text compiler vs live API (${picked.length} requests): ${identical} identical, ${tolerated} identical but for solver floats within ${worst.value.toExponential(2)}, ${failures.length} different`);
    expect(failures.slice(0, 20)).toEqual([]);
  });
});
