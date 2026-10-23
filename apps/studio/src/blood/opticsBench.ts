/// <reference types="@webgpu/types" />
/** Explicit development GPU fixture; never imported by the application UI. */
import {
  BLOOD_OPTICS_WGSL, bloodSlabTransport, BLOOD_OPTICS_PROVENANCE,
  composeDiffuseSubstrate, type BloodOpticsRgb, type BloodSlabTransport,
} from "./optics";

interface SubstrateFixture {
  name: string;
  /** Null uses supplied coefficients; a number also exercises GPU LUT lookup. */
  thicknessM: number | null;
  transport: BloodSlabTransport;
  substrate: BloodOpticsRgb;
  oracle: BloodOpticsRgb;
}
const rgb = (r: number, g = r, b = r): BloodOpticsRgb => [Math.fround(r), Math.fround(g), Math.fround(b)];

/** Independent path-by-path flux accounting, rather than the production
 * closed-form denominator. Fixtures using this oracle have R*s <= 0.75, so
 * 512 bounces bound the omitted tail below binary64 roundoff.
 */
function reflectedBounceOracle(transport: BloodSlabTransport, substrate: BloodOpticsRgb): BloodOpticsRgb {
  const result: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; ++channel) {
    const r = transport.reflectance[channel]!;
    let incoming = transport.transmittance[channel]!, reflected = r;
    for (let bounce = 0; bounce < 512; ++bounce) {
      const returned = incoming * substrate[channel]!;
      reflected += returned * transport.transmittance[channel]!;
      incoming = returned * r;
    }
    result[channel] = reflected;
  }
  return result;
}

/** CPU-only fixture construction, exported for preflight tests without a GPU. */
export function bloodOpticsSubstrateFixtures(): SubstrateFixture[] {
  const fixtures: SubstrateFixture[] = [];
  const add = (name: string, r: BloodOpticsRgb, t: BloodOpticsRgb, substrate: BloodOpticsRgb, oracle?: BloodOpticsRgb) => {
    const transport = { reflectance: r, transmittance: t };
    fixtures.push({ name, thicknessM: null, transport, substrate, oracle: oracle ?? reflectedBounceOracle(transport, substrate) });
  };
  add("vacuum", rgb(0), rgb(1), rgb(0, .5, 1), rgb(0, .5, 1));
  add("pure absorption, two traversals", rgb(0), rgb(.25, .5, .75), rgb(.8, .6, .4));
  add("conservative scattering over white", rgb(.25, .5, .75), rgb(.75, .5, .25), rgb(1), rgb(1));
  add("opaque slab", rgb(.125, .25, .75), rgb(0), rgb(.72), rgb(.125, .25, .75));
  add("perfect opaque reflector", rgb(1), rgb(0), rgb(1), rgb(1));
  add("black substrate", rgb(.2, .4, .6), rgb(.7, .5, .3), rgb(0), rgb(.2, .4, .6));
  add("repeated substrate exchanges", rgb(.2, .3, .4), rgb(.6, .5, .4), rgb(.7, .6, .5));
  add("near-conservative sealed cavity", rgb(1 - 2 ** -20, 1 - 2 ** -10, .5), rgb(2 ** -20, 2 ** -10, .5), rgb(1), rgb(1));
  add("nearly opaque transmission", rgb(.125, .25, .75), rgb(1e-12), rgb(1));
  for (const value of [0, 1e-6, 1e-5, 1e-4, 1e-3, .01, .05]) {
    const thicknessM = Math.fround(value), transport = bloodSlabTransport(thicknessM), substrate = rgb(.72);
    fixtures.push({ name: `blood over neutral substrate: ${value} m`, thicknessM, transport, substrate,
      oracle: reflectedBounceOracle(transport, substrate) });
  }
  return fixtures;
}

export async function bloodOpticsBench() {
  const errors: string[] = [];
  if (!navigator.gpu) return { gate: "blood-spectral-optics", status: "UNSUPPORTED", errors: ["WebGPU unavailable"] };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { gate: "blood-spectral-optics", status: "UNSUPPORTED", errors: ["No WebGPU adapter"] };
  const device = await adapter.requestDevice();
  const inputs = new Float32Array([
    0, 1e-6, 1e-5, 1e-4, 1e-3, .01, .05, 1,
    ...Array.from({ length: 64 }, (_, i) => 10 ** (-12 + 18 * i / 63)),
  ]);
  const resources: GPUBuffer[] = [];
  const samples: { thicknessM: number; expected: number[]; actual: number[]; maxError: number; finite: boolean; passive: boolean; passed: boolean }[] = [];
  const fixtures = bloodOpticsSubstrateFixtures();
  const substrateSamples: {
    name: string; thicknessM: number | null; reflectance: BloodOpticsRgb; transmittance: BloodOpticsRgb; substrate: BloodOpticsRgb;
    oracle: BloodOpticsRgb; expected: BloodOpticsRgb; actual: number[]; cpuOracleError: number; maxError: number; finite: boolean; passive: boolean; passed: boolean;
  }[] = [];
  const uncaptured = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message);
  device.addEventListener("uncapturederror", uncaptured);
  device.pushErrorScope("validation");
  try {
    const buffer = (size: number, usage: GPUBufferUsageFlags) => {
      const result = device.createBuffer({ size, usage }); resources.push(result); return result;
    };
    const input = buffer(inputs.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const outputBytes = inputs.length * 32 + fixtures.length * 16;
    const output = buffer(outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const staging = buffer(outputBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    // Three aligned vec4 rows per fixture; R.w selects an integrated LUT path.
    const substrateData = new Float32Array(fixtures.flatMap(sample => [
      ...sample.transport.reflectance, sample.thicknessM ?? -1,
      ...sample.transport.transmittance, 0, ...sample.substrate, 0,
    ]));
    const substrateInput = buffer(substrateData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(input, 0, inputs);
    device.queue.writeBuffer(substrateInput, 0, substrateData);
    const module = device.createShaderModule({ label: "blood/optical LUT parity", code: BLOOD_OPTICS_WGSL + `
      @group(0) @binding(0) var<storage,read> thicknesses:array<f32>;
      @group(0) @binding(1) var<storage,read_write> output:array<vec4<f32>>;
      @group(0) @binding(2) var<storage,read> substrateInputs:array<vec4<f32>>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
        if(id.x<${inputs.length}u){
          let response=bloodSlabTransport(thicknesses[id.x]);
          output[2u*id.x]=vec4(response.reflectance,0.);
          output[2u*id.x+1u]=vec4(response.transmittance,0.);
        }
        if(id.x<${fixtures.length}u){
          let first=substrateInputs[3u*id.x];
          var transport=BloodSlabTransport(first.xyz,substrateInputs[3u*id.x+1u].xyz);
          if(first.w>=0.){transport=bloodSlabTransport(first.w);}
          let colour=composeDiffuseSubstrate(transport,substrateInputs[3u*id.x+2u].xyz);
          output[${inputs.length * 2}u+id.x]=vec4(colour,0.);
        }
      }` });
    const compilation = await module.getCompilationInfo();
    const compilationErrors = compilation.messages.filter(message => message.type === "error");
    if (compilationErrors.length) throw new Error(compilationErrors.map(message => `${message.lineNum}: ${message.message}`).join("\n"));
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } },
      { binding: 2, resource: { buffer: substrateInput } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(Math.max(inputs.length, fixtures.length) / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    for (let i = 0; i < inputs.length; ++i) {
      const thicknessM = inputs[i]!, cpu = bloodSlabTransport(thicknessM);
      const expected = [...cpu.reflectance, ...cpu.transmittance];
      const actual = [...result.slice(i * 8, i * 8 + 3), ...result.slice(i * 8 + 4, i * 8 + 7)];
      const finite = actual.every(Number.isFinite);
      const passive = actual.every(value => value >= 0) && [0, 1, 2].every(c => actual[c]! + actual[c + 3]! <= 1 + 2e-6);
      const maxError = Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!)));
      samples.push({ thicknessM, expected, actual, maxError, finite, passive, passed: finite && passive && maxError <= 2e-5 });
    }
    for (let i = 0; i < fixtures.length; ++i) {
      const sample = fixtures[i]!, expected = composeDiffuseSubstrate(sample.transport, sample.substrate);
      const offset = inputs.length * 8 + i * 4, actual = [...result.slice(offset, offset + 3)];
      const finite = actual.every(Number.isFinite), passive = actual.every(value => value >= 0 && value <= 1 + 2e-6);
      const maxError = Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!)));
      const cpuOracleError = Math.max(...expected.map((value, channel) => Math.abs(value - sample.oracle[channel]!)));
      substrateSamples.push({ name: sample.name, thicknessM: sample.thicknessM, ...sample.transport, substrate: sample.substrate,
        oracle: sample.oracle, expected, actual, cpuOracleError, maxError, finite, passive,
        passed: finite && passive && maxError <= 2e-5 && cpuOracleError <= 1e-12 });
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      const validation = await device.popErrorScope();
      if (validation) errors.push(validation.message);
    } catch (error) {
      errors.push(`Error-scope readback: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const resource of resources) resource.destroy();
    device.removeEventListener("uncapturederror", uncaptured);
    device.destroy();
  }
  return {
    gate: "blood-spectral-optics", status: samples.length === inputs.length && samples.every(sample => sample.passed)
      && substrateSamples.length === fixtures.length && substrateSamples.every(sample => sample.passed) && !errors.length ? "PASS" : "FAIL",
    model: BLOOD_OPTICS_PROVENANCE.id,
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description },
    tolerance: { absoluteRgbParity: 2e-5, channelEnergyExcess: 2e-6, cpuSubstrateOracle: 1e-12 },
    samples, substrateSamples, errors,
    limitation: "GPU/CPU lookup and RGB substrate-composition parity, independent bounce/limiting-case oracles and display-space bounds only; not validation against measured blood or final-image realism.",
  };
}
