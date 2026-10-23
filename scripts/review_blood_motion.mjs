#!/usr/bin/env node
/** Exact accepted-state captures. Images are never generated or cosmetically edited. */
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-2026-10-20/motion"));
const replayFolder = process.env.BLOOD_REPLAY;
const replay = replayFolder ? { ...JSON.parse(await fs.readFile(path.join(replayFolder, "accepted-state.json"), "utf8")),
  last: JSON.parse(await fs.readFile(path.join(replayFolder, "motion.json"), "utf8")).frames.at(-1) } : null;
const width = Number(process.env.BLOOD_REVIEW_WIDTH ?? 1024), height = Number(process.env.BLOOD_REVIEW_HEIGHT ?? 744);
const fixture = process.env.BLOOD_FIXTURE ?? "dam";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  executablePath: process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
  args: ["--use-gl=angle", "--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width, height: height + 56 }, deviceScaleFactor: 1 });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const errors = [], frames = [], series = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
try {
  await page.goto(`${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174"}/src/blood/blood.css`);
  const setup = await page.evaluate(async ({ replay, width, height, fixture }) => {
    const { BloodRuntime } = await import("/src/blood/runtime.ts");
    const { BloodRenderer } = await import("/src/blood/renderer.ts");
    const { DEFAULT_SCENE } = await import("/src/blood/scene.ts");
    document.body.replaceChildren(); document.body.style.cssText = "margin:0;background:#131923;color:#eee;font:16px system-ui";
    const host = document.createElement("div"); host.style.cssText = `width:${width}px;height:${height}px;position:relative`;
    const canvas = document.createElement("canvas"); canvas.style.cssText = "width:100%;height:100%";
    host.appendChild(canvas); document.body.appendChild(host);
    const caption = document.createElement("div"); caption.id = "caption"; caption.style.cssText = "padding:12px 20px"; document.body.appendChild(caption);
    const runtime = await BloodRuntime.create(replay?.config ?? { ...DEFAULT_SCENE, fixture, dtSeconds: .0001 });
    if (replay) {
      runtime.device.queue.writeBuffer(runtime.accepted, 0, new Float32Array(replay.state));
      const control = new Uint32Array(64); control[0] = 1; control[1] = replay.last.accepted; control[5] = replay.last.failure;
      runtime.device.queue.writeBuffer(runtime.control, 0, control);
    }
    const view = new BloodRenderer(canvas, runtime);
    globalThis.bloodReview = { runtime, view, canvas, caption };
    return { config: runtime.scene, hash: runtime.configHash, adapter: runtime.adapterInfo };
  }, { replay, width, height, fixture });
  const render = async (filter, name) => {
    const data = await page.evaluate(async filter => {
      const { runtime: r, view, caption } = globalThis.bloodReview;
      view.surfaceFilter = filter;
      await r.submit(0, view.encode);
      const raw = await r.readBuffer(r.control), u = new Uint32Array(raw);
      caption.textContent = `Experimental fluid · t = ${(u[1] * r.scene.dtSeconds).toFixed(4)} s · ${filter} · ${u[0] ? "HALTED: candidate rejected" : "accepted state"} · no capillarity`;
      const state = await r.readBuffer(r.accepted);
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", state))].map(x => x.toString(16).padStart(2, "0")).join("");
      return { accepted: u[1], time: u[1] * r.scene.dtSeconds, failure: u[5], stateHash: hash, filter, errors: r.errors };
    }, filter);
    await page.screenshot({ path: path.join(out, name) }); return { file: name, ...data };
  };
  const baseline = await render("bilateral", "filter-baseline.png");
  const candidate = await render("narrow-range", "filter-candidate.png");
  frames.push(await render("narrow-range", "frame-000.png"));
  let frame = 1, halted = false;
  while (!process.argv.includes("--stills") && !replay && frame <= 12 && !halted) {
    console.log(`Simulating motion interval ${frame}`);
    const report = await page.evaluate(async () => {
      const { runtime: r } = globalThis.bloodReview;
      const reports = [];
      for (let step = 0; step < 100; step += 4) {
        await r.submit(4);
        const raw = await r.readBuffer(r.control), u = new Uint32Array(raw), f = new Float32Array(raw);
        reports.push({ accepted: u[1], failure: u[5], halted: u[0], density: f[6], divergence: f[7],
          maxAcceptedDensityError: f[13], maxAcceptedDivergenceS: f[14], contactProjections: u[17] });
        if (u[0]) break;
      }
      return reports;
    });
    series.push(...report); halted = !!report.at(-1).halted;
    frames.push(await render("narrow-range", `frame-${String(frame).padStart(3, "0")}.png`)); frame++;
  }
  const finalBaseline = await render("bilateral", "filter-final-baseline.png");
  const finalCandidate = await render("narrow-range", "filter-final-candidate.png");
  const orbit = [];
  for (let i = 0; i < 3; ++i) {
    await page.locator("canvas").focus();
    for (let k = 0; k < 5; ++k) await page.keyboard.press("ArrowRight");
    orbit.push(await render("narrow-range", `orbit-${i}.png`));
  }
  const state = await page.evaluate(async () => {
    const r = globalThis.bloodReview.runtime;
    return Array.from(new Float32Array(await r.readBuffer(r.accepted)));
  });
  await fs.writeFile(path.join(out, "accepted-state.json"), JSON.stringify({ ...setup, state }));
  await fs.writeFile(path.join(out, "motion.json"), JSON.stringify({ ...setup, frames, series, orbit, comparisons: { baseline, candidate, finalBaseline, finalCandidate },
    renderingLeavesStateUnchanged: baseline.stateHash === candidate.stateHash && finalBaseline.stateHash === finalCandidate.stateHash && orbit.every(x => x.stateHash === finalCandidate.stateHash),
    timing: "Frames sample accepted physical time; any assembled movie is an explicitly labelled slow-motion review, not a real-time performance demonstration.",
    errors }, null, 2));
  if (errors.length || frames.some(frame => frame.errors.length)) process.exitCode = 1;
} finally {
  await page.evaluate(() => { const r = globalThis.bloodReview; r?.view.dispose(); r?.runtime.dispose(); }).catch(() => {});
  await browser.close();
}
