#!/usr/bin/env node
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const out = path.resolve(process.env.BLOOD_EVIDENCE ?? "artifacts/blood-artery-2026-10-20/renderer");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal"],
} : {}) });
const errors = [];
let result;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.goto(`${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174"}/src/blood/blood.css`);
  result = await page.evaluate(async () => {
    const { arteryRendererBench } = await import("/src/blood/artery/renderBench.ts");
    return arteryRendererBench();
  });
  if (result.status !== "PASS" || errors.length) process.exitCode = 1;
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, errors,
    failed: result.checks.filter(check => !check.passed) }, null, 2));
} catch (error) {
  errors.push(String(error)); process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, "renderer.json"), JSON.stringify({ ...result, browserErrors: errors }, null, 2));
  await browser.close();
}
