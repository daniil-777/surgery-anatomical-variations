#!/usr/bin/env node
// Operates real UI controls and records actual native-size video. Run alone on GPU.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-experiments-2026-10-20/browser"));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
const url = new URL(base); url.searchParams.set("mode", "blood"); url.searchParams.set("flow", "experiments");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ["microphone"], acceptDownloads: true });
const page = await context.newPage(), checks = [], errors = [], failedRequests = [];
page.setDefaultTimeout(20000);
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() }); });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const check = (name, details = {}) => { checks.push({ name, status: "PASS", ...details }); console.log(name); };
const button = name => page.getByRole("button", { name, exact: true });
const canvas = page.locator(".artery-canvas-host canvas"), stage = page.getByRole("region", { name: "Blood experiment scene" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const download = async (locator, name) => {
  const pending = page.waitForEvent("download"); await locator.click(); const item = await pending;
  const filename = path.join(out, name ?? item.suggestedFilename()); await item.saveAs(filename); return filename;
};
const exported = async name => JSON.parse(await fs.readFile(await download(button("Export experiment evidence"), name), "utf8"));
const ready = async () => {
  await expect(button("Run experiment")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
};
const choose = async name => { await button(name).click(); await ready(); await expect(page.getByTestId("experiment-time")).toHaveText("0.000 s"); };
const reset = async () => { await button("Apply & reset").click(); await ready(); await expect(page.getByTestId("experiment-time")).toHaveText("0.000 s"); };
const runTo = async seconds => {
  await button("Run experiment").click();
  await expect.poll(async () => parseFloat(await page.getByTestId("experiment-time").textContent()), { timeout: 60000 }).toBeGreaterThanOrEqual(seconds);
  await button("Pause experiment").click();
};
const advanceExactly = async count => {
  for (let i = 0; i < count; i++) await button("Advance 10 ms").click();
  await expect(page.getByTestId("experiment-time")).toHaveText(`${(count * .01).toFixed(3)} s`);
};
const sum = values => values.reduce((total, value) => total + value, 0);
const relativeVolume = (actual, expected, tolerance = 1e-10) => {
  expect(Number.isFinite(actual)).toBe(true); expect(Number.isFinite(expected)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-18, Math.abs(expected) * tolerance));
};
const physicalVector = value => {
  expect(value).toHaveLength(3); expect(value.every(Number.isFinite)).toBe(true);
};
function validate(data) {
  expect(data.schema).toBe("viscera.blood-experiments.evidence/v1");
  expect(Number.isFinite(data.snapshot.timeSeconds)).toBe(true);
  expect(data.observationHistory.at(-1).time).toBe(data.snapshot.timeSeconds);
  expect(data.execution.acceptedTimeSeconds).toBe(data.snapshot.timeSeconds);
  expect(data.execution.renderedTimeSeconds).toBe(data.snapshot.timeSeconds);
  expect(Math.abs(data.reading.volumeError)).toBeLessThan(2e-9);
  if (data.experiment.startsWith("tank")) {
    const { snapshot: s, config: c } = data;
    expect(s.heightM).toHaveLength(c.nx * c.nz);
    expect(s.heightM.every(value => Number.isFinite(value) && value > 0 && value < c.heightM)).toBe(true);
    const volume = s.fluidColumnM.reduce((a, b) => a + b, 0) * c.widthM * c.depthM / c.nx / c.nz;
    expect(Math.abs(volume / s.fluidVolumeM3 - 1)).toBeLessThan(1e-11);
    expect(Math.abs(s.fluidVolumeM3 / (c.widthM * c.depthM * c.fillDepthM) - 1)).toBeLessThan(1e-11);
    expect(s.totalEnergyJ).toBeGreaterThan(0);
  } else {
    const { snapshot: s, config: c } = data;
    const { breakup: flight, collector: film, cardiovascular: cv } = s;
    expect(s.flightModel).toBe("external-capillary");
    expect(s.parcels).toEqual([]); // Legacy trajectories must not duplicate authoritative breakup mass.
    expect(flight.timeSeconds).toBe(s.timeSeconds); expect(film.timeSeconds).toBe(s.timeSeconds);
    relativeVolume(flight.emittedVolumeM3, s.expelledVolumeM3);
    relativeVolume(flight.inFlightVolumeM3, s.inFlightVolumeM3);
    relativeVolume(flight.landedVolumeM3, s.landedVolumeM3);
    relativeVolume(film.inputVolumeM3, flight.landedVolumeM3);
    relativeVolume(film.depositedVolumeM3 + film.escapedVolumeM3, film.inputVolumeM3);
    relativeVolume(film.filmVolumeM3 + film.escapedVolumeM3, film.initialFilmVolumeM3 + film.inputVolumeM3);
    relativeVolume(s.expelledVolumeM3, s.inFlightVolumeM3 + s.landedVolumeM3);
    const external = s.inFlightVolumeM3 + film.filmVolumeM3 - film.initialFilmVolumeM3 + film.escapedVolumeM3;
    if (cv) {
      expect(s.perfusionModel).toBe("external-circulation"); expect(s.supplyVolumeM3).toBe(0);
      expect(Math.abs(cv.timeSeconds - s.timeSeconds)).toBeLessThanOrEqual(Math.max(1e-12, s.timeSeconds * 1e-12));
      expect(cv.stepIndex).toBe(s.stepIndex);
      relativeVolume(sum(Object.values(cv.compartmentVolumesM3)), cv.circulatingVolumeM3);
      relativeVolume(cv.circulatingVolumeM3 + cv.netTransferredToLocalM3, c.cardiovascular.initialBloodVolumeM3);
      relativeVolume(cv.netTransferredToLocalM3, s.externalSuppliedVolumeM3 - s.distalCollectedVolumeM3);
      // Distal flow returns to the circuit. Counting that signed transfer again
      // as stored volume would conceal a coupled-inventory error.
      relativeVolume(cv.circulatingVolumeM3 + s.vesselVolumeM3 + external, c.initialCombinedInventoryM3);
      relativeVolume(s.vesselVolumeM3 + s.distalCollectedVolumeM3 + s.expelledVolumeM3,
        c.initialVesselVolumeM3 + s.externalSuppliedVolumeM3);
      expect(Math.abs(s.sourcePressurePa - cv.pressuresPa.systemicArtery)).toBeLessThanOrEqual(1.1e-6);
      expect(Math.abs(s.distalBoundaryPressurePa - cv.pressuresPa.systemicVein)).toBeLessThanOrEqual(1.1e-6);
    } else {
      expect(s.perfusionModel).toBe("finite-reservoir"); expect(c.cardiovascular).toBeNull();
      relativeVolume(s.vesselVolumeM3 + s.supplyVolumeM3 + s.distalCollectedVolumeM3 + external,
        c.initialCombinedInventoryM3);
    }
    expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThanOrEqual(c.initialCombinedInventoryM3 * 1e-10);
    let ligamentVolume = 0, dropVolume = 0;
    for (const ligament of flight.ligaments) {
      expect(ligament.volumeM3).toBeGreaterThan(0); expect(ligament.points.length).toBeGreaterThan(1);
      let geometricVolume = 0;
      for (let i = 0; i < ligament.points.length; i++) {
        const point = ligament.points[i]; physicalVector(point.positionM);
        expect(Number.isFinite(point.radiusM) && point.radiusM > 0).toBe(true);
        if (i) {
          const a = ligament.points[i - 1], length = Math.hypot(...point.positionM.map((v, axis) => v - a.positionM[axis]));
          geometricVolume += Math.PI * length * (a.radiusM ** 2 + a.radiusM * point.radiusM + point.radiusM ** 2) / 3;
        }
      }
      relativeVolume(geometricVolume, ligament.volumeM3); ligamentVolume += ligament.volumeM3;
    }
    for (const drop of flight.droplets) {
      physicalVector(drop.positionM); physicalVector(drop.velocityMS);
      expect(drop.volumeM3).toBeGreaterThan(0); expect(drop.radiusM).toBeGreaterThan(0);
      relativeVolume(4 * Math.PI * drop.radiusM ** 3 / 3, drop.volumeM3); dropVolume += drop.volumeM3;
    }
    relativeVolume(ligamentVolume + dropVolume, flight.inFlightVolumeM3);
    expect(data.renderer.dropletCount).toBe(flight.droplets.length);
    expect(data.renderer.ligamentCount).toBe(flight.ligaments.length);
    relativeVolume(data.renderer.reconstructedJetVolumeM3, ligamentVolume, 3e-6);
    relativeVolume(data.renderer.reconstructedDropletVolumeM3, dropVolume, 3e-6);
    expect(film.heightM).toHaveLength(c.collector.nx * c.collector.nz);
    expect(film.heightM.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    const area = c.collector.widthM * c.collector.depthM / (c.collector.nx * c.collector.nz);
    relativeVolume(sum(film.heightM) * area, film.filmVolumeM3);
    relativeVolume(data.renderer.collectorFilmVolumeM3, film.filmVolumeM3);
    expect(data.renderer.collectorGrid).toEqual([c.collector.nx, c.collector.nz]);
    expect(data.renderer.collectorHeightRangeM).toEqual([Math.min(...film.heightM), Math.max(...film.heightM)]);
  }
}
async function inspectCardiovascularControls() {
  await choose("Arterial puncture");
  await expect(page.getByLabel("Circulation driver", { exact: true })).toHaveValue("cardiovascular");
  await expect(page.getByLabel("Mean supply pressure", { exact: true })).toHaveCount(0);
  await advanceExactly(12);
  const baseline = await exported("cardiovascular-controls-baseline.json"); validate(baseline);
  const baselineTrace = baseline.observationHistory.map(row => row.arterialPressureMMHg);
  expect(baselineTrace.every(Number.isFinite)).toBe(true);
  expect(Math.max(...baselineTrace) - Math.min(...baselineTrace)).toBeGreaterThan(.01);
  await expect(page.getByRole("img", { name: /^Systemic arterial pressure over accepted physical time/ })).toBeVisible();
  const changes = [
    { label: "Heart rate", key: "heartRateBpm", value: 140, range: true },
    { label: "Systemic vascular resistance", key: "systemicResistanceScale", value: 1.25 },
    { label: "Ventricular contractility", key: "contractilityScale", value: .75 },
    { label: "Initial circulating blood", key: "totalBloodL", value: 4.5 },
  ];
  for (const change of changes) {
    await choose("Arterial puncture");
    const before = await exported(`cardiovascular-${change.key}-before.json`); validate(before);
    const control = page.getByLabel(change.label, { exact: true });
    if (change.range) { await control.focus(); await control.press("End"); }
    else await control.selectOption(String(change.value));
    await expect(control).toHaveValue(String(change.value));
    await expect(page.getByText("Parameter changes are pending. Apply & reset to use them.", { exact: true })).toBeVisible();
    const pending = await exported(`cardiovascular-${change.key}-pending.json`); validate(pending);
    expect(pending.snapshot).toEqual(before.snapshot); expect(pending.config).toEqual(before.config);
    expect(pending.settings).toEqual(before.settings);
    await reset(); await advanceExactly(12);
    const changed = await exported(`cardiovascular-${change.key}-applied.json`); validate(changed);
    expect(changed.settings[change.key]).toBe(change.value);
    if (change.key === "totalBloodL") {
      relativeVolume(changed.config.initialCombinedInventoryM3, change.value * .001);
      relativeVolume(changed.config.cardiovascular.initialBloodVolumeM3 + changed.config.initialVesselVolumeM3,
        change.value * .001);
    } else expect(changed.config.cardiovascular[change.key]).toBe(change.value);
    const changedTrace = changed.observationHistory.map(row => row.arterialPressureMMHg);
    expect(changed.observationHistory.map(row => row.time)).toEqual(baseline.observationHistory.map(row => row.time));
    expect(changedTrace.every(Number.isFinite)).toBe(true);
    expect(Math.max(...changedTrace) - Math.min(...changedTrace)).toBeGreaterThan(.01);
    expect(Math.max(...changedTrace.map((pressure, i) => Math.abs(pressure - baselineTrace[i])))).toBeGreaterThan(.01);
    await expect(page.getByTestId("experiment-arterial-pressure"))
      .toHaveText(`${changed.reading.arterialPressureMMHg.toFixed(2)} mmHg`);
    await button("Keep current observation").click();
    const repeated = await exported(`cardiovascular-${change.key}-repeat-export.json`); validate(repeated);
    expect(repeated.snapshot).toEqual(changed.snapshot); expect(repeated.observationHistory).toEqual(changed.observationHistory);
    expect(repeated.comparisonTrials.at(-1)[change.key]).toBe(change.value);
    check(`${change.label}: actual control changes the accepted circulation and pressure trace after reset`,
      { value: change.value, physicalTime: changed.snapshot.timeSeconds, pendingStatePreserved: true });
  }
}
async function inspectAppearance(id, vessel = false) {
  const initial = await exported(`${id}-appearance-before.json`); validate(initial);
  const original = hash(await canvas.screenshot());
  await button("Inspect material").click(); await frames();
  expect(hash(await canvas.screenshot({ path: path.join(out, `${id}-material-close.png`) }))).not.toBe(original);
  const close = await exported(`${id}-material-close.json`);
  expect(close.snapshot).toEqual(initial.snapshot);
  expect(close.appearance).toEqual(initial.appearance);
  await button("Scene overview").click(); await frames();
  expect(hash(await canvas.screenshot())).toBe(original);
  await page.getByLabel("Experiment illumination", { exact: true }).selectOption("studio"); await frames();
  const studio = hash(await canvas.screenshot({ path: path.join(out, `${id}-studio.png`) }));
  expect(studio).not.toBe(original);
  await page.getByLabel("Experiment illumination", { exact: true }).selectOption("camera"); await frames();
  expect(hash(await canvas.screenshot())).toBe(original);
  const oxygenationImages = [];
  for (const oxygenation of ["0.98", "0.75", "0.6"]) {
    await page.getByLabel("Blood oxygenation reference", { exact: true }).selectOption(oxygenation); await frames();
    oxygenationImages.push(hash(await canvas.screenshot({ path: path.join(out, `${id}-oxygenation-${oxygenation}.png`) })));
    const state = await exported(`${id}-oxygenation-${oxygenation}.json`);
    expect(state.snapshot).toEqual(initial.snapshot);
    expect(state.appearance.oxygenationFraction).toBe(Number(oxygenation));
    expect(state.renderer.appearance.oxygenationFraction).toBe(Number(oxygenation));
  }
  expect(new Set(oxygenationImages).size).toBe(3);
  await page.getByLabel("Blood oxygenation reference", { exact: true }).selectOption(String(initial.appearance.oxygenationFraction));
  const exposure = page.getByLabel("Experiment exposure", { exact: true });
  await exposure.focus(); await exposure.press("Home");
  for (let i = 0; i < 4; i++) await exposure.press("ArrowRight");
  await expect(exposure).toHaveValue("-1"); await frames();
  expect(hash(await canvas.screenshot({ path: path.join(out, `${id}-exposure-minus1.png`) }))).not.toBe(original);
  for (let i = 0; i < 4; i++) await exposure.press("ArrowRight");
  await expect(exposure).toHaveValue("0");
  await page.getByLabel("Show neutral reference patches", { exact: true }).check(); await frames();
  expect(hash(await canvas.screenshot({ path: path.join(out, `${id}-reference-patches.png`) }))).not.toBe(original);
  await page.getByLabel("Show neutral reference patches", { exact: true }).uncheck();
  if (vessel) {
    await page.getByLabel("Vessel wall microstructure", { exact: true }).uncheck(); await frames();
    expect(hash(await canvas.screenshot({ path: path.join(out, `${id}-wall-detail-off.png`) }))).not.toBe(original);
    await page.getByLabel("Vessel wall microstructure", { exact: true }).check();
  }
  await frames();
  const final = await exported(`${id}-appearance-after.json`); validate(final);
  expect(final.snapshot).toEqual(initial.snapshot);
  expect(final.appearance).toEqual(initial.appearance);
  expect(hash(await canvas.screenshot())).toBe(original);
  check(`${id}: reversible light, spectral oxygenation, exposure and detail affect pixels without changing physics`,
    { oxygenationImageHashes: oxygenationImages, wallDetail: vessel, snapshotIdentical: true });
}
async function record(id, quality, microphone = false) {
  await button("Video recorder").click();
  if (await button("Record another").isVisible()) await button("Record another").click();
  await page.getByRole("radio", { name: quality.label, exact: true }).check();
  await page.getByLabel("Recording frame rate").selectOption("30");
  if (microphone) await page.getByLabel("Record microphone audio").check();
  else await page.getByLabel("Record microphone audio").uncheck();
  await button("Start recording").click();
  await expect(button("Stop video recording")).toBeVisible();
  await expect(canvas).toHaveAttribute("width", String(quality.width)); await expect(canvas).toHaveAttribute("height", String(quality.height));
  await button("Still tank").click();
  await expect(page.getByText("Stop the recording before changing experiments.", { exact: true })).toBeVisible();
  await button("Apply & reset").click();
  await expect(page.getByText("Stop the recording before applying settings.", { exact: true })).toBeVisible();
  await button("Artery flow playground").click();
  await expect(page.getByText("Stop the recording before changing workspaces.", { exact: true })).toBeVisible();
  const before = parseFloat(await page.getByTestId("experiment-time").textContent());
  await button("Run experiment").click(); await page.waitForTimeout(1800);
  await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(1800);
  await button("Stop video recording").click();
  await expect(page.getByRole("region", { name: "Finished recording" })).toBeVisible({ timeout: 30000 });
  const movie = await download(page.getByRole("link", { name: /Download (MP4|WEBM)/ }), `${id}.${await page.getByRole("link", { name: /Download (MP4|WEBM)/ }).textContent().then(text => text.includes("MP4") ? "mp4" : "webm")}`);
  const details = JSON.parse(await fs.readFile(await download(button("Capture details"), `${id}-capture.json`), "utf8"));
  expect(details.width).toBe(quality.width); expect(details.height).toBe(quality.height);
  expect(details.sourceWidth).toBe(quality.width); expect(details.sourceHeight).toBe(quality.height); expect(details.upscaled).toBe(false);
  const probe = JSON.parse((await exec("/opt/homebrew/bin/ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", movie])).stdout);
  await fs.writeFile(path.join(out, `${id}-ffprobe.json`), JSON.stringify(probe, null, 2));
  const video = probe.streams.find(stream => stream.codec_type === "video");
  expect(video.width).toBe(quality.width); expect(video.height).toBe(quality.height); expect(Number(video.nb_read_frames)).toBeGreaterThan(20);
  if (microphone) expect(probe.streams.some(stream => stream.codec_type === "audio")).toBe(true);
  const dir = path.join(out, `${id}-frames`); await fs.mkdir(dir, { recursive: true });
  await exec("/opt/homebrew/bin/ffmpeg", ["-y", "-v", "error", "-i", movie, "-vf", "fps=1", "-frames:v", "5", path.join(dir, "frame-%02d.png")]);
  const files = (await fs.readdir(dir)).filter(file => file.endsWith(".png"));
  expect(files.length).toBeGreaterThanOrEqual(2);
  expect(new Set(await Promise.all(files.map(async file => hash(await fs.readFile(path.join(dir, file)))))).size).toBeGreaterThan(1);
  await button("Close video recorder").click(); await button("Pause experiment").click();
  const state = await exported(`${id}-state.json`); validate(state);
  expect(state.snapshot.timeSeconds).toBeGreaterThan(before);
  check(`${id}: native moving video, decoded frames and reset/workspace guards`, {
    file: path.basename(movie), dimensions: [video.width, video.height], frames: Number(video.nb_read_frames),
    averageFrameRate: video.avg_frame_rate, audio: probe.streams.some(stream => stream.codec_type === "audio"),
    physicalTime: state.snapshot.timeSeconds, reviewFrames: files.length,
  });
}
let status = "FAIL", caught, accessibility;
try {
  await page.goto(url.href); await ready();
  await choose("Still tank"); const rest = await exported("tank-rest-initial.json"); validate(rest);
  await runTo(.5); const resting = await exported("tank-rest-after.json"); validate(resting);
  expect(resting.snapshot.heightM).toEqual(rest.snapshot.heightM);
  await stage.screenshot({ path: path.join(out, "tank-rest.png") });
  check("Hydrostatic rest is visually available and numerically stationary");
  await choose("Object impact"); await button("Drop object").click();
  await button("Advance 10 ms").click();
  const falling = await exported("tank-free-fall.json"); validate(falling);
  expect(falling.snapshot.timeSeconds).toBeCloseTo(.01, 12); expect(falling.snapshot.body.velocityMS).toBeLessThan(0);
  await runTo(1); const impacted = await exported("tank-impact.json"); validate(impacted);
  expect(impacted.snapshot.body.submergedVolumeM3).toBeGreaterThan(0);
  expect(Math.max(...impacted.snapshot.heightM) - Math.min(...impacted.snapshot.heightM)).toBeGreaterThan(1e-6);
  await stage.screenshot({ path: path.join(out, "tank-impact.png") });
  await button("Keep current observation").click();
  await page.getByLabel("Experiment playback speed", { exact: true }).selectOption("0.25");
  await page.waitForTimeout(300); const paused = await exported("tank-paused.json");
  expect(paused.snapshot).toEqual(impacted.snapshot);
  expect(paused.execution.phase).toBe("paused"); expect(paused.execution.error).toBeNull();
  expect(paused.settings.playback).toBe(.25);
  expect(paused.comparisonTrials.at(-1).bodyReleased).toBe(true);
  expect(paused.comparisonTrials.at(-1).interventions).toEqual([{ action: "release-body", timeSeconds: 0 }]);
  await page.getByLabel("Experiment playback speed", { exact: true }).selectOption("1");
  const before = await canvas.screenshot(); await canvas.focus(); await page.keyboard.press("ArrowRight"); await frames();
  expect(hash(await canvas.screenshot())).not.toBe(hash(before));
  expect((await exported("tank-camera.json")).snapshot).toEqual(paused.snapshot);
  await page.keyboard.press("Home");
  check("Object falls, displaces fluid, conserves volume; camera and pause preserve state");
  await inspectAppearance("tank");
  await page.getByLabel("Drop object", { exact: true }).selectOption("cube");
  await page.getByLabel("Object density", { exact: true }).selectOption("1000");
  await page.getByLabel("Release height", { exact: true }).selectOption("1");
  await expect(button("Object released · reset for another")).toBeDisabled(); await reset();
  await button("Drop object").click(); await runTo(.7);
  const cube = await exported("tank-cube.json"); validate(cube);
  expect(cube.snapshot.body.shape).toBe("cube"); expect(cube.snapshot.body.sizeM).toBe(.008); expect(cube.snapshot.body.densityKgM3).toBe(1000);
  await stage.screenshot({ path: path.join(out, "tank-cube.png") });
  check("Cube, density and release-height controls change the accepted body");
  await choose("Viscosity & waves");
  for (const viscosity of [.00345, .01, .03]) {
    await page.getByLabel("Experiment viscosity").selectOption(String(viscosity)); await reset(); await runTo(.4);
    const wave = await exported(`wave-${viscosity}.json`); validate(wave);
    expect(wave.config.viscosityPaS).toBe(viscosity); expect(wave.config.initialWaveAmplitudeM).toBe(.0005);
    expect(wave.snapshot.dissipatedEnergyJ).toBeGreaterThan(0);
  }
  await stage.screenshot({ path: path.join(out, "tank-waves.png") });
  check("All viscosity settings drive an evolving wave with a dissipation ledger");
  await inspectCardiovascularControls();
  for (const name of ["Arterial puncture", "Venous puncture"]) {
    await choose(name); const intact = await exported(`${name}-intact.json`); validate(intact);
    expect(intact.snapshot.jets).toHaveLength(0);
    expect(intact.settings.perfusion).toBe("cardiovascular");
    expect(intact.snapshot.cardiovascular).not.toBeNull();
    await button("Open puncture 1").click(); await runTo(.8);
    const one = await exported(`${name}-one-hole.json`); validate(one);
    expect(one.interventions).toEqual([{ action: "set-punctures", timeSeconds: 0, openHoleIndices: [0] }]);
    expect(one.snapshot.jets).toHaveLength(1); expect(one.snapshot.jets[0].flowM3S).toBeGreaterThan(0);
    expect(one.snapshot.expelledVolumeM3).toBeGreaterThan(0);
    expect(one.snapshot.collector.depositedVolumeM3).toBeGreaterThan(0);
    const filmRangeM = Math.max(...one.snapshot.collector.heightM) - Math.min(...one.snapshot.collector.heightM);
    expect(filmRangeM).toBeGreaterThan(1e-6);
    if (name === "Arterial puncture") {
      expect(one.snapshot.breakup.pinchCount).toBeGreaterThan(0);
      expect(one.snapshot.breakup.droplets.length).toBeGreaterThan(0);
      expect(one.snapshot.breakup.ligaments.length).toBeGreaterThan(0);
      expect(one.renderer.reconstructedDropletVolumeM3).toBeGreaterThan(0);
    }
    if (one.snapshot.breakup.lowWeberVolumeM3 > 0) {
      await expect(page.getByText("Some low-speed flow is outside this jet-breakup approximation. Dripping at the wound is unresolved; that fluid remains in the volume ledger.", { exact: true })).toBeVisible();
    }
    await stage.screenshot({ path: path.join(out, `${name}-one-hole.png`) });
    if (name === "Arterial puncture") await inspectAppearance("artery", true);
    await button("Open puncture 2").click(); await button("Open puncture 3").click(); await runTo(1.2);
    const three = await exported(`${name}-three-holes.json`); validate(three); expect(three.snapshot.jets).toHaveLength(3);
    expect(three.snapshot.jets.every(jet => jet.flowM3S > 0)).toBe(true);
    for (let i = 1; i <= 3; i++) await button(`Occlude puncture ${i}`).click();
    await runTo(1.6); const closed = await exported(`${name}-occluded.json`); validate(closed);
    expect(closed.snapshot.jets).toHaveLength(0);
    expect(closed.snapshot.expelledVolumeM3).toBe(three.snapshot.expelledVolumeM3);
    expect(closed.snapshot.breakup.inFlightVolumeM3).toBe(0);
    expect(closed.renderer.dropletCount).toBe(0); expect(closed.renderer.ligamentCount).toBe(0);
    check(`${name}: pressure-driven outflow, authoritative breakup, local film, closed-loop inventory and occlusion`,
      { pinchCount: one.snapshot.breakup.pinchCount, dropsInFlight: one.snapshot.breakup.droplets.length,
        nonuniformFilmRangeM: filmRangeM, lowWeberVolumeM3: one.snapshot.breakup.lowWeberVolumeM3 });
  }
  // A venous label alone does not establish a low Weber number: the default
  // puncture may still produce a jet. Exercise the actual low-speed regime.
  await choose("Venous puncture");
  await page.getByLabel("Puncture radius", { exact: true }).selectOption("0.2");
  await page.getByLabel("Experiment viscosity", { exact: true }).selectOption("0.03");
  await reset(); await button("Open puncture 1").click(); await runTo(.3);
  const lowWeber = await exported("venous-low-weber.json"); validate(lowWeber);
  expect(lowWeber.snapshot.breakup.lowWeberVolumeM3).toBeGreaterThan(0);
  expect(lowWeber.snapshot.breakup.ligaments.some(ligament => ligament.mode === "unresolved-dripping")).toBe(true);
  expect(lowWeber.snapshot.breakup.pinchCount).toBe(0);
  await expect(page.getByText("Some low-speed flow is outside this jet-breakup approximation. Dripping at the wound is unresolved; that fluid remains in the volume ledger.", { exact: true })).toBeVisible();
  await stage.screenshot({ path: path.join(out, "venous-low-weber.png") });
  check("Low-speed venous flow exposes its unresolved-dripping limit and retains all fluid in the ledger",
    { lowWeberVolumeM3: lowWeber.snapshot.breakup.lowWeberVolumeM3 });
  await page.getByLabel("Circulation driver", { exact: true }).selectOption("laboratory");
  await expect(page.getByLabel("Heart rate", { exact: true })).toHaveCount(0);
  await page.getByLabel("Puncture radius", { exact: true }).selectOption("0.6");
  await page.getByLabel("Experiment viscosity").selectOption("0.03");
  await page.getByLabel("Mean supply pressure", { exact: true }).focus();
  await page.keyboard.press("End"); await reset();
  await button("Open puncture 1").click(); await runTo(.25);
  const changed = await exported("vessel-changed-parameters.json"); validate(changed);
  expect(changed.snapshot.jets[0].radiusM).toBe(.0006); expect(changed.config.viscosityPaS).toBe(.03);
  expect(changed.snapshot.cardiovascular).toBeNull(); expect(changed.settings.perfusion).toBe("laboratory");
  expect(changed.config.sourcePressureMeanPa).toBeCloseTo(20 * 133.322387415, 9);
  check("Puncture radius, supply pressure and viscosity changes reach the physical solver");
  await button("Display settings").click(); await button("200%").click(); await button("Done").click();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.mouse.move(width - 8, 600); await page.mouse.wheel(0, 30000);
    await expect(page.getByRole("link", { name: "Read the height-field fluid research ↗" })).toBeInViewport();
    await page.mouse.wheel(0, -30000); await expect(page.getByRole("link", { name: "Anatomy studio", exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
  }
  await button("Display settings").click(); await button("Reset display preferences").click(); await button("Done").click();
  const height = await stage.evaluate(el => el.clientHeight);
  await page.getByRole("separator", { name: "Resize scene height" }).focus(); await page.keyboard.press("ArrowDown");
  await expect.poll(() => stage.evaluate(el => el.clientHeight)).toBeGreaterThan(height);
  await button("Scene full screen").click(); await button("Exit scene full screen").click();
  check("Mobile/desktop at 200% text, actual scrolling, scene resize and full screen");
  const hd = { label: "HD · 1280 × 720", width: 1280, height: 720 }, uhd = { label: "4K · 3840 × 2160", width: 3840, height: 2160 };
  await choose("Object impact"); await button("Drop object").click();
  await record("tank-impact-hd", hd, true);
  await reset(); await button("Drop object").click(); await record("tank-impact-4k", uhd);
  await choose("Arterial puncture"); await button("Open puncture 1").click(); await record("arterial-puncture-4k", uhd);
  await choose("Venous puncture"); await button("Open puncture 1").click(); await record("venous-puncture-hd", hd);
  await canvas.evaluate(element => element.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext());
  await expect(page.getByRole("alert")).toContainText("graphics context lost");
  const halted = await exported("context-loss-state.json"); validate(halted);
  expect(halted.execution.phase).toBe("halted");
  expect(halted.execution.error).toContain("graphics context lost");
  expect(halted.renderer.contextLost).toBe(true);
  await button("Reset experiment").click(); await ready();
  check("Context loss is explicit in exported evidence and reset restores the experiment");
  try {
    await page.addScriptTag({ path: process.env.AXE_SCRIPT ?? "/private/tmp/blood-axe.min.js" });
    accessibility = await page.evaluate(() => axe.run(document.querySelector(".blood-lab"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
    expect(accessibility.violations).toEqual([]);
    check("Automated accessibility audit has no violations", { incomplete: accessibility.incomplete.length });
  } catch (error) {
    if (String(error).includes("ENOENT")) accessibility = { status: "NOT RUN", reason: "axe fixture not available" };
    else throw error;
  }
  expect(errors).toEqual([]); expect(failedRequests).toEqual([]); status = "PASS";
} catch (error) {
  caught = String(error); console.error(error); await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(out, "qa.json"), JSON.stringify({ status, caught, url: url.href, checks, errors, failedRequests,
    accessibility: accessibility ? { violations: accessibility.violations, incomplete: accessibility.incomplete?.map(item => item.id), status: accessibility.status } : null,
    visualRealism: "Requires review of saved images and decoded motion; numerical PASS is not a photorealism claim." }, null, 2));
  await browser.close();
}
if (status !== "PASS") process.exitCode = 1;
