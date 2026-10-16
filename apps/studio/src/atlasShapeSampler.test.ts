/** The browser shape sampler against the API's own samples (src/__fixtures__/shape-v2.json, written by
 *  scripts/export_shape_web.py from the model the API serves): numpy's draws exactly, the ridge arithmetic to
 *  float64 rounding, scipy's trust-region refinement to the agreement its iterative arithmetic allows, and the
 *  provenance field by field. The decoder measures the cohort-v2 template vertices read from the dataset's npz. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import { parseDiseaseSupport, primeDiseaseSupport, type DiseaseSupportIndex } from "./atlasDiseaseLocal";
import { CONTROL_NAMES } from "./atlasLocal";
import { parseShapeModel, primeShapeModel, sampleShapeControls, sampleShapeLocally, type ShapeModelMeta, type ShapeProvenance, type ShapeRefinement } from "./atlasShapeSampler";
import { Pcg64 } from "./numpyRandom";
import { leastSquaresTrf } from "./trustRegionReflective";

type Refinement = Omit<ShapeRefinement, "controls"> & { controls: number[] };
interface Attempt { seed: number; draws: number[]; proposal: number[]; z?: number[]; mean?: number[]; residual_row?: number[]; refinement: Refinement | null }
interface Sample {
  template_id: string; seed: number; match_dimensions: boolean; controls: Record<string, number>; error?: string;
  current_extents_mm?: number[]; attempts?: Attempt[]; result?: { controls: number[]; template_sha256: string; model: ShapeProvenance };
}
interface Fixture {
  model_sha256: string; scipy: string; numpy: string;
  rng: { seed: number; integers_44: number; integers_44_size_1: number[]; attempt_seeds: number[] }[];
  trf: { problem: string; x0: number[]; bounds: [number, number]; x: number[]; cost: number; fun: number[]; optimality: number; nfev: number; njev: number; status: number; message: string; function_calls: number; active_mask: number[] }[];
  samples: Sample[];
}
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const fixture = JSON.parse(read("./__fixtures__/shape-v2.json").toString()) as Fixture;
const meta = JSON.parse(read("../public/models/shape-v2/model.json").toString()) as ShapeModelMeta;
const weights = read("../public/models/shape-v2/weights.bin");
const model = parseShapeModel(meta, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!)); return worst; };
const maxRel = (a: ArrayLike<number>, b: ArrayLike<number>) => { let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!) / Math.max(1, Math.abs(b[i]!))); return worst; };

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
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES ?? path.resolve(process.cwd(), "datasets/atlas/cohort-v2/templates");
const restCache = new Map<string, Float64Array>();
const restOf = (templateId: string) => { let rest = restCache.get(templateId); if (!rest) { rest = readNpz(path.join(templateRoot, `${templateId}.npz`), "vertices_mm"); restCache.set(templateId, rest); } return rest; };

// ---------------------------------------------------------------------------------------------- scipy's TRF alone
const FIT_T = Array.from({ length: 10 }, (_, t) => t), FIT_Y = [2.0, 1.3, 0.95, 0.72, 0.5, 0.41, 0.27, 0.2, 0.13, 0.1];
const QUADRATIC_A = [[3.0, 1.0, 0.0], [1.0, 2.0, 0.5], [0.0, 0.5, 1.0], [0.3, 0.3, 0.3]], QUADRATIC_B = [4.0, -3.0, 2.0, 1.0];
const PROBLEMS: Record<string, (x: Float64Array) => Float64Array> = {
  rosenbrock: (x) => Float64Array.from([10 * (x[1]! - x[0]! * x[0]!), 1 - x[0]!]),
  exponential_fit: (x) => Float64Array.from(FIT_T.map((t, i) => x[0]! * Math.exp(-x[1]! * t) + x[2]! - FIT_Y[i]!)),
  bounded_quadratic: (x) => Float64Array.from(QUADRATIC_B.map((b, i) => QUADRATIC_A[i]!.reduce((sum, a, j) => sum + a * x[j]!, 0) - b)),
};

describe("numpy's draws for the sampler", () => {
  it("takes the training-row draw and the attempt seeds the API takes", () => {
    for (const row of fixture.rng) {
      expect(new Pcg64(row.seed).integers(0, 44)).toBe(row.integers_44);
      expect(new Pcg64(row.seed).integers(0, 44, 1)).toEqual(row.integers_44_size_1);
      expect(Array.from({ length: model.meta.attempts }, (_, attempt) => (row.seed + attempt * model.meta.attempt_seed_stride) % 2 ** 32)).toEqual(row.attempt_seeds);
    }
  });
});

describe("scipy's bounded trust-region least squares in the browser", () => {
  it("takes scipy's decisions and reaches its solutions on the fixture problems", () => {
    let worst = 0;
    for (const problem of fixture.trf) {
      let calls = 0;
      const fun = PROBLEMS[problem.problem]!;
      const result = leastSquaresTrf((x) => { calls++; return fun(x); }, problem.x0, { lower: problem.bounds[0], upper: problem.bounds[1], ftol: 1e-9, xtol: 1e-9, gtol: 1e-9, maxNfev: 60 });
      expect([result.status, result.nfev, result.njev, calls, result.message, result.activeMask]).toEqual([problem.status, problem.nfev, problem.njev, problem.function_calls, problem.message, problem.active_mask]);
      worst = Math.max(worst, maxRel(result.x, problem.x));
      expect(Math.abs(result.cost - problem.cost)).toBeLessThanOrEqual(1e-12 * Math.max(1, problem.cost));
      // the optimality is Jᵀf with a 2-point J whose entries carry eps/√eps ≈ 1.5e-8 of relative rounding noise (an
      // ulp of exp divided by the step), so it is reproducible to ~1e-8·|f|; at a gtol stop both sides sit below 1e-9
      if (problem.status === 1) expect(result.optimality).toBeLessThan(1e-9);
      else expect(Math.abs(result.optimality - problem.optimality)).toBeLessThanOrEqual(1e-8);
    }
    console.log(`TRF vs scipy ${fixture.scipy} (${fixture.trf.length} problems): x within ${worst.toExponential(2)} relative, every status, nfev, njev and active set equal`);
    expect(worst).toBeLessThan(1e-9);
  });
});

describe("the learned shape sampler in the browser", () => {
  it("is the exported active model", () => {
    expect(model.meta.model_sha256).toBe(fixture.model_sha256);
    expect(model.meta.templates.length).toBe(24);
    expect(model.rows.get("hra-liver-female")?.length).toBe(44);
    expect(model.meta.templates.filter((t) => t.rest_vertex_patches.length).map((t) => t.id)).toEqual(["hra-heart-male", "hra-urinary-bladder-male"]);
  });
  it("replays the API's samples: draws exactly, proposals to float64 rounding, refined controls to the solver's agreement", () => {
    const worst = { extents: 0, z: 0, proposal: 0, refined: 0, result: 0, targets: 0, measured: 0 };
    let calls = 0, callsEqual = 0;
    for (const sample of fixture.samples) {
      const design = { controls: sample.controls, restPositions: restOf(sample.template_id) };
      if (sample.error !== undefined) { expect(() => sampleShapeControls(model, sample.template_id, sample.seed, sample.match_dimensions, design)).toThrow(sample.error); continue; }
      const ours = sampleShapeControls(model, sample.template_id, sample.seed, sample.match_dimensions, design);
      worst.extents = Math.max(worst.extents, maxRel(ours.currentExtentsMm, sample.current_extents_mm!));
      expect(ours.attempts.length).toBe(sample.attempts!.length);
      ours.attempts.forEach((attempt, i) => {
        const theirs = sample.attempts![i]!;
        expect(attempt.seed).toBe(theirs.seed);
        expect(attempt.draws).toEqual(theirs.draws);
        if (theirs.z) {
          worst.z = Math.max(worst.z, maxAbs(attempt.z!, theirs.z));
          worst.proposal = Math.max(worst.proposal, maxAbs(attempt.mean!, theirs.mean!), maxAbs(attempt.residualRow!, theirs.residual_row!));
        }
        worst.proposal = Math.max(worst.proposal, maxAbs(attempt.proposal, theirs.proposal));
        if (theirs.refinement) {
          const refined = attempt.refinement!;
          expect([refined.status, refined.optimizer_converged, refined.optimizer_message, refined.template_id]).toEqual([theirs.refinement.status, theirs.refinement.optimizer_converged, theirs.refinement.optimizer_message, theirs.refinement.template_id]);
          calls++; if (refined.decoder_calls === theirs.refinement.decoder_calls) callsEqual++;
          worst.refined = Math.max(worst.refined, maxAbs(refined.controls, theirs.refinement.controls));
          for (const [name, m] of Object.entries(theirs.refinement.measurements)) {
            const o = refined.measurements[name]!;
            worst.targets = Math.max(worst.targets, Math.abs(o.target - m.target) / m.target, Math.abs(o.tolerance_original_units - m.tolerance_original_units) / m.tolerance_original_units, Math.abs(o.before_absolute_error - m.before_absolute_error));
            worst.measured = Math.max(worst.measured, Math.abs(o.measured - m.measured));
          }
        } else expect(attempt.refinement).toBeNull();
      });
      worst.result = Math.max(worst.result, maxAbs(CONTROL_NAMES.map((name) => ours.controls[name]!), sample.result!.controls));
      const theirs = sample.result!.model;
      expect([ours.provenance.method, ours.provenance.model_sha256, ours.provenance.scope, ours.provenance.sampling, ours.provenance.match_dimensions, ours.provenance.refinement_status, ours.provenance.attempt, Object.keys(ours.provenance.requested_dimensions_mm)])
        .toEqual([theirs.method, theirs.model_sha256, theirs.scope, theirs.sampling, theirs.match_dimensions, theirs.refinement_status, theirs.attempt, Object.keys(theirs.requested_dimensions_mm)]);
      expect(Object.keys(ours.provenance.refinement)).toEqual(Object.keys(theirs.refinement));
    }
    console.log(`shape sampler vs API (${fixture.samples.length} samples, numpy ${fixture.numpy}, scipy ${fixture.scipy}): extents rel ≤ ${worst.extents.toExponential(2)}, encoded z ≤ ${worst.z.toExponential(2)}, proposals ≤ ${worst.proposal.toExponential(2)}, refined controls ≤ ${worst.refined.toExponential(2)}, results ≤ ${worst.result.toExponential(2)}, targets rel ≤ ${worst.targets.toExponential(2)}, measured extents ≤ ${worst.measured.toExponential(2)} mm; decoder-call counts equal in ${callsEqual}/${calls} refinements`);
    // the decoder and ridge are closed-form float64: rounding only; the encoded z carries numpy's float32 rounding
    expect(worst.extents).toBeLessThan(1e-12);
    expect(worst.z).toBeLessThan(1e-6);
    expect(worst.proposal).toBeLessThan(1e-12);
    expect(worst.targets).toBeLessThan(1e-12);
    // the refinement is iterative: the 2-point Jacobian divides ~1e-13 mm of decoder rounding by its 1.5e-8 step
    // (~1e-6 relative noise in J, differently rounded here and in numpy), which shifts each trust-region step by
    // that fraction; over the same sequence of decisions (equal call counts above) the controls part by ≤ 1e-7
    // (measured 1.0e-7 over 15 refinements), well inside the 1e-3 relative match the refinement guarantees
    expect(worst.refined).toBeLessThan(1e-6);
    expect(worst.result).toBeLessThan(1e-6);
    expect(callsEqual).toBe(calls);
  });
  it("refuses what the API refuses", () => {
    const design = { controls: Object.fromEntries(CONTROL_NAMES.map((name) => [name, 0])), restPositions: restOf("bp3d-stomach-male") };
    expect(() => sampleShapeControls(model, "no-such-template", 1, true, design)).toThrow(/Unsupported template/);
    expect(() => sampleShapeControls(model, "bp3d-stomach-male", -1, true, design)).toThrow(/seed/);
    expect(() => sampleShapeControls(model, "bp3d-stomach-male", 2 ** 32, true, design)).toThrow(/seed/);
    expect(() => sampleShapeControls(model, "bp3d-stomach-male", 1, true, { ...design, restPositions: [] })).toThrow(/no vertices/);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const post = async (route: string, body: unknown) => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

describe.skipIf(!online)("the browser shape sampler against the API's route", () => {
  it("samples the same controls, provenance and geometry as /api/atlas/sample", async () => {
    primeShapeModel(model);
    const catalog = await fetch(`${API}/api/atlas/catalog`).then((r) => r.json());
    const zero = Object.fromEntries(catalog.controls.map((c: { key: string; default: number }) => [c.key, c.default])) as Record<string, number>;
    // the last flag asks for a disease-v2 spec: displayed from templates-v3, whose hash differs from the trained
    // cohort-v2 one for the male bladder and the male heart (the route binds the displayed hash, the sampler
    // measures on the trained vertices)
    const cases: [string, number, boolean, Record<string, number>, boolean?][] = [
      ["hra-liver-female", 42, true, zero], ["hra-liver-female", 42, false, zero], ["hra-liver-female", 42, true, { ...zero, scale_x: 0.3, bend: -0.4, twist: 0.2 }],
      ["bp3d-stomach-male", 7, true, zero], ["hra-urinary-bladder-male", 7, true, zero],
      ["hra-urinary-bladder-male", 7, true, zero, true], ["hra-urinary-bladder-male", 11, true, { ...zero, scale_z: -0.3, taper: 0.25 }, true],
      ["hra-heart-male", 42, true, zero, true], ["hra-heart-male", 42, false, zero, true],
    ];
    // a disease-v2 spec realizes through the disease renderer, which reads its template's bundled support files;
    // node has no page to fetch them from, so they are primed from disk as the browser would have fetched them
    const supportIndex = JSON.parse(read("../public/models/disease-v2/index.json").toString()) as DiseaseSupportIndex;
    const primeSupport = (templateId: string) => {
      const entry = supportIndex.templates[templateId]!, bytes = read(`../public/models/disease-v2/${entry.file}`);
      primeDiseaseSupport(templateId, parseDiseaseSupport(entry, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    };
    const worst = { controls: 0, positions: 0 };
    for (const [templateId, seed, match, controls, v2 = false] of cases) {
      const organ = catalog.organs.find((o: { templates: { id: string }[] }) => o.templates.some((t) => t.id === templateId));
      const template = organ.templates.find((t: { id: string }) => t.id === templateId) as AtlasTemplate;
      const spec: AtlasSpec = { ...(v2 ? { renderer_version: "disease-v2" as const } : {}), template_id: templateId, seed, controls, appearance: "tissue" };
      // the displayed reference is the template's default specimen with this seed, as the public copy bundles it
      const reference = (await post("/api/atlas/generate", { ...spec, controls: zero })) as AtlasGeneration;
      // the studio sends the displayed, bound spec; the route must accept the displayed hash and bind it again
      const api = (await post("/api/atlas/sample", { spec: { ...spec, template_sha256: reference.spec.template_sha256 }, match_dimensions: match })) as AtlasGeneration;
      expect(api.spec.template_sha256).toBe(reference.spec.template_sha256);
      if (v2) primeSupport(templateId);
      const ours = await sampleShapeLocally(reference, template, spec, match, catalog.diseases);
      expect(Object.keys(ours.spec.controls)).toEqual(Object.keys(api.spec.controls));
      const deltaControls = maxAbs(CONTROL_NAMES.map((n) => ours.spec.controls[n]!), CONTROL_NAMES.map((n) => api.spec.controls[n]!));
      for (const key of ["renderer_version", "template_id", "seed", "appearance", "template_sha256"]) expect(ours.spec[key]).toEqual(api.spec[key]);
      const theirs = api.summary.model as ShapeProvenance, mine = ours.summary.model as ShapeProvenance;
      for (const key of ["method", "model_sha256", "scope", "sampling", "match_dimensions", "refinement_status", "attempt"] as const) expect(mine[key]).toEqual(theirs[key]);
      expect(Object.keys(mine.requested_dimensions_mm)).toEqual(Object.keys(theirs.requested_dimensions_mm));
      for (const [name, value] of Object.entries(theirs.requested_dimensions_mm)) expect(Math.abs(mine.requested_dimensions_mm[name]! - value)).toBeLessThan(1e-9 * value);
      if (theirs.refinement.status !== "not_requested") {
        const a = mine.refinement as Omit<ShapeRefinement, "controls">, b = theirs.refinement as Omit<ShapeRefinement, "controls">;
        expect([a.status, a.template_id, a.decoder_calls, a.optimizer_converged, a.optimizer_message, a.relative_tolerance, a.requires_geometry_validation]).toEqual([b.status, b.template_id, b.decoder_calls, b.optimizer_converged, b.optimizer_message, b.relative_tolerance, b.requires_geometry_validation]);
        for (const [name, m] of Object.entries(b.measurements)) expect(Math.abs(a.measurements[name]!.measured - m.measured)).toBeLessThan(m.tolerance_original_units);
      } else expect(mine.refinement).toEqual(theirs.refinement);
      expect((ours.scene.metadata as Record<string, unknown>).model).toBe(ours.summary.model);
      const deltaPositions = maxAbs(ours.scene.organs[0]!.positions, api.scene.organs[0]!.positions);
      worst.controls = Math.max(worst.controls, deltaControls); worst.positions = Math.max(worst.positions, deltaPositions);
      console.log(`${templateId}${v2 ? " (disease-v2)" : ""} seed ${seed} match ${match}: provenance agrees; controls within ${deltaControls.toExponential(2)}, positions within ${deltaPositions.toExponential(2)} mm (${match ? `${(theirs.refinement as ShapeRefinement).decoder_calls} decoder calls` : "bootstrap"})`);
    }
    // the bootstrap path is exact (positions to 3e-14 mm); the refined one agrees to the solver's level (the fixture
    // test: controls ≤ 1e-7), and a control difference δ moves a vertex by at most δ · limit · normalisation · |q|
    // ≈ 25 δ mm, so the realized surfaces stay within the 1e-6 mm the local realizer holds elsewhere
    expect(worst.controls).toBeLessThan(1e-6);
    expect(worst.positions).toBeLessThan(1e-6);
  });
});
