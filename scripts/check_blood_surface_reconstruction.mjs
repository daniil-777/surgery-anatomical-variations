#!/usr/bin/env node
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const phase = process.argv[2] ?? "candidate";
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error("Invalid evidence phase");
const out = path.join(root, "artifacts/blood-surface-reconstruction-2026-10-20", phase);
await fs.mkdir(out, { recursive: true });
const frozen = JSON.parse(await fs.readFile(path.join(root, "artifacts/blood-2026-10-20/motion-v3/accepted-state.json"), "utf8"));
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"],
} : {}) });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const errors = [], results = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
async function run(name, options) {
  console.log(`Running ${name}`);
  const result = await page.evaluate(async options => {
    const { surfaceDiagnosticBench } = await import("/src/blood/surfaceReconstructionBench.ts");
    return await surfaceDiagnosticBench(options);
  }, { ...options, includeRaw: true });
  await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(result.image.split(",")[1], "base64"));
  delete result.image;
  for (const s of result.snapshots) {
    await fs.writeFile(path.join(out, `${name}-${s.label}.png`), Buffer.from(s.image.split(",")[1], "base64"));
    await fs.writeFile(path.join(out, `${name}-${s.label}.f32`), Buffer.from(s.rawFloat32Base64, "base64"));
    delete s.image; delete s.rawFloat32Base64;
  }
  await fs.writeFile(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
  results.push({ name, status: result.status, errors: result.errors, stateHash: result.stateHash });
  console.log(`${name}: ${result.status}`);
}
try {
  await page.goto(`${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174"}/src/blood/blood.css`);
  if (process.argv.includes("--optics-only")) {
    const result = await page.evaluate(async () => (await import("/src/blood/opticsBench.ts")).bloodOpticsBench());
    await fs.writeFile(path.join(out, "optics-gate.json"), JSON.stringify(result, null, 2));
    results.push({ name: "optics-gate", status: result.status, errors: result.errors ?? [] });
    console.log(`${result.gate}: ${result.status}; ${result.samples.length} samples; max RGB error ${Math.max(...result.samples.map(s => s.maxError))}`);
  } else if (process.argv.includes("--gate-only")) {
    const result = await page.evaluate(async () => (await import("/src/blood/surfaceReconstructionBench.ts")).surfaceReconstructionBench());
    await fs.writeFile(path.join(out, "reconstruction-gate.json"), JSON.stringify(result, null, 2));
    results.push({ name: "reconstruction-gate", status: result.status, errors: [] });
    console.log(JSON.stringify(result, null, 2));
  } else {
  const width = 128, height = 128, mid = width / 2;
  const fields = {
    plane: () => .06,
    isolated: (x, y) => x === mid && y === mid ? .03 : 0,
    filament: x => x === mid ? .03 : 0,
    overlap: (x, y) => x >= 45 && x <= 83 && y >= 45 && y <= 83 ? .03 : .06,
    "thin-overlap": x => x === mid ? .03 : .06,
    "inclined-overlap": (x, y) => x >= 45 && x <= 83 && y >= 45 && y <= 83 ? .03 : .06 + (x - mid) * .0002,
    silhouette: (x, y) => (x - mid) ** 2 + (y - mid) ** 2 <= 34 ** 2 ? .03 : 0,
  };
  for (const [name, field] of Object.entries(fields)) {
    await run(name, { width, height, scene: { fixture: "dam" }, depths: Array.from({ length: width * height }, (_, i) => field(i % width, Math.floor(i / width))) });
  }
  if (!process.argv.includes("--synthetic-only")) {
    for (const orbit of [0, 8]) await run(`tray-${orbit}`, { width: 1920, height: 1080, scene: frozen.config, state: frozen.state, orbit });
  }
  }
} finally {
  await fs.writeFile(path.join(out, "summary.json"), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
if (errors.length || results.some(r => r.status !== "PASS" || r.errors.length)) process.exitCode = 1;
