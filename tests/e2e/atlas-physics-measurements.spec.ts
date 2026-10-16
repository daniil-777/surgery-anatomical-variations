import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";

async function snapshot(page: Page) {
  return JSON.parse((await page.getByTestId("playground-diagnostics").getAttribute("data-snapshot"))!);
}
function assertFramed(s: Awaited<ReturnType<typeof snapshot>>) {
  const camera = new THREE.PerspectiveCamera(s.cameraFovDegrees, s.cameraAspect, 1, 8000);
  camera.position.fromArray(s.cameraPosition); camera.lookAt(new THREE.Vector3().fromArray(s.cameraTarget)); camera.updateMatrixWorld();
  for (const x of [s.bodyBoundsMm.min[0], s.bodyBoundsMm.max[0]]) for (const y of [s.bodyBoundsMm.min[1], s.bodyBoundsMm.max[1]]) for (const z of [s.bodyBoundsMm.min[2], s.bodyBoundsMm.max[2]]) {
    const p = new THREE.Vector3(x, y, z).project(camera);
    expect(Math.abs(p.x)).toBeLessThan(.96); expect(Math.abs(p.y)).toBeLessThan(.96); expect(p.z).toBeLessThan(1); expect(p.z).toBeGreaterThan(-1);
  }
}

test("explicit framing preserves tissue and motion exports retain source, real timestamps and reset segments", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/");
  const lab = page.getByRole("button", { name: "Physics lab", exact: true }); await expect(lab).toBeEnabled({ timeout: 60000 });
  const ready = page.waitForResponse(r => r.url().endsWith("/api/physics/playground") && r.request().method() === "POST" && r.status() !== 503);
  await lab.click(); const response = await ready; expect(response.status(), await response.text()).toBe(200); const prepared = await response.json();
  await expect(page.getByTestId("playground-diagnostics")).toHaveAttribute("data-snapshot", /.+/);
  await page.getByRole("button", { name: "Gravity", exact: true }).click();
  await page.getByRole("button", { name: "Reset liver", exact: true }).click();
  await page.getByRole("button", { name: "Record motion", exact: true }).click();
  const canvas = page.getByTestId("physics-playground-viewport").locator("canvas"); await canvas.scrollIntoViewIfNeeded(); await canvas.focus();
  const pointerStart = await snapshot(page), rect = (await canvas.boundingBox())!;
  const cursor = { x: rect.x + pointerStart.sourceCenterScreen.x, y: rect.y + pointerStart.sourceCenterScreen.y };
  await page.mouse.move(cursor.x, cursor.y); await page.mouse.down();
  await expect.poll(async () => Boolean((await snapshot(page)).contact.grab)).toBe(true);
  const pointerHeld = await snapshot(page); await canvas.press("f");
  await page.mouse.move(cursor.x, cursor.y); await page.waitForTimeout(250);
  const pointerFramed = await snapshot(page); expect(pointerFramed.contact.grab).toBeTruthy();
  for (let axis = 0; axis < 3; axis++) expect(pointerFramed.contact.grab.targetMm[axis]).toBeCloseTo(pointerHeld.contact.grab.targetMm[axis], 5);
  await page.mouse.up();
  const beforeMove = await snapshot(page); await canvas.press("p");
  for (let i = 0; i < 40; i++) await canvas.press("ArrowUp");
  await page.waitForTimeout(650);
  const heldBeforeFit = await snapshot(page); expect(heldBeforeFit.contact.grab).toBeTruthy();
  await canvas.press("f"); await page.waitForTimeout(250);
  const heldAfterFit = await snapshot(page);
  expect(heldAfterFit.contact.grab).toBeTruthy();
  expect(heldAfterFit.contact.grab.targetMm).toEqual(heldBeforeFit.contact.grab.targetMm);
  expect(heldAfterFit.metrics.probe_removal_count).toBe(heldBeforeFit.metrics.probe_removal_count);
  await canvas.press("Enter");
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).paused).toBe(true);
  await page.getByRole("button", { name: "Reset room view", exact: true }).click();
  await page.waitForTimeout(250);
  const beforeFit = await snapshot(page);
  expect(Math.hypot(...beforeFit.metrics.center_of_mass_mm.map((v: number, i: number) => v - beforeMove.metrics.center_of_mass_mm[i]))).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Fit liver", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).bodyBoundsInFrame).toBe(true);
  const afterFit = await snapshot(page);
  expect(afterFit.nodePositionsMm).toEqual(beforeFit.nodePositionsMm); expect(afterFit.metrics.simulation_time_s).toBe(beforeFit.metrics.simulation_time_s);
  expect(afterFit.cameraTarget).not.toEqual(beforeFit.cameraTarget); assertFramed(afterFit);
  await page.screenshot({ path: info.outputPath("01-fit-current-liver.png"), fullPage: true });
  await page.getByRole("button", { name: "Reset liver", exact: true }).click(); await page.waitForTimeout(160);
  await page.getByRole("button", { name: "Pause physics", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).paused).toBe(true);
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  const downloadReady = page.waitForEvent("download"); await page.getByRole("button", { name: "Download motion JSON", exact: true }).click(); const download = await downloadReady;
  const capture = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(capture.schema).toBe("viscera.liver-motion-capture/1"); expect(capture.source).toEqual(prepared.source); expect(capture.parameters).toEqual(prepared.parameters);
  expect(capture.cage.reference_positions_mm).toEqual(prepared.mesh.reference_positions_mm.map((v: number) => v === 0 ? 0 : v)); expect(capture.cage.tets).toEqual(prepared.mesh.tets);
  expect(capture.samples.length).toBeGreaterThan(10); expect(capture.samples.length).toBeLessThanOrEqual(capture.sampling.maximum_samples);
  expect(new Set(capture.samples.map((s: { segment: number }) => s.segment)).size).toBeGreaterThan(1);
  expect(capture.events.some((e: { action: string }) => e.action === "reset_liver")).toBe(true);
  expect(capture.events.some((e: { action: string }) => e.action === "fit_liver_view")).toBe(true);
  const punch = capture.events.find((e: { action: string }) => e.action === "punch");
  expect(punch).toBeTruthy(); expect(Math.hypot(...punch.details.impulse_on_body_n_s)).toBeGreaterThan(0); expect(punch.details.kinetic_energy_change_j).toBeGreaterThan(0);
  for (let i = 0; i < capture.samples.length; i++) {
    const s = capture.samples[i]; expect(s.node_positions_mm).toHaveLength(prepared.mesh.reference_positions_mm.length); expect(s.node_positions_mm.every(Number.isFinite)).toBe(true); expect(s.metrics.minimum_jacobian).toBeGreaterThan(0);
    if (i) { const previous = capture.samples[i - 1]; expect(s.wall_time_s - previous.wall_time_s).toBeGreaterThanOrEqual(1 / 30 - 1e-6); if (s.segment === previous.segment) expect(s.metrics.simulation_time_s).toBeGreaterThanOrEqual(previous.metrics.simulation_time_s); }
  }
  writeFileSync(info.outputPath("motion-capture.json"), JSON.stringify(capture, null, 2));
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "Fit liver", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).cameraAspect).toBeLessThan(1.2);
  await canvas.focus(); await canvas.press("f"); await page.waitForTimeout(250); const mobile = await snapshot(page); assertFramed(mobile);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("02-mobile-framing-capture.png"), fullPage: true });
  writeFileSync(info.outputPath("framing-measurements.json"), JSON.stringify({ prepared: { source: prepared.source, parameters: prepared.parameters }, beforeMove, beforeFit, afterFit, mobile, captureCount: capture.samples.length }, null, 2));
  expect(errors).toEqual([]);
});
