/** Run the actual Studio decoder in Node for portable parity and bake timing.
 * This is not browser, GPU or rendering evidence.
 * Usage: node scripts/check_tissue_decoder.mjs MODEL.json OUTPUT_DIRECTORY [128|256|512] [UINT64_SEED]
 */
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import os from "node:os";
const args = process.argv.slice(2);
const [modelPath, outputPath, size = "256", seedInput = "42"] = args;
if (!modelPath || !outputPath || args.length > 4 || !["128", "256", "512"].includes(size)) throw new Error("Expected MODEL.json NEW_OUTPUT_DIRECTORY [128|256|512] [UINT64_SEED]");
const resolution = Number(size);
const compiled = await build({ entryPoints: ["apps/studio/src/tissues/neuralAppearance.ts"], bundle: true, platform: "node", format: "esm", write: false });
const decoder = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const seed = decoder.canonicalAppearanceSeed(seedInput);
const source = await readFile(modelPath, "utf8"), model = await decoder.parseAppearanceModel(source);
const latent = await decoder.appearanceLatent(seed, model.artifact.architecture.latent_dim);
await mkdir(outputPath); // An existing receipt is never silently replaced.
const receipt = { schema: "viscera.tissue-decoder-node-check/v1", modelId: model.modelId, modelPath, seed, resolution,
  artifactSchema: model.artifact.schema, nativeResolution: model.kind === "spatial" ? 128 : null,
  outputSampling: model.kind === "spatial" ? "periodic-bilinear-pixel-centers" : "direct-coordinate-inference",
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  referenceVectorsPassed: true, latent: Array.from(latent), browserExecuted: false, gpuExecuted: false, samples: [] };
for (let condition = 0; condition < model.artifact.architecture.condition_labels.length; condition++) {
  const rgba = new Uint8Array(resolution * resolution * 4), start = performance.now();
  for (let row = 0; row < resolution; row += 4) decoder.bakeAppearanceRows(model, latent, condition, resolution, row, Math.min(resolution, row + 4), rgba);
  const milliseconds = performance.now() - start, filename = `condition-${condition}-seed${seed}-${resolution}.rgba`;
  await writeFile(path.join(outputPath, filename), rgba);
  receipt.samples.push({ condition, label: model.artifact.architecture.condition_labels[condition], file: filename, milliseconds,
    bytes: rgba.length, sha256: createHash("sha256").update(rgba).digest("hex") });
}
await writeFile(path.join(outputPath, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
