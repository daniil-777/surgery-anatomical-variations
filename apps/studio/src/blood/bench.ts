/// <reference types="@webgpu/types" />
/** Browser/GPU verification entry points. Imported by the explicit bench runner, never the lab UI. */
import { BloodRuntime } from "./runtime";
import { BLOOD_PROFILES, shearRate, viscosity } from "./material";
import { boundaryState, DEFAULT_SCENE, initialState, type BloodScene } from "./scene";
import { MATERIAL_SHADER } from "./shaders";
import { BloodRenderer } from "./renderer";
import { projectTrayVelocity, trayGeometry } from "./boundary";
import { SURFACE_NORMAL_WGSL, SURFACE_TANGENT_WGSL } from "./surface";
export { surfaceReconstructionBench } from "./surfaceReconstructionBench";
export { bloodOpticsBench } from "./opticsBench";
const equalBytes = (a: ArrayBuffer, b: ArrayBuffer) => {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const control = async (r: BloodRuntime) => {
  const raw = await r.readBuffer(r.control), u = new Uint32Array(raw), f = new Float32Array(raw);
  return { accepted: u[1]!, attempt: u[4]!, halted: u[0]!, failure: u[5]!, cursor: u[9]!,
    density: f[6]!, divergence: f[7]!, densityEvaluations: u[10]!, divergenceEvaluations: u[11]!,
    acceptedMaxDensityError: f[13]!, acceptedMaxDivergenceS: f[14]!,
    acceptedContactProjections: u[17]!, acceptedMaxContactVelocityChangeMS: f[19]! };
};
/** Geometric periodic-cell triangulation, independent of the SPH density estimator. */
export function periodicGeometricVolume(state: Float32Array, axis: number, length: number) {
  let signed = 0, absolute = 0, inverted = 0;
  const tetrahedra = [[1, 3, 7], [3, 2, 7], [2, 6, 7], [6, 4, 7], [4, 5, 7], [5, 1, 7]];
  for (let z = 0; z < axis; ++z) for (let y = 0; y < axis; ++y) for (let x = 0; x < axis; ++x) {
    const i = x + axis * (y + axis * z);
    const vertices = Array.from({ length: 8 }, (_, vertex) => {
      const j = (x + (vertex & 1)) % axis + axis * ((y + ((vertex >> 1) & 1)) % axis + axis * ((z + ((vertex >> 2) & 1)) % axis));
      return [0, 1, 2].map(k => { const delta = state[j * 4 + k]! - state[i * 4 + k]!; return delta - Math.round(delta / length) * length; });
    });
    for (const [a, b, c] of tetrahedra) {
      const u = vertices[a!]!, v = vertices[b!]!, w = vertices[c!]!;
      const volume = (u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!)) / 6;
      signed += volume; absolute += Math.abs(volume); if (volume <= 0) inverted++;
    }
  }
  return { signedM3: signed, absoluteM3: absolute, referenceM3: length ** 3, relativeError: Math.abs(absolute / length ** 3 - 1), invertedTetrahedra: inverted,
    limitation: "Periodic mapped lattice only; not a free-surface or arbitrary-organ volume estimator." };
}
export async function materialBench() {
  const r = await BloodRuntime.create(DEFAULT_SCENE);
  const gradients: number[][] = [];
  for (const rate of [0, .001, .01, .1, 1, 10, 100, 1000, 10000])
    gradients.push([0, rate, 0, 0, 0, 0, 0, 0, 0], [0, -rate, 0, rate, 0, 0, 0, 0, 0], [rate, 0, 0, 0, -rate / 2, 0, 0, 0, -rate / 2]);
  const values = new Float32Array(gradients.length * 12);
  gradients.forEach((g, i) => { values.set(g.slice(0, 3), i * 12); values.set(g.slice(3, 6), i * 12 + 4); values.set(g.slice(6, 9), i * 12 + 8); });
  const input = r.device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = r.device.createBuffer({ size: gradients.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  try {
    r.device.queue.writeBuffer(input, 0, values);
    const module = r.device.createShaderModule({ code: MATERIAL_SHADER });
    const pipeline = await r.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = r.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } },
    ] });
    const encoder = r.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(gradients.length / 64)); pass.end();
    r.device.queue.submit([encoder.finish()]);
    const result = new Float32Array(await r.readBuffer(output));
    const samples = gradients.map((g, i) => {
      const gamma = shearRate(g.map(Math.fround)), expected = [gamma, ...BLOOD_PROFILES.map(p => viscosity(gamma, p))];
      const actual = Array.from(result.slice(i * 4, i * 4 + 3));
      return { gradient: g, expected, actual, passed: expected.every((v, j) => Math.abs(v - actual[j]!) <= 1e-7 + 2e-5 * Math.abs(v)) };
    });
    return { gate: "M01", status: samples.every(s => s.passed) && !r.errors.length ? "PASS" : "FAIL", samples, adapter: r.adapterInfo, errors: r.errors };
  } finally { input.destroy(); output.destroy(); r.dispose(); }
}
export async function surfaceNormalBench() {
  const r = await BloodRuntime.create(DEFAULT_SCENE), values = new Float32Array(6 * 12);
  const expected = [0, -Math.SQRT1_2, Math.SQRT1_2];
  for (let i = 0; i < 6; ++i) {
    const scale = 10 ** (-2 - i);
    values.set([scale, 0, 0, 0, 0, scale, scale, 0, 0, 0, 1, 0], i * 12);
  }
  const input = r.device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = r.device.createBuffer({ size: 6 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  try {
    r.device.queue.writeBuffer(input, 0, values);
    const module = r.device.createShaderModule({ code: SURFACE_NORMAL_WGSL + `
      struct Sample { dx:vec4<f32>,dy:vec4<f32>,eye:vec4<f32> }
      @group(0) @binding(0) var<storage,read> samples:array<Sample>;
      @group(0) @binding(1) var<storage,read_write> result:array<vec4<f32>>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>){
        let s=samples[id.x];result[id.x]=vec4(surfaceNormal(s.dx.xyz,s.dy.xyz,s.eye.xyz),0.);
      }` });
    const pipeline = await r.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = r.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } },
    ] });
    const encoder = r.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(6); pass.end(); r.device.queue.submit([encoder.finish()]);
    const result = new Float32Array(await r.readBuffer(output));
    const samples = Array.from({ length: 6 }, (_, i) => {
      const normal = Array.from(result.slice(i * 4, i * 4 + 3));
      return { metresPerPixel: 10 ** (-2 - i), normal, error: Math.hypot(...normal.map((n, k) => n - expected[k]!)) };
    });
    return { gate: "surface-normal-resolution", status: samples.every(s => s.error < 1e-5) && !r.errors.length ? "PASS" : "FAIL", expected, samples, errors: r.errors };
  } finally { input.destroy(); output.destroy(); r.dispose(); }
}
/** Analytical geometry fixtures, independent of rendered particles and depth filtering. */
export async function surfaceTangentBench() {
  type Vec3 = [number, number, number];
  type Point = [number, number, number, number];
  type Fixture = {
    name: string; scale: number; points: Point[]; dx: Vec3; dy: Vec3; normal: Vec3;
  };
  const fixtures: Fixture[] = [];
  const eye: Vec3 = [0, 0, 1], tiltedNormal: Vec3 = [0, -Math.SQRT1_2, Math.SQRT1_2];
  // Binary scales preserve the analytical offsets in f32. Six resolutions span
  // about 30,000x without tying expected tangents to the implementation's branch.
  for (let i = 0; i < 6; ++i) {
    const scale = 2 ** (-6 - 3 * i);
    const point = (x: number, y: number, z: number, depth: number): Point =>
      [(4 + x) * scale, (-2 + y) * scale, (8 + z) * scale, depth];
    const center = point(0, 0, 0, 1);
    // Reproduce the erroneous camera point that world(pixel,0) used to return.
    // Validity must exclude this point rather than accidentally use its slope.
    const missing: Point = [0, 0, 1, 0];
    const xp = point(1, 0, 0, 1), xn = point(-1, 0, 0, 1);
    const yp = point(0, 1, 1, 1 - scale), yn = point(0, -1, -1, 1 + scale);
    const x: Vec3 = [scale, 0, 0], y: Vec3 = [0, scale, scale], zero: Vec3 = [0, 0, 0];
    const add = (name: string, neighbours: Point[], dx: Vec3, dy: Vec3, normal: Vec3) =>
      fixtures.push({ name, scale, points: [center, ...neighbours, [...eye, 0]], dx, dy, normal });
    add("isolated-pixel", [missing, missing, missing, missing], zero, zero, eye);
    add("horizontal-one-pixel-filament", [xp, xn, missing, missing], x, zero, eye);
    add("vertical-one-pixel-filament", [missing, missing, yp, yn], zero, y, eye);
    add("positive-sided-silhouette", [xp, missing, yp, missing], x, y, tiltedNormal);
    add("negative-sided-silhouette", [missing, xn, missing, yn], x, y, tiltedNormal);
    add("mixed-sided-silhouette", [xp, missing, missing, yn], x, y, tiltedNormal);
    add("valid-tilted-plane", [xp, xn, yp, yn], x, y, tiltedNormal);
    const flatYp = point(0, 1, 0, 1), flatYn = point(0, -1, 0, 1);
    const shallowX: Vec3 = [scale, 0, scale / 4], flatY: Vec3 = [0, scale, 0];
    const shallowNormal: Vec3 = [-1 / Math.sqrt(17), 0, 4 / Math.sqrt(17)];
    add("positive-neighbour-closer",
      [point(1, 0, .25, 1 - scale / 4), point(-1, 0, -1, 1 + scale), flatYp, flatYn],
      shallowX, flatY, shallowNormal);
    add("negative-neighbour-closer",
      [point(1, 0, 1, 1 - scale), point(-1, 0, -.25, 1 + scale / 4), flatYp, flatYn],
      shallowX, flatY, shallowNormal);
    add("equal-depth-jump-prefers-positive",
      [point(1, 0, .25, 1 - scale / 4), point(-1, 0, .25, 1 - scale / 4), flatYp, flatYn],
      shallowX, flatY, shallowNormal);
  }
  const values = Float32Array.from(fixtures.flatMap(f => f.points.flat()));
  const r = await BloodRuntime.create(DEFAULT_SCENE);
  let input: GPUBuffer | undefined, output: GPUBuffer | undefined;
  try {
    input = r.device.createBuffer({ label: "blood/surface tangent fixture input", size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    output = r.device.createBuffer({ label: "blood/surface tangent fixture output", size: fixtures.length * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    r.device.queue.writeBuffer(input, 0, values);
    const module = r.device.createShaderModule({ label: "blood/analytical surface tangent fixture", code: SURFACE_TANGENT_WGSL + SURFACE_NORMAL_WGSL + `
      struct Sample { center:vec4<f32>,positiveX:vec4<f32>,negativeX:vec4<f32>,positiveY:vec4<f32>,negativeY:vec4<f32>,eye:vec4<f32> }
      struct Result { dx:vec4<f32>,dy:vec4<f32>,normal:vec4<f32> }
      @group(0) @binding(0) var<storage,read> samples:array<Sample>;
      @group(0) @binding(1) var<storage,read_write> result:array<Result>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>){
        let s=samples[id.x];
        let dx=surfaceTangent(s.center.xyz,s.positiveX.xyz,s.negativeX.xyz,vec3(s.center.w,s.positiveX.w,s.negativeX.w));
        let dy=surfaceTangent(s.center.xyz,s.positiveY.xyz,s.negativeY.xyz,vec3(s.center.w,s.positiveY.w,s.negativeY.w));
        result[id.x]=Result(vec4(dx,0.),vec4(dy,0.),vec4(surfaceNormal(dx,dy,s.eye.xyz),0.));
      }` });
    const pipeline = await r.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = r.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } },
    ] });
    const encoder = r.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(fixtures.length); pass.end();
    r.device.queue.submit([encoder.finish()]);
    const result = new Float32Array(await r.readBuffer(output));
    const samples = fixtures.map((f, i) => {
      const dx = Array.from(result.slice(i * 12, i * 12 + 3));
      const dy = Array.from(result.slice(i * 12 + 4, i * 12 + 7));
      const normal = Array.from(result.slice(i * 12 + 8, i * 12 + 11));
      const tangentError = Math.max(...dx.map((v, k) => Math.abs(v - f.dx[k]!)), ...dy.map((v, k) => Math.abs(v - f.dy[k]!)));
      const normalError = Math.hypot(...normal.map((v, k) => v - f.normal[k]!));
      const zeroAxesExact = (f.dx.some(v => v !== 0) || dx.every(v => v === 0))
        && (f.dy.some(v => v !== 0) || dy.every(v => v === 0));
      const finite = [...dx, ...dy, ...normal].every(Number.isFinite);
      return { name: f.name, metresPerPixel: f.scale, expected: { dx: f.dx, dy: f.dy, normal: f.normal },
        actual: { dx, dy, normal }, tangentError, normalError, zeroAxesExact,
        passed: finite && zeroAxesExact && tangentError <= f.scale * 1e-6 && normalError < 1e-5 };
    });
    return { gate: "surface-tangent-missing-depth", status: samples.every(s => s.passed) && !r.errors.length ? "PASS" : "FAIL",
      samples, errors: r.errors, limitation: "Analytical neighbor selection and normal fallback only; does not validate depth filtering, temporal coherence or surgical realism." };
  } finally { input?.destroy(); output?.destroy(); r.dispose(); }
}
export async function neighborBench(kind: "lattice" | "dense" | "tail" | "walls") {
  const scene: BloodScene = { ...DEFAULT_SCENE, fixture: kind === "walls" ? "dam" : "translation", lengthM: .015625, axis: kind === "tail" ? 12 : 8 };
  const r = await BloodRuntime.create(scene, { neighborProbe: true }), state = initialState(scene), n = r.count;
  try {
    let seed = 901;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    if (kind === "dense" || kind === "tail") for (let i = 0; i < n; ++i) for (let k = 0; k < 3; ++k)
      state[i * 4 + k] = kind === "dense" ? .003 + random() * .0001 : (.00001 + random() * .99998) * scene.lengthM;
    r.device.queue.writeBuffer(r.accepted, 0, state);
    const ids = Uint32Array.from({ length: n }, (_, i) => 0xffffffff - i * 19);
    r.device.queue.writeBuffer(r.ids, 0, ids); // Prove arbitrary IDs do not become gather indices or floats.
    const encoder = r.device.createCommandEncoder(); r.encodeGeometryFixture(encoder); r.device.queue.submit([encoder.finish()]);
    const bitmap = new Uint32Array(await r.readBuffer(r.neighborBits)), b = boundaryState(scene), total = n + b.length / 4;
    const words = Math.ceil(total / 32), L = Math.fround(scene.lengthM), H = Math.fround(scene.lengthM / r.gridCells);
    let mismatches = 0, nearCutoff = 0, maxDegree = 0;
    const examples: unknown[] = [];
    for (let i = 0; i < n; ++i) {
      let degree = 0;
      for (let j = 0; j < total; ++j) {
        const p = j < n ? state : b, index = j < n ? j : j - n;
        const d = [0, 1, 2].map(k => {
          let v = Math.fround(state[i * 4 + k]! - p[index * 4 + k]!);
          if (kind !== "walls") v = Math.fround(v - Math.fround(Math.round(Math.fround(v / L)) * L));
          return v;
        });
        const distance2 = d.reduce((sum, v) => sum + v * v, 0), expected = distance2 < H * H;
        const actual = (bitmap[i * words + (j >>> 5)]! & (1 << (j & 31))) !== 0;
        if (Math.abs(distance2 - H * H) <= H * H * 1e-7 && distance2 !== H * H) nearCutoff++;
        if (actual) degree++;
        if (actual !== expected) { mismatches++; if (examples.length < 8) examples.push({ i, j, distance2, cutoff2: H * H, expected, actual }); }
      }
      maxDegree = Math.max(maxDegree, degree);
    }
    const idsPreserved = equalBytes(ids.buffer, await r.readBuffer(r.ids));
    const statePreserved = equalBytes(state.buffer, await r.readBuffer(r.accepted));
    return { gate: "N01", kind, status: mismatches === 0 && idsPreserved && statePreserved && !r.errors.length ? "PASS" : "FAIL",
      samples: n, boundarySamples: total - n, comparisons: n * total, maxDegree, mismatches, examples, nearCutoff,
      cutoff: "strict distance < support; exact binary-axis cutoff covered by lattice fixture",
      idsPreserved, statePreserved, allocationLedger: r.allocationLedger, errors: r.errors };
  } finally { r.dispose(); }
}
export async function transactionBench() {
  const r = await BloodRuntime.create({ ...DEFAULT_SCENE, fixture: "shear" });
  try {
    await r.submit(1);
    const before = await r.readBuffer(r.accepted), previous = await control(r);
    const one = r.submit(1, undefined, true), two = r.submit(4), third = r.submit(0);
    const queueBounded = third === undefined;
    await Promise.all([one, two]);
    const after = await r.readBuffer(r.accepted), next = await control(r);
    const passed = equalBytes(before, after) && next.accepted === previous.accepted && next.cursor === previous.cursor
      && next.attempt === previous.attempt + 1 && next.failure === 128 && next.halted === 1 && queueBounded;
    return { gate: "K01", status: passed && !r.errors.length ? "PASS" : "FAIL", before: previous, after: next, queueBounded, acceptedBytesUnchanged: equalBytes(before, after), errors: r.errors };
  } finally { r.dispose(); }
}
export async function capBench() {
  const scene: BloodScene = { ...DEFAULT_SCENE, fixture: "compression", divergenceToleranceS: .05 };
  const reference = await BloodRuntime.create(scene);
  let ref: Awaited<ReturnType<typeof control>>;
  try { await reference.submit(1); ref = await control(reference); } finally { reference.dispose(); }
  const cap = Math.max(ref.densityEvaluations, ref.divergenceEvaluations) - 1;
  const results = [];
  for (const iterations of [Math.max(1, cap - 1), Math.max(1, cap)]) {
    const r = await BloodRuntime.create({ ...scene, iterations });
    try {
      const before = await r.readBuffer(r.accepted); await r.submit(1);
      const report = await control(r), unchanged = equalBytes(before, await r.readBuffer(r.accepted));
      results.push({ iterations, ...report, unchanged });
    } finally { r.dispose(); }
  }
  return { gate: "K01-cap", status: !ref.failure && cap > 1 && results[0]!.failure !== 0 && results[0]!.unchanged && results[1]!.accepted === 1 ? "PASS" : "FAIL", reference: ref, cap, results };
}
export async function contactBench() {
  const scene: BloodScene = { ...DEFAULT_SCENE, fixture: "dam", dtSeconds: .0001 };
  const r = await BloodRuntime.create(scene), state = initialState(scene), velocities = new Float32Array(r.count * 4);
  const { minimumCentre: lo, maximumCentre: hi } = trayGeometry(scene);
  for (let i = 0; i < r.count; ++i) {
    state.set([i & 1 ? hi : lo, i & 2 ? hi : lo, i & 4 ? hi : lo], i * 4);
    velocities.set([i & 8 ? .4 : -.4, i & 16 ? .3 : -.3, i & 32 ? .2 : -.2, 0], i * 4);
  }
  try {
    r.device.queue.writeBuffer(r.candidate, 0, state);
    r.device.queue.writeBuffer(r.work, 0, velocities);
    const before = await r.readBuffer(r.accepted);
    const encoder = r.device.createCommandEncoder(); r.encodeContactFixture(encoder); r.device.queue.submit([encoder.finish()]);
    const result = new Float32Array(await r.readBuffer(r.candidate));
    let maximumErrorMS = 0;
    for (let i = 0; i < r.count; ++i) {
      const expected = projectTrayVelocity(Array.from(state.slice(i * 4, i * 4 + 3)), Array.from(velocities.slice(i * 4, i * 4 + 3)), scene);
      for (let k = 0; k < 3; ++k) maximumErrorMS = Math.max(maximumErrorMS, Math.abs(result[r.count * 4 + i * 4 + k]! - expected[k]!));
    }
    const acceptedUnchanged = equalBytes(before, await r.readBuffer(r.accepted));
    const positionUnchanged = state.slice(0, r.count * 4).every((v, i) => result[i] === v);
    return { gate: "contact-operator", status: maximumErrorMS < 1e-5 && acceptedUnchanged && positionUnchanged && !r.errors.length ? "PASS" : "FAIL",
      cases: 64, samples: r.count, maximumErrorMS, acceptedUnchanged, positionUnchanged, errors: r.errors };
  } finally { r.dispose(); }
}
export async function flowBench(patch: Partial<BloodScene> = {}, steps = 200, skipInactive = true) {
  const scene = { ...DEFAULT_SCENE, fixture: "shear" as const, ...patch }, r = await BloodRuntime.create(scene, { skipInactive });
  try {
    const initial = initialState(scene), n = r.count, series = [], begin = performance.now();
    let cpuEncodeMS = 0;
    for (let k = 0; k < steps; k += 4) {
      const start = performance.now(), completion = r.submit(Math.min(4, steps - k)); cpuEncodeMS += performance.now() - start;
      await completion;
      const report = await control(r); series.push(report); if (report.halted) break;
    }
    const wallSeconds = (performance.now() - begin) / 1000, final = new Float32Array(await r.readBuffer(r.accepted));
    const stateHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", final.buffer))].map(v => v.toString(16).padStart(2, "0")).join("");
    const last = series.at(-1)!, time = last.accepted * r.scene.dtSeconds;
    const decay = Math.exp(-scene.dynamicViscosityPaS / scene.densityKgM3 * (2 * Math.PI / scene.lengthM) ** 2 * time);
    let error2 = 0, expected2 = 0, mass = 0, mass0 = 0, momentum = [0, 0, 0], momentum0 = [0, 0, 0], kinetic = 0, kinetic0 = 0;
    for (let i = 0; i < n; ++i) {
      mass += final[i * 4 + 3]!; mass0 += initial[i * 4 + 3]!;
      for (let k = 0; k < 3; ++k) {
        const v = final[n * 4 + i * 4 + k]!, v0 = initial[n * 4 + i * 4 + k]!;
        const expected = scene.fixture === "shear" ? (k === 0 ? scene.speedMS * Math.sin(final[i * 4 + 1]! * 2 * Math.PI / scene.lengthM) * decay : 0) : v0;
        error2 += (v - expected) ** 2; expected2 += expected ** 2;
        momentum[k]! += v * final[i * 4 + 3]!; momentum0[k]! += v0 * initial[i * 4 + 3]!;
        kinetic += .5 * final[i * 4 + 3]! * v * v; kinetic0 += .5 * initial[i * 4 + 3]! * v0 * v0;
      }
    }
    const tray = trayGeometry(scene);
    let penetratedMass = 0, minimumClearanceM = Infinity, highestCentreM = 0;
    if (scene.fixture === "dam") for (let i = 0; i < n; ++i) {
      const [x, y, z] = final.slice(i * 4, i * 4 + 3);
      const clearance = Math.min(x! - tray.minimumCentre, y! - tray.minimumCentre, z! - tray.minimumCentre,
        tray.maximumCentre - x!, tray.maximumCentre - z!);
      minimumClearanceM = Math.min(minimumClearanceM, clearance);
      highestCentreM = Math.max(highestCentreM, y!);
      if (clearance < -1e-7 * scene.lengthM) penetratedMass += final[i * 4 + 3]!;
    }
    return { config: r.scene, configHash: r.configHash, adapter: r.adapterInfo, status: last.failure ? "FAIL" : "COMPLETED",
      accepted: last.accepted, physicalSeconds: time, wallSeconds, physicalThroughput: time / wallSeconds, cpuEncodeMS,
      massRelativeError: (mass - mass0) / mass0, momentum, momentum0, kinetic, kinetic0,
      shearRelativeL2: scene.fixture === "shear" ? Math.sqrt(error2 / expected2) : null,
      geometricVolume: scene.fixture === "dam" ? null : periodicGeometricVolume(final, scene.axis, scene.lengthM),
      wallContact: scene.fixture === "dam" ? { geometry: tray, penetratedMassFraction: penetratedMass / mass, minimumClearanceM, highestCentreM } : null,
      stateHash, series, skipInactive, allocationLedger: r.allocationLedger, errors: r.errors };
  } finally { r.dispose(); }
}
export async function renderingIsolationBench() {
  const scene: BloodScene = { ...DEFAULT_SCENE, fixture: "shear" };
  const hashes: string[] = [], errors: string[] = [];
  for (const rendering of [false, true]) {
    const r = await BloodRuntime.create(scene), canvas = document.createElement("canvas");
    canvas.style.cssText = "width:320px;height:240px"; document.body.appendChild(canvas);
    const view = rendering ? new BloodRenderer(canvas, r) : undefined;
    try {
      for (let i = 0; i < 4; ++i) {
        if (view) { view.mode = i % 2 ? "particles" : "surface"; canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); }
        await r.submit(1, view?.encode);
      }
      const state = await r.readBuffer(r.accepted);
      hashes.push([...new Uint8Array(await crypto.subtle.digest("SHA-256", state))].map(x => x.toString(16).padStart(2, "0")).join(""));
      errors.push(...r.errors);
    } finally { view?.dispose(); r.dispose(); canvas.remove(); }
  }
  return { gate: "V01", status: hashes[0] === hashes[1] && !errors.length ? "PASS" : "FAIL", hashes, errors };
}
