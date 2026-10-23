#!/usr/bin/env node
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-optimization-2026-10-20/bench"));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal"],
} : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const errors = [], results = {};
page.on("pageerror", e => errors.push(String(e)));
page.on("console", e => { if (e.type() === "error") errors.push(e.text()); });
const variants = process.argv.includes("--merge") ? {
  tiled: { optimizedSort: true, compactPressure: true, localMerge: false },
  combined: { optimizedSort: true, compactPressure: true, localMerge: true },
} : {
  reference: { optimizedSort: false, compactPressure: false },
  tiled: { optimizedSort: true, compactPressure: false, localMerge: false },
  pressure: { optimizedSort: false, compactPressure: true },
  combined: { optimizedSort: true, compactPressure: true, localMerge: process.argv.includes("--verify") || process.argv.includes("--failure") },
};
const replay = JSON.parse(await fs.readFile(path.join(root, "artifacts/blood-2026-10-20/motion-v3/accepted-state.json"), "utf8"));
const jobs = process.argv.includes("--lifecycle") ? [
  ["lifecycle-compact", "renderLifecycleBench", [true]], ["lifecycle-reference", "renderLifecycleBench", [false]],
] : process.argv.includes("--failure") ? ["reference", "combined"].map(name =>
  [`overflow-${name}`, "solverPerformanceBench", [variants[name], { fixture: "dam", dtSeconds: .0001 }, 640, 512]]) : process.argv.includes("--render") ? [
  ...[0, 1, 2].flatMap(trial => (trial % 2 ? [true, false] : [false, true]).map(compact =>
    [`render-4k-${compact ? "compact" : "reference"}-${trial}`, "renderPerformanceBench", [compact, 3840, 2160]])),
  ...[0, 8, -12].flatMap(orbit => [false, true].map(compact =>
    [`tray-${orbit}-${compact ? "compact" : "reference"}`, "renderPerformanceBench", [compact, 1920, 1080, replay.config, replay.state, orbit, 8]])),
  ...[false, true].map(compact => [`bilateral-${compact ? "compact" : "reference"}`, "renderPerformanceBench", [compact, 1920, 1080, {}, null, 0, 8, "bilateral"]]),
] : process.argv.includes("--verify") ? [
  ...[8, 12, 16].flatMap(axis => ["reference", "combined"].map(name =>
    [`shear-${axis}-${name}`, "solverPerformanceBench", [variants[name], { axis }, 80]])),
  ...["compression", "vortex", "dam"].flatMap(fixture => ["reference", "combined"].map(name =>
    [`${fixture}-${name}`, "solverPerformanceBench", [variants[name], { fixture, ...(fixture === "dam" ? { dtSeconds: .0001 } : {}) }, fixture === "dam" ? 552 : 80]])),
] : [0, 1, 2].flatMap(trial => (trial % 2 ? Object.entries(variants).reverse() : Object.entries(variants)).map(([name, options]) =>
  [`${name}-${trial}`, "solverPerformanceBench", [options, {}, 80]]));
try {
  await page.goto(`${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174"}/src/blood/blood.css`);
  for (const [name, fn, args] of jobs) {
    console.log(`Running ${name}`);
    const result = await page.evaluate(async ({ fn, args }) => {
      const bench = await import("/src/blood/performanceBench.ts");
      return await bench[fn](...args);
    }, { fn, args });
    if (result.image) {
      await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(result.image.split(",")[1], "base64")); delete result.image;
    }
    results[name] = result;
    await fs.writeFile(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
    console.log(`${name}: ${result.status}; ${result.wallMs?.toFixed(2) ?? result.frameMs?.median.toFixed(2)} ms`);
  }
} finally {
  await fs.writeFile(path.join(out, "browser-errors.json"), JSON.stringify(errors, null, 2));
  await browser.close();
}
const comparisons = [];
for (const [name, result] of Object.entries(results)) {
  if (process.argv.includes("--lifecycle")) continue;
  let reference;
  if (process.argv.includes("--render")) {
    if (!name.includes("compact")) continue;
    reference = name.replace("compact", "reference");
  } else if (process.argv.includes("--verify") || process.argv.includes("--failure")) {
    if (!name.endsWith("combined")) continue;
    reference = name.replace("combined", "reference");
  } else {
    if (name.startsWith(process.argv.includes("--merge") ? "tiled" : "reference")) continue;
    reference = `${process.argv.includes("--merge") ? "tiled" : "reference"}-${name.split("-").at(-1)}`;
  }
  const baseline = results[reference];
  const rendering = process.argv.includes("--render");
  comparisons.push({ name, reference, stateEqual: !!result.stateHash && result.stateHash === baseline?.stateHash,
    controlsEqual: rendering ? null : !!result.controls && JSON.stringify(result.controls) === JSON.stringify(baseline?.controls),
    profiledStateEqual: rendering ? null : !!result.profiledStateHash && result.profiledStateHash === baseline?.profiledStateHash,
    profiledControlsEqual: rendering ? null : !!result.profiledControls && JSON.stringify(result.profiledControls) === JSON.stringify(baseline?.profiledControls),
    pixelsEqual: rendering ? !!result.pixelHash && result.pixelHash === baseline?.pixelHash : null,
    speedup: (baseline?.wallMs ?? baseline?.frameMs?.median) / (result.wallMs ?? result.frameMs?.median) });
}
await fs.writeFile(path.join(out, "comparisons.json"), JSON.stringify(comparisons, null, 2));
console.log(comparisons);
if (errors.length || Object.values(results).some(r => r.status !== "PASS") ||
  comparisons.some(c => [c.stateEqual, c.controlsEqual, c.pixelsEqual, c.profiledStateEqual, c.profiledControlsEqual].some(value => value === false))) process.exitCode = 1;
