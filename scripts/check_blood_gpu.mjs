#!/usr/bin/env node
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-2026-10-20/gpu"));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"],
} : {}) });
const page = await browser.newPage();
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
const results = {};
const jobs = process.argv.includes("--long") ? [
  ["translation-10-seconds", "flowBench", [{ fixture: "translation", dtSeconds: .001, iterations: 1 }, 10000]],
] : process.argv.includes("--contact") ? [
  ["pressure-only", "flowBench", [{ fixture: "dam", dtSeconds: .0001, wallContact: "pressure-only" }, 1200]],
  ["contact-8", "flowBench", [{ fixture: "dam", dtSeconds: .0001 }, 1200]],
  ["contact-8-dt-half", "flowBench", [{ fixture: "dam", dtSeconds: .00005 }, 2400]],
  ["contact-12", "flowBench", [{ fixture: "dam", axis: 12, dtSeconds: .0001 }, 1200]],
] : process.argv.includes("--flow") ? [
  ["shear-8", "flowBench", [{ axis: 8 }, 200]],
  ["shear-12", "flowBench", [{ axis: 12 }, 200]],
  ["shear-16", "flowBench", [{ axis: 16 }, 200]],
  ["shear-dt-half", "flowBench", [{ axis: 8, dtSeconds: .00025 }, 400]],
  ["tray", "flowBench", [{ fixture: "dam" }, 200]],
] : process.argv.includes("--optimization") ? [0, 1, 2].flatMap(trial => [
  [`baseline-${trial}`, "flowBench", [{}, 100, false]], [`candidate-${trial}`, "flowBench", [{}, 100, true]],
]) : [
  ["material", "materialBench", []],
  ...["lattice", "dense", "tail", "walls"].map(kind => [`neighbors-${kind}`, "neighborBench", [kind]]),
  ["transaction", "transactionBench", []], ["convergence-cap", "capBench", []],
  ["contact-operator", "contactBench", []],
  ["surface-normal", "surfaceNormalBench", []],
  ["surface-tangent", "surfaceTangentBench", []],
  ["surface-reconstruction", "surfaceReconstructionBench", []],
  ["spectral-optics", "bloodOpticsBench", []],
  ["rendering-isolation", "renderingIsolationBench", []],
];
try {
  // A same-origin text resource avoids running another Studio renderer during benchmarks.
  await page.goto(`${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174"}/src/blood/blood.css`);
  for (const [name, fn, args] of jobs) {
    console.log(`Running ${name}`);
    const result = await page.evaluate(async ({ fn, args }) => {
      const bench = await import("/src/blood/bench.ts");
      return await bench[fn](...args);
    }, { fn, args });
    results[name] = result;
    await fs.writeFile(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
    console.log(`${name}: ${result.status}${result.accepted === undefined ? "" : `; ${result.accepted} steps, ${result.wallSeconds.toFixed(3)} s wall, shear L2 ${result.shearRelativeL2}`}`);
  }
} finally {
  await fs.writeFile(path.join(out, "browser-errors.json"), JSON.stringify(errors, null, 2));
  await browser.close();
}
const failures = Object.entries(results).filter(([, r]) => r.status === "FAIL" || r.errors?.length);
if (errors.length || failures.length) {
  console.error({ errors, failed: failures.map(([name]) => name) });
  process.exitCode = 1;
}
