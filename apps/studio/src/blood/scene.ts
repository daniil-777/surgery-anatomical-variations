export const SOLVER_VERSION = "dfsph-bk17-v3";
export type FlowFixture = "shear" | "vortex" | "translation" | "compression" | "dam";
export interface BloodScene {
  schema: "viscera.blood/v1";
  solver: typeof SOLVER_VERSION;
  fixture: FlowFixture;
  axis: 8 | 12 | 16;
  lengthM: number;
  densityKgM3: number;
  dynamicViscosityPaS: number;
  speedMS: number;
  dtSeconds: number;
  densityTolerance: number;
  divergenceToleranceS: number;
  iterations: number;
  seed: number;
  wallContact: "pressure-only" | "unilateral-slip";
}
export const DEFAULT_SCENE: BloodScene = {
  schema: "viscera.blood/v1", solver: SOLVER_VERSION, fixture: "vortex", axis: 8, lengthM: .016,
  densityKgM3: 1060, dynamicViscosityPaS: .00345, speedMS: .02, dtSeconds: .0005,
  densityTolerance: .003, divergenceToleranceS: .5, iterations: 64, seed: 0, wallContact: "unilateral-slip",
};
export function validateScene(input: BloodScene): BloodScene {
  if (input.schema !== DEFAULT_SCENE.schema || input.solver !== SOLVER_VERSION) throw new Error("Unsupported blood scene version");
  if (!["pressure-only", "unilateral-slip"].includes(input.wallContact)) throw new Error("Unsupported wall contact model");
  if (![8, 12, 16].includes(input.axis) || !["shear", "vortex", "translation", "compression", "dam"].includes(input.fixture)) throw new Error("Unsupported fixture or resolution");
  const ranges = {
    lengthM: [.008, .04], densityKgM3: [900, 1200], dynamicViscosityPaS: [0, .056],
    speedMS: [0, .05], dtSeconds: [.00001, .001], densityTolerance: [.00001, .005],
    divergenceToleranceS: [.001, 1], iterations: [1, 64], seed: [0, 0xffffffff],
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const [min, max] = ranges[key], value = input[key];
    // The serialized timestep is the actual FP32 value. Revalidation must accept
    // rounded endpoints (for example f32(0.001) is slightly larger than 0.001).
    const numeric = key === "dtSeconds" ? Math.fround(value) : value;
    const lower = key === "dtSeconds" ? Math.fround(min) : min;
    const upper = key === "dtSeconds" ? Math.fround(max) : max;
    if (!Number.isFinite(value) || numeric < lower || numeric > upper) throw new RangeError(`Invalid ${key}`);
  }
  if (!Number.isInteger(input.iterations) || !Number.isInteger(input.seed)) throw new RangeError("Iterations and seed must be integers");
  const spacing = input.lengthM / input.axis / (input.fixture === "dam" ? 2 : 1), dt = Math.fround(input.dtSeconds);
  if (dt > .1 * spacing ** 2 * input.densityKgM3 / Math.max(input.dynamicViscosityPaS, 1e-12)
    || dt * input.speedMS > .1 * spacing) throw new RangeError("Timestep exceeds the conservative explicit-viscosity or travel bound");
  // Whitelist serialization: camera/UI/extraneous properties cannot enter physics or its hash.
  return { schema: input.schema, solver: input.solver, fixture: input.fixture, axis: input.axis,
    lengthM: input.lengthM, densityKgM3: input.densityKgM3, dynamicViscosityPaS: input.dynamicViscosityPaS,
    speedMS: input.speedMS, dtSeconds: dt, densityTolerance: input.densityTolerance,
    divergenceToleranceS: input.divergenceToleranceS, iterations: input.iterations, seed: input.seed, wallContact: input.wallContact };
}
export async function sceneHash(scene: BloodScene): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(validateScene(scene))));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function kernel(distance: number, support: number): number {
  const q = distance / support;
  if (q >= 1) return 0;
  return 8 / (Math.PI * support ** 3) * (q <= .5 ? 1 - 6 * q * q + 6 * q ** 3 : 2 * (1 - q) ** 3);
}
export function initialState(scene: BloodScene): Float32Array<ArrayBuffer> {
  const s = validateScene(scene), n = s.axis ** 3, spacing = s.lengthM / s.axis / (s.fixture === "dam" ? 2 : 1), state = new Float32Array(n * 8);
  // Physical particle mass = rho * lattice cell volume, without a fitted boundary/radius correction.
  const mass = s.densityKgM3 * spacing ** 3;
  for (let z = 0, i = 0; z < s.axis; ++z) for (let y = 0; y < s.axis; ++y) for (let x = 0; x < s.axis; ++x, ++i) {
    const offset = s.fixture === "dam" ? 2.5 : .5;
    const px = (x + offset) * spacing, py = (y + offset) * spacing, pz = (z + offset) * spacing;
    state.set([px, py, pz, mass], i * 4);
    const X = px * 2 * Math.PI / s.lengthM, Y = py * 2 * Math.PI / s.lengthM;
    const u = s.speedMS;
    const velocity = s.fixture === "dam" ? [0, 0, 0] : s.fixture === "translation" ? [u, 0, 0]
      : s.fixture === "shear" ? [u * Math.sin(Y), 0, 0]
      : s.fixture === "compression" ? [-u * Math.sin(X), -u * Math.sin(Y), 0]
      : [u * Math.sin(X) * Math.cos(Y), -u * Math.cos(X) * Math.sin(Y), 0];
    state.set([...velocity, 0], n * 4 + i * 4);
  }
  return state;
}
/** Fixed solid-volume quadrature: two lattice layers, full compact support H=2dx.
 * These are hydrodynamic samples, not an SDF collision substitute or moving rigid bodies. */
export function boundaryState(scene: BloodScene): Float32Array<ArrayBuffer> {
  if (scene.fixture !== "dam") return new Float32Array(0);
  const axis = 2 * scene.axis, dx = scene.lengthM / axis, points: number[] = [];
  for (let z = 0; z < axis; ++z) for (let y = 0; y < axis; ++y) for (let x = 0; x < axis; ++x) {
    if (x < 2 || x >= axis - 2 || z < 2 || z >= axis - 2 || y < 2)
      points.push((x + .5) * dx, (y + .5) * dx, (z + .5) * dx, scene.densityKgM3 * dx ** 3);
  }
  return new Float32Array(points);
}
/** Future filled-vessel solvers share SI observations, never this particle-buffer layout. */
export interface VascularObservables {
  acceptedTimeSeconds: number;
  sectionFlowM3S: Readonly<Record<string, number>>;
  pressurePa: Readonly<Record<string, number>>;
  wallShearPa: Readonly<Record<string, readonly [number, number, number]>>;
}
export const BLOOD_CAPABILITIES = Object.freeze({
  periodicNewtonian: "experimental", constitutiveCY: "equation-only",
  freeSurface: "experimental-no-capillarity", wetting: "unsupported", rigidCoupling: "unsupported",
  filledArteries: "unsupported", cellsClotsGas: "unsupported", surgicalRealism: "not-validated",
});
