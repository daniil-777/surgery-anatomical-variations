/** The browser calibration against the API's own responses (src/__fixtures__/physics-v2.json, written by
 *  scripts/export_physics_web.py from the routes the API serves) and against the running API: the request model's
 *  refusals and v2's validation messages exactly, the excitation diagnostics and resampled features bit for bit (but
 *  for one-ulp logs), the network in float64 to rounding, and scipy's soft-L1 refinement — the same decisions, the
 *  results within 1e-9 or, where the API's answer itself moves by more under last-bit changes of its own arithmetic
 *  (the fixture records that spread per observation), within ten times that spread; the cases that use the wider
 *  bar are printed. The robust-loss extension of trustRegionReflective.ts is replayed against scipy, and its default
 *  path against bits of the solver as it was before the extension. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  calibratePlayground, calibratedPlayground, inferObservation, inferObservationLocally, parsePhysicsModel, PhysicsCalibrationError, primePhysicsModel,
  pythonStrip, traceCalibration, type PhysicsInference, type PhysicsModelMeta,
} from "./atlasPhysicsCalibration";
import type { PhysicsObservation } from "./atlasPhysics";
import { leastSquaresTrf, pairwiseSum, type RobustLoss } from "./trustRegionReflective";

type Spread = Record<"x" | "parameters" | "intervals" | "fitted" | "stress_nrmse" | "condition_number" | "minimum_sensitivity" | "noise_fraction_estimate" | "sigma_encoded", number>;
interface Case {
  name: string; class: string; observation: Record<string, unknown>;
  infer: { status: 200; body: PhysicsInference } | { status: number; detail: unknown };
  playground: { status: 200; parameters: Record<string, number>; learning_keys: string[] } | { status: number; detail: unknown };
  internals?: {
    features: number[]; member_outputs: number[][]; proposals: number[][]; initial: number[]; scale: number; sigma_encoded: number[];
    least_squares: { x: number[]; cost: number; optimality: number; nfev: number; njev: number; status: number; message: string; active_mask: number[]; function_calls: number };
  };
  api_rounding_spread?: { fields: Spread; decisions: { variant: string; nfev: number; njev: number; status: number; reasons: string[] }[] };
}
interface Fixture {
  model_sha256: string; numpy: string; scipy: string; system: string; machine: string; playground_template: string;
  playground_snapshot: Record<string, unknown>;
  trf: {
    problem: string; loss: RobustLoss; f_scale: number; x0: number[]; bounds: [number, number]; x: number[]; cost: number; fun: number[]; optimality: number;
    nfev: number; njev: number; status: number; message: string; function_calls: number; active_mask: number[];
    /** scipy's own reproducibility: its decisions and x under one-ulp residual noise and the other LAPACK SVD driver */
    scipy_rounding_spread: { decisions_stable: boolean; x: number };
  }[];
  numpy_sums: { values: number[]; sum: number }[];
  cases: Case[];
}
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const fixture = JSON.parse(read("./__fixtures__/physics-v2.json").toString("utf8")) as Fixture;
const meta = JSON.parse(read("../public/models/physics-v2/model.json").toString()) as PhysicsModelMeta;
const weights = read("../public/models/physics-v2/weights.bin");
const weightBuffer = weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength) as ArrayBuffer;
const model = parsePhysicsModel(meta, weightBuffer);
const repository = path.resolve(process.cwd());

// ---------------------------------------------------------------------------------------------- comparison
const SOLVER_FIELDS = ["parameters", "intervals", "fitted", "stress_nrmse", "condition_number", "minimum_sensitivity", "noise_fraction_estimate"] as const;
type Field = typeof SOLVER_FIELDS[number] | "neural" | "exact";
/** The field a number of a /infer response belongs to, by its path. */
function fieldOf(at: string): Field {
  if (/^(parameters|predicted_parameters)\./.test(at)) return "parameters";
  if (/^(neural_parameters|ensemble_std)\./.test(at)) return "neural";
  if (at.startsWith("parameter_intervals_90.")) return "intervals";
  if (at.startsWith("fitted_stress_pa[")) return "fitted";
  if (at === "stress_nrmse") return "stress_nrmse";
  if (at === "diagnostics.condition_number") return "condition_number";
  if (at === "diagnostics.minimum_sensitivity") return "minimum_sensitivity";
  if (at === "diagnostics.noise_fraction_estimate") return "noise_fraction_estimate";
  return "exact";   // excitation, refinement_evaluations, the echoed observation
}
/** Deviation on the field's natural scale: relative, the fitted stress relative to the observation's peak stress,
 *  the (peak-normalised) RMSE absolutely. */
function deviation(field: Field, ours: number, theirs: number, peak: number): number {
  if (field === "exact") return ours === theirs ? 0 : Infinity;
  if (field === "fitted") return Math.abs(ours - theirs) / peak;
  if (field === "stress_nrmse") return Math.abs(ours - theirs);
  return ours === theirs ? 0 : Math.abs(ours - theirs) / Math.max(Math.abs(theirs), 1e-300);
}
/** The bar of a field for one observation: 1e-9, or ten times the API's own spread where that is larger. */
const barOf = (field: Field, spread: Spread | undefined): number => (field === "exact" ? 0 : field === "neural" || !spread ? 1e-9 : Math.max(1e-9, 10 * spread[field]));

interface Tally { worst: Map<Field, number>; failures: string[] }
const tally = (): Tally => ({ worst: new Map(), failures: [] });
/** Walks the API's JSON: the same keys in the same order, strings and booleans equal, numbers within their bar. */
function compare(ours: unknown, theirs: unknown, peak: number, spread: Spread | undefined, into: Tally, at = ""): void {
  if (typeof theirs === "number") {
    if (typeof ours !== "number") { into.failures.push(`${at}: ${String(ours)} is not a number`); return; }
    const field = fieldOf(at), value = deviation(field, ours, theirs, peak), bar = barOf(field, spread);
    into.worst.set(field, Math.max(into.worst.get(field) ?? 0, value));
    if (!(value <= bar)) into.failures.push(`${at}: ${ours} vs ${theirs} (deviation ${value.toExponential(2)} > ${bar.toExponential(1)})`);
    return;
  }
  if (Array.isArray(theirs)) {
    if (!Array.isArray(ours) || ours.length !== theirs.length) { into.failures.push(`${at}: length ${Array.isArray(ours) ? ours.length : "—"} vs ${theirs.length}`); return; }
    theirs.forEach((item, i) => compare(ours[i], item, peak, spread, into, `${at}[${i}]`));
    return;
  }
  if (theirs !== null && typeof theirs === "object") {
    if (ours === null || typeof ours !== "object" || Array.isArray(ours)) { into.failures.push(`${at}: not an object`); return; }
    const a = Object.keys(ours), b = Object.keys(theirs);
    if (a.join() !== b.join()) { into.failures.push(`${at}: keys ${a.join()} vs ${b.join()}`); return; }
    for (const key of b) compare((ours as Record<string, unknown>)[key], (theirs as Record<string, unknown>)[key], peak, spread, into, at ? `${at}.${key}` : key);
    return;
  }
  if (ours !== theirs) into.failures.push(`${at}: ${JSON.stringify(ours)} vs ${JSON.stringify(theirs)}`);
}
const peakStress = (observation: Record<string, unknown>) => Math.max(...(observation.force_n as number[]).map(Math.abs)) / ((observation.reference_area_mm2 as number) * 1e-6);
const maxRel = (a: ArrayLike<number>, b: ArrayLike<number>, floor = 0) => { let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!) / Math.max(Math.abs(b[i]!), floor, 1e-300)); return worst; };
/** What the studio shows for an API refusal (atlasError): the detail, or its issues' messages joined by "; ". */
const shown = (status: number, detail: unknown) => (status === 500 ? "Request failed (500)." : typeof detail === "string" ? detail : (detail as { msg: string }[]).map((issue) => issue.msg).join("; "));
const refusal = (run: () => unknown): PhysicsCalibrationError => {
  try { run(); } catch (error) { if (error instanceof PhysicsCalibrationError) return error; throw error; }
  throw new Error("expected a refusal");
};
const relaxedReport = (rows: [string, number, number][]) => rows.map(([name, value, bar]) => `${name} ${value.toExponential(1)} (bar ${bar.toExponential(1)})`).join(", ");
/** Worst deviations per observation class, for the summary. */
class ClassTally {
  private readonly classes = new Map<string, { count: number; worst: Map<Field, number> }>();
  add(kind: string, one: Tally): void {
    const entry = this.classes.get(kind) ?? { count: 0, worst: new Map<Field, number>() };
    entry.count++;
    for (const [field, value] of one.worst) entry.worst.set(field, Math.max(entry.worst.get(field) ?? 0, value));
    this.classes.set(kind, entry);
  }
  report(): string {
    const fields: Field[] = ["parameters", "intervals", "fitted", "stress_nrmse", "condition_number", "noise_fraction_estimate", "neural"];
    return [...this.classes].map(([kind, { count, worst }]) => `  ${kind} (${count}): ${fields.map((f) => `${f} ${(worst.get(f) ?? 0).toExponential(1)}`).join(", ")}`).join("\n");
  }
}

// ---------------------------------------------------------------------------------------------- the bundled model
describe("the bundled physics network", () => {
  it("is the model the API serves, exported from the sources this port repeats", () => {
    expect(meta.model_sha256).toBe(fixture.model_sha256);
    expect(createHash("sha256").update(weights).digest("hex")).toBe(meta.weights_sha256);
    expect(model.members.length).toBe(3);
    expect(model.members.map((member) => member.map((layer) => `${layer.rows}x${layer.cols}`).join(" "))).toEqual(Array(3).fill("160x165 96x160 3x96"));
    expect(meta.application_policy).toBeNull();
    // a change of the Python this file repeats must be re-exported and re-verified
    for (const [file, digest] of Object.entries(meta.port_sources)) {
      const source = path.join(repository, file);
      if (existsSync(source)) expect(createHash("sha256").update(readFileSync(source)).digest("hex"), `${file} changed since the physics export: port the change, re-run scripts/export_physics_web.py and this test against the API`).toBe(digest);
    }
  });
  it("downloads once, without the caller's AbortSignal, refuses a corrupted download and retries afterwards", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const corrupted = Buffer.from(weights);
    corrupted[1000] = corrupted[1000]! ^ 1;   // one bit of one weight: still finite, the digest differs
    let serve = corrupted;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const body = url.endsWith("model.json") ? read("../public/models/physics-v2/model.json") : url.endsWith("weights.bin") ? serve : null;
      return body ? new Response(new Uint8Array(body)) : new Response("missing", { status: 404 });
    });
    try {
      vi.resetModules();
      const fresh = await import("./atlasPhysicsCalibration");
      await expect(fresh.loadPhysicsModel()).rejects.toThrow(/checksum mismatch/);
      serve = weights;
      const [first, second] = await Promise.all([fresh.loadPhysicsModel(), fresh.loadPhysicsModel()]);
      expect(first).toBe(second);
      expect(first.meta.model_sha256).toBe(meta.model_sha256);
      expect(requests.map((r) => r.url.replace(/^.*models/, "models"))).toEqual(["models/physics-v2/model.json", "models/physics-v2/weights.bin", "models/physics-v2/model.json", "models/physics-v2/weights.bin"]);
      expect(requests.every((r) => r.init?.signal === undefined)).toBe(true);
      // an unbundled copy answers as the API answers for a model it cannot serve, after validating the request
      serve = Buffer.alloc(0);
      vi.resetModules();
      const empty = await import("./atlasPhysicsCalibration");
      const demo = fixture.cases[0]!.observation as unknown as PhysicsObservation;
      await expect(empty.inferObservationLocally({ ...demo, provenance: "short" })).rejects.toMatchObject({ status: 422, message: "String should have at least 8 characters" });
      await expect(empty.inferObservationLocally(demo)).rejects.toMatchObject({ status: 503 });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
  it("refuses exports it does not implement", () => {
    expect(() => parsePhysicsModel({ ...meta, format: "other" }, weightBuffer)).toThrow(/Unsupported/);
    expect(() => parsePhysicsModel({ ...meta, version: "liver-inverse-sls-1.0.0" }, weightBuffer)).toThrow(/Unsupported/);
    expect(() => parsePhysicsModel({ ...meta, application_policy: {} as unknown as null }, weightBuffer)).toThrow(/application policy/);
    expect(() => parsePhysicsModel(meta, weightBuffer.slice(0, 1024))).toThrow(/layout/);
    expect(() => parsePhysicsModel({ ...meta, calibration: { ...meta.calibration, quantiles_90: [1, 2] } }, weightBuffer)).toThrow(/uncertainty calibration/);
  });
});

// ---------------------------------------------------------------------------------------------- scipy's robust least squares
const FIT_T = Array.from({ length: 10 }, (_, t) => t);
const FIT_Y = [2.0, 1.3, 0.95, 0.72, 0.5, 0.41, 0.27, 0.2, 0.13, 0.1], FIT_Y_OUTLIERS = [2.0, 1.3, 0.95, 1.52, 0.5, 0.41, 0.27, -0.3, 0.13, 0.1];
const QUADRATIC_A = [[3.0, 1.0, 0.0], [1.0, 2.0, 0.5], [0.0, 0.5, 1.0], [0.3, 0.3, 0.3]], QUADRATIC_B = [4.0, -3.0, 2.0, 1.0];
const PROBLEMS: Record<string, (x: Float64Array) => Float64Array> = {
  rosenbrock: (x) => Float64Array.from([10 * (x[1]! - x[0]! * x[0]!), 1 - x[0]!]),
  exponential_fit: (x) => Float64Array.from(FIT_T.map((t, i) => x[0]! * Math.exp(-x[1]! * t) + x[2]! - FIT_Y[i]!)),
  exponential_fit_outliers: (x) => Float64Array.from(FIT_T.map((t, i) => x[0]! * Math.exp(-x[1]! * t) + x[2]! - FIT_Y_OUTLIERS[i]!)),
  bounded_quadratic: (x) => Float64Array.from(QUADRATIC_B.map((b, i) => QUADRATIC_A[i]!.reduce((sum, a, j) => sum + a * x[j]!, 0) - b)),
};
/** leastSquaresTrf with the loss options absent, as trustRegionReflective.ts at 42b6d27 (before the robust losses)
 *  solved these problems: x, cost and optimality as IEEE-754 bit patterns. */
const PRE_EXTENSION_BITS = [
  { problem: "rosenbrock", x0: [-1.2, 1], bounds: [-1.5, 1.5], tol: 1e-9, x: ["3ff0000000000000", "3ff0000000000000"], cost: "0000000000000000", optimality: "0000000000000000", nfev: 32, njev: 26, status: 1, calls: 84, activeMask: [0, 0] },
  { problem: "rosenbrock", x0: [0.5, -0.5], bounds: [-0.9, 0.9], tol: 1e-9, x: ["3feccccccccccccc", "3fe9eb851eb839f8"], cost: "3f747ae147ae1485", optimality: "3d9af0400000e00a", nfev: 21, njev: 18, status: 1, calls: 57, activeMask: [1, 0] },
  { problem: "exponential_fit", x0: [1, 0.1, 0], bounds: [-1, 3], tol: 1e-9, x: ["3ffe7f24ff7f9049", "3fd7871107c43964", "3fabaffb26e8f4e1"], cost: "3f799bda6efd8cfc", optimality: "3e7c77324c810afa", nfev: 10, njev: 10, status: 2, calls: 40, activeMask: [0, 0, 0] },
  { problem: "bounded_quadratic", x0: [0, 0, 0], bounds: [-1, 1], tol: 1e-9, x: ["3feffffffffffffe", "bfefffffffffffff", "3fefffffffffffe7"], cost: "4019fae147ae147e", optimality: "3cd6fffffe400033", nfev: 8, njev: 8, status: 1, calls: 32, activeMask: [1, -1, 1] },
  { problem: "bounded_quadratic", x0: [0.9, -0.9, 0.9], bounds: [-1, 1], tol: 1e-9, x: ["3feffffffffffff0", "bfeffffffffffffd", "3feffffffffffffc"], cost: "4019fae147ae1483", optimality: "3cfdae147a9999bd", nfev: 5, njev: 5, status: 1, calls: 20, activeMask: [1, -1, 1] },
  { problem: "exponential_fit_outliers", x0: [1, 0.1, 0], bounds: [-1, 3], tol: 1e-8, x: ["4003d06c9d8651fd", "3fc744293c9ff76f", "bfe1ecfd53191410"], cost: "3fd858bd0a646e9a", optimality: "3f0476039a39667e", nfev: 13, njev: 12, status: 2, calls: 49, activeMask: [0, 0, 0] },
  { problem: "rosenbrock", x0: [-1.2, 1], bounds: [-1.5, 1.5], tol: 1e-12, x: ["3ff0000000000000", "3ff0000000000000"], cost: "0000000000000000", optimality: "0000000000000000", nfev: 32, njev: 26, status: 1, calls: 84, activeMask: [0, 0] },
  { problem: "exponential_fit", x0: [2.5, 0.5, 0.3], bounds: [0, 3], tol: 1e-6, x: ["3ffe7f24afeab017", "3fd787137a4c665a", "3fabb015d9f8d468"], cost: "3f799bda6f06b735", optimality: "3ea4fe94b4f6c5c7", nfev: 10, njev: 10, status: 1, calls: 40, activeMask: [0, 0, 0] },
];
const bits = (value: number) => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value); return view.getBigUint64(0).toString(16).padStart(16, "0"); };
/** Robust-loss problems whose path parts from scipy's by rounding alone, each traced to its cause. Both sides stop
 *  by the same test at the same minimiser; the number of evaluations differs. */
const ROUNDING_DIVERGENT: Record<string, string> = {
  // far from the optimum the arctan loss clamps both rows' J_scale at √eps, the augmented system [J·D; diag_h^½] is
  // graded by eight orders of magnitude and LAPACK's gesdd carries ~1e-12 relative error in Uᵀf (the one-sided Jacobi
  // SVD here ~1e-16): the first step's p_h differs by 1.4e-12, Rosenbrock's valley amplifies it after three calls
  "rosenbrock arctan C=0.1": "graded augmented system (gesdd's Uᵀf error)",
  // from the symmetric start (0.9, −0.9, 0.9) the first trust-region step reaches the three bounds at strides equal
  // to ~1e-9 relative (huber: 0.99999999633, 0.99999999610, 0.99999999022), so which coordinate reflects in
  // select_step is decided by the step's rounding; scipy's own path on arctan changes under one-ulp residual noise
  "bounded_quadratic huber C=0.1": "three bounds reached at strides equal to 1e-9",
  "bounded_quadratic cauchy C=0.1": "three bounds reached at strides equal to 1e-9",
  "bounded_quadratic arctan C=0.1": "three bounds reached at strides equal to 1e-9",
};

describe("scipy's least squares with a robust loss in the browser", () => {
  it("sums as np.sum does (pairwise, across its block boundaries)", () => {
    for (const { values, sum } of fixture.numpy_sums) expect(pairwiseSum(values)).toBe(sum);
  });
  it("takes scipy's decisions and reaches its solutions with every loss", () => {
    let worst = 0;
    const divergent: string[] = [], relaxed: [string, number, number][] = [];
    for (const problem of fixture.trf) {
      let calls = 0;
      const fun = PROBLEMS[problem.problem]!;
      const result = leastSquaresTrf((x) => { calls++; return fun(x); }, problem.x0, { lower: problem.bounds[0], upper: problem.bounds[1], ftol: 1e-9, xtol: 1e-9, gtol: 1e-9, maxNfev: 60, loss: problem.loss, fScale: problem.f_scale });
      const label = `${problem.problem} ${problem.loss} C=${problem.f_scale}`;
      const xDeviation = maxRel(result.x, problem.x, 1);
      if (label in ROUNDING_DIVERGENT) {
        // the same stop at the same minimiser; a gtol stop beside an active bound fixes x only to ~gtol / |g| there
        expect([result.status, result.message], label).toEqual([problem.status, problem.message]);
        expect(xDeviation, label).toBeLessThan(1e-7);
        divergent.push(`${label} (${ROUNDING_DIVERGENT[label]}): ${result.nfev}/${result.njev} evaluations vs scipy's ${problem.nfev}/${problem.njev}, x within ${xDeviation.toExponential(1)}`);
        continue;
      }
      expect([result.status, result.nfev, result.njev, calls, result.message, result.activeMask], label).toEqual([problem.status, problem.nfev, problem.njev, problem.function_calls, problem.message, problem.active_mask]);
      // x within 1e-9, or ten times scipy's own spread where its answer moves more under last-bit changes (ftol stops
      // with O(1) outlier residuals: up to 9e-8)
      const bar = Math.max(1e-9, 10 * problem.scipy_rounding_spread.x);
      expect(xDeviation, label).toBeLessThanOrEqual(bar);
      if (bar > 1e-9) relaxed.push([label, xDeviation, bar]);
      worst = Math.max(worst, xDeviation);
      expect(Math.abs(result.cost - problem.cost), label).toBeLessThanOrEqual(1e-12 * Math.max(1, problem.cost));
      // the optimality is ‖Jᵀf · v‖∞ of a 2-point Jacobian whose entries carry ~eps/√eps of rounding noise (here
      // from V8's and libm's exp differing in the last bit), times |f|: at a gtol stop both sides sit below gtol; at
      // an ftol stop (outliers, O(1) residuals) it is a cancelled sum, reproducible to ~1e-7·‖f‖₁
      if (problem.status === 1) expect(result.optimality, label).toBeLessThan(1e-9);
      else expect(Math.abs(result.optimality - problem.optimality), label).toBeLessThanOrEqual(1e-7 * Math.max(1, problem.fun.reduce((sum, v) => sum + Math.abs(v), 0)));
    }
    console.log(`robust TRF vs scipy ${fixture.scipy} (${fixture.trf.length} problems: linear, soft_l1, huber, cauchy, arctan): ${fixture.trf.length - divergent.length} take scipy's every decision (status, nfev, njev, residual calls, active set), x within ${worst.toExponential(2)}`);
    console.log(`  x bars wider than 1e-9 (scipy's own spread × 10): ${relaxedReport(relaxed)}`);
    console.log(`  rounding-divergent paths: ${divergent.join("; ")}`);
    expect(divergent.length).toBe(Object.keys(ROUNDING_DIVERGENT).length);
  });
  it("leaves the default path exactly as it was before the extension", () => {
    for (const golden of PRE_EXTENSION_BITS) {
      for (const options of [{}, { loss: "linear" as const }]) {
        let calls = 0;
        const result = leastSquaresTrf((x) => { calls++; return PROBLEMS[golden.problem]!(x); }, golden.x0, { lower: golden.bounds[0]!, upper: golden.bounds[1]!, ftol: golden.tol, xtol: golden.tol, gtol: golden.tol, maxNfev: 60, ...options });
        expect([Array.from(result.x, bits), bits(result.cost), bits(result.optimality), result.nfev, result.njev, result.status, calls, result.activeMask])
          .toEqual([golden.x, golden.cost, golden.optimality, golden.nfev, golden.njev, golden.status, golden.calls, golden.activeMask]);
      }
    }
  });
  it("refuses losses and scales scipy refuses", () => {
    const fun = PROBLEMS.rosenbrock!;
    expect(() => leastSquaresTrf(fun, [0, 0], { lower: -1, upper: 1, ftol: 1e-8, xtol: 1e-8, gtol: 1e-8, maxNfev: 10, loss: "l2" as RobustLoss })).toThrow(/loss/);
    expect(() => leastSquaresTrf(fun, [0, 0], { lower: -1, upper: 1, ftol: 1e-8, xtol: 1e-8, gtol: 1e-8, maxNfev: 10, loss: "huber", fScale: 0 })).toThrow(/f_scale/);
  });
});

// ---------------------------------------------------------------------------------------------- the calibration
const accepted = fixture.cases.filter((c): c is Case & { infer: { status: 200; body: PhysicsInference } } => c.infer.status === 200);
const refused = fixture.cases.filter((c) => c.infer.status !== 200);

describe("the calibration in the browser against the API's responses", () => {
  it("covers the demonstration and at least thirty constructed observations of every kind", () => {
    expect(fixture.cases[0]!.name).toBe("demonstration");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(31);
    const kinds = new Set(fixture.cases.map((c) => c.class));
    for (const kind of ["demonstration", "synthetic_soft", "synthetic_mid", "synthetic_stiff", "noisy", "rejected", "invalid"]) expect(kinds.has(kind), kind).toBe(true);
    expect(accepted.some((c) => !c.infer.body.accepted_for_application)).toBe(true);
    expect(accepted.some((c) => c.observation.times_s instanceof Array && (c.observation.times_s as number[]).length === 16)).toBe(true);
    expect(accepted.some((c) => (c.observation.times_s as number[]).length === 257)).toBe(true);
  });

  it("refuses what the API refuses, with its status, detail and message", () => {
    const messages = new Set<string>();
    for (const c of refused) {
      const theirs = c.infer as { status: number; detail: unknown };
      const error = refusal(() => inferObservation(model, c.observation));
      expect([error.status, error.detail], c.name).toEqual([theirs.status, theirs.detail]);
      expect(error.message, c.name).toBe(shown(theirs.status, theirs.detail));
      messages.add(error.message);
    }
    console.log(`refusals: ${refused.length} observations, ${messages.size} distinct messages, every status, pydantic issue (type, loc, msg, input, ctx) and v2 message equal`);
  });

  it("repeats the API's preprocessing, network, refinement and diagnostics", () => {
    const worst = { features: 0, logFeatures: 0, members: 0, proposals: 0, initial: 0 };
    const sums = tally(), relaxed: [string, number, number][] = [], byClass = new ClassTally();
    let decisions = 0;
    for (const c of accepted) {
      const trace = traceCalibration(model, c.observation), i = c.internals!, spread = c.api_rounding_spread!.fields;
      const label = c.name;
      // features: np.interp (fma) and the divisions exactly; the three logs to one ulp of libm
      const points = meta.feature_points * 2;
      expect(Array.from(trace.features.subarray(0, points)), label).toEqual(i.features.slice(0, points));
      worst.logFeatures = Math.max(worst.logFeatures, maxRel(trace.features.subarray(points), i.features.slice(points)));
      worst.members = Math.max(worst.members, maxRel(trace.memberOutputs.flatMap((m) => Array.from(m)), i.member_outputs.flat()));
      worst.proposals = Math.max(worst.proposals, maxRel(trace.proposals.flatMap((p) => Array.from(p)), i.proposals.flat()));
      worst.initial = Math.max(worst.initial, maxRel(trace.initial, i.initial, 1));
      // scipy's decisions: every step accepted or rejected alike, the same stop
      const lsq = trace.leastSquares, theirs = i.least_squares;
      expect([lsq.status, lsq.message, lsq.nfev, lsq.njev, trace.residualCalls, lsq.activeMask], label).toEqual([theirs.status, theirs.message, theirs.nfev, theirs.njev, theirs.function_calls, theirs.active_mask]);
      decisions++;
      const xBar = Math.max(1e-9, 10 * spread.x), xDeviation = maxRel(lsq.x, theirs.x, 1);
      expect(xDeviation, `${label} x`).toBeLessThanOrEqual(xBar);
      const sigmaBar = Math.max(1e-9, 10 * spread.sigma_encoded), sigmaDeviation = maxRel(trace.sigmaEncoded, i.sigma_encoded);
      expect(sigmaDeviation, `${label} sigma`).toBeLessThanOrEqual(sigmaBar);
      // the response, field by field
      const one = tally();
      compare(trace.result, c.infer.body, peakStress(c.observation), spread, one);
      expect(one.failures, label).toEqual([]);
      for (const [field, value] of one.worst) sums.worst.set(field, Math.max(sums.worst.get(field) ?? 0, value));
      byClass.add(c.class, one);
      const relaxedBar = Math.max(...SOLVER_FIELDS.map((field) => barOf(field, spread)), xBar, sigmaBar);
      if (relaxedBar > 1e-9) relaxed.push([label, Math.max(...SOLVER_FIELDS.map((field) => one.worst.get(field) ?? 0), xDeviation, sigmaDeviation), relaxedBar]);
    }
    const fields = [...sums.worst].map(([field, value]) => `${field} ${value.toExponential(1)}`).join(", ");
    console.log(`calibration vs API (${accepted.length} observations, numpy ${fixture.numpy}, scipy ${fixture.scipy}, ${fixture.system} ${fixture.machine}): scipy's decisions in ${decisions}/${accepted.length}; features exact (logs ≤ ${worst.logFeatures.toExponential(1)}), members ≤ ${worst.members.toExponential(1)}, proposals ≤ ${worst.proposals.toExponential(1)}, initial ≤ ${worst.initial.toExponential(1)}; ${fields}`);
    console.log(`  per class:\n${byClass.report()}`);
    console.log(`  wider bars where the API's own answer moves by more than 1e-10 under last-bit changes: ${relaxedReport(relaxed)}`);
    expect(worst.logFeatures).toBeLessThanOrEqual(2.3e-16);
    expect(worst.members).toBeLessThan(1e-12);
    expect(worst.proposals).toBeLessThan(1e-12);
    expect(worst.initial).toBeLessThan(1e-12);
  });

  it("strips, counts and refuses text as Python and pydantic do", () => {
    expect(pythonStrip("\u0085\u001c abc 　 ")).toBe("abc");
    expect(pythonStrip("﻿abc​")).toBe("﻿abc​");
    const demo = fixture.cases[0]!.observation as unknown as PhysicsObservation;
    const surrogate = refusal(() => inferObservation(model, { ...demo, provenance: "bench test \ud800 rig" }));
    expect([surrogate.status, surrogate.message]).toEqual([500, "Request failed (500)."]);
    // NaN and Infinity travel as null
    const nan = refusal(() => inferObservation(model, { ...demo, force_n: demo.force_n.map((v, i) => (i === 3 ? NaN : v)) }));
    expect(nan.detail).toEqual([{ type: "float_type", loc: ["body", "force_n", 3], msg: "Input should be a valid number", input: null }]);
    expect(refusal(() => inferObservation(model, null)).message).toBe("Field required");
  });
});

// ---------------------------------------------------------------------------------------------- the playground route
describe("the calibrated hands-on liver", () => {
  const snapshot = fixture.playground_snapshot;
  it("is the bundled cage with the route's parameters and learning, or the route's refusal", () => {
    let applied = 0;
    const worst = tally();
    for (const c of fixture.cases) {
      if (c.playground.status !== 200) {
        const theirs = c.playground as { status: number; detail: unknown };
        const error = refusal(() => calibratePlayground(model, snapshot, c.observation as unknown as PhysicsObservation));
        expect([error.status, error.detail, error.message], c.name).toEqual([theirs.status, theirs.detail, shown(theirs.status, theirs.detail)]);
        continue;
      }
      const theirs = c.playground as { parameters: Record<string, number>; learning_keys: string[] };
      const body = (c.infer as { body: PhysicsInference }).body, spread = c.api_rounding_spread!.fields;
      const out = calibratePlayground(model, snapshot, c.observation as unknown as PhysicsObservation) as Record<string, unknown> & { parameters: Record<string, number>; learning: Record<string, unknown>; mesh: Record<string, unknown> };
      expect(Object.keys(out), c.name).toEqual(Object.keys(snapshot));
      for (const key of Object.keys(snapshot)) if (key !== "parameters" && key !== "learning" && key !== "mesh") expect(out[key], `${c.name} ${key}`).toBe(snapshot[key]);
      const mesh = snapshot.mesh as Record<string, unknown>;
      for (const key of Object.keys(mesh)) expect(out.mesh[key], `${c.name} mesh.${key}`).toBe(mesh[key]);
      const one = tally();
      compare(out.parameters, theirs.parameters, 1, spread, one, "parameters");
      expect(Object.keys(out.learning), c.name).toEqual(theirs.learning_keys);
      const { source, predicted_parameters: predicted, observation, observation_origin: origin, ...fit } = out.learning;
      compare(fit, body, peakStress(c.observation), spread, one);
      compare(predicted, body.parameters, 1, spread, one, "predicted_parameters");
      expect([source, origin, observation], c.name).toEqual(["learned", "user_supplied_calibration_unverified", c.observation]);
      expect(one.failures, c.name).toEqual([]);
      for (const [field, value] of one.worst) worst.worst.set(field, Math.max(worst.worst.get(field) ?? 0, value));
      applied++;
    }
    console.log(`hands-on liver: ${applied} calibrations applied, ${fixture.cases.length - applied} refused as the route refuses; ${[...worst.worst].map(([f, v]) => `${f} ${v.toExponential(1)}`).join(", ")}`);
  });
  it("returns the snapshot without an observation and refuses a manual one", () => {
    expect(calibratePlayground(model, snapshot, null)).toEqual(snapshot);
    expect(() => calibratePlayground(model, { ...snapshot, learning: { source: "manual" } }, fixture.cases[0]!.observation as unknown as PhysicsObservation)).toThrow(/learned preparation/);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
/** One POST; a 503 (the physics lock is held by another preparation) is retried, as the studio retries it. */
async function post(route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 503 && attempt < 20) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, json };
  }
}

describe.skipIf(!online)("the browser calibration against the API's routes", () => {
  it("answers /api/physics/infer and /api/physics/playground (learned) as the API does", { timeout: 600_000 }, async () => {
    primePhysicsModel(model);
    const status = await fetch(`${API}/api/physics/status`).then((r) => r.json()) as { status: string; model_id: string; application_policy: unknown };
    expect([status.status, status.model_id, status.application_policy]).toEqual(["ready", meta.model_sha256, null]);
    const demo = await fetch(`${API}/api/physics/demo-observation`).then((r) => r.json()) as Record<string, unknown>;
    for (const key of ["times_s", "force_n", "displacement_mm", "reference_length_mm", "reference_area_mm2"]) expect(fixture.cases[0]!.observation[key], key).toEqual(demo[key]);
    const generated = await post("/api/atlas/generate", { template_id: fixture.playground_template });
    const spec = (generated.json as { spec: unknown }).spec;
    const prepared = await post("/api/physics/playground", { spec, parameter_source: "learned" });
    expect(prepared.status).toBe(200);
    const snapshot = prepared.json as Record<string, unknown>;
    const inferTally = tally(), playgroundTally = tally(), byClass = new ClassTally();
    let reproduced = 0, refusals = 0, applied = 0;
    for (const c of fixture.cases) {
      const spread = c.api_rounding_spread?.fields;
      // /api/physics/infer
      const api = await post("/api/physics/infer", c.observation);
      if (api.status === 200) {
        if (JSON.stringify(api.json) === JSON.stringify((c.infer as { body: unknown }).body)) reproduced++;
        const ours = await inferObservationLocally(c.observation as unknown as PhysicsObservation);
        const one = tally();
        compare(ours, api.json, peakStress(c.observation), spread, one);
        expect(one.failures, c.name).toEqual([]);
        for (const [field, value] of one.worst) inferTally.worst.set(field, Math.max(inferTally.worst.get(field) ?? 0, value));
        byClass.add(c.class, one);
      } else {
        const detail = (api.json as { detail?: unknown }).detail;
        const error = await inferObservationLocally(c.observation as unknown as PhysicsObservation).then(() => null, (e: unknown) => e);
        expect(error, c.name).toBeInstanceOf(PhysicsCalibrationError);
        expect([(error as PhysicsCalibrationError).status, (error as PhysicsCalibrationError).detail, (error as Error).message], c.name).toEqual([api.status, detail, shown(api.status, detail)]);
        refusals++;
      }
      // /api/physics/playground, parameter_source learned, with this observation
      const pg = await post("/api/physics/playground", { spec, parameter_source: "learned", observation: c.observation });
      const ours = await calibratedPlayground(snapshot, c.observation as unknown as PhysicsObservation).then((v) => v, (e: unknown) => e);
      if (pg.status === 200) {
        const theirs = pg.json as Record<string, unknown>, mine = ours as Record<string, unknown>;
        expect(Object.keys(mine), c.name).toEqual(Object.keys(theirs));
        for (const key of Object.keys(theirs)) if (key !== "parameters" && key !== "learning") expect(mine[key], `${c.name} ${key}`).toEqual(theirs[key]);
        const one = tally();
        compare(mine.parameters, theirs.parameters, 1, spread, one, "parameters");
        compare(mine.learning, theirs.learning, peakStress(c.observation), spread, one);
        expect(one.failures, c.name).toEqual([]);
        for (const [field, value] of one.worst) playgroundTally.worst.set(field, Math.max(playgroundTally.worst.get(field) ?? 0, value));
        applied++;
      } else {
        const detail = (pg.json as { detail?: unknown }).detail;
        expect(ours, c.name).toBeInstanceOf(PhysicsCalibrationError);
        expect([(ours as PhysicsCalibrationError).status, (ours as PhysicsCalibrationError).detail, (ours as Error).message], c.name).toEqual([pg.status, detail, shown(pg.status, detail)]);
      }
    }
    // a lone surrogate: the API cannot encode it and answers 500
    const surrogate = { ...fixture.cases[0]!.observation, provenance: "bench test \ud800 rig" };
    const crashed = await post("/api/physics/infer", surrogate);
    const error = await inferObservationLocally(surrogate as unknown as PhysicsObservation).then(() => null, (e: unknown) => e as PhysicsCalibrationError);
    expect([crashed.status, error?.status, error?.message]).toEqual([500, 500, "Request failed (500)."]);
    console.log(`live /api/physics/infer (${fixture.cases.length} observations): ${fixture.cases.length - refusals} calibrated (${reproduced} reproduce the fixture bit for bit), ${refusals} refused alike; ${[...inferTally.worst].map(([f, v]) => `${f} ${v.toExponential(1)}`).join(", ")}`);
    console.log(`  per class:\n${byClass.report()}`);
    console.log(`live /api/physics/playground (learned + observation): ${applied} applied, cage and every other field equal; ${[...playgroundTally.worst].map(([f, v]) => `${f} ${v.toExponential(1)}`).join(", ")}`);
  });
});
