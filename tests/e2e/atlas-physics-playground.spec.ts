import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";

interface Snapshot {
  nodePositionsMm: number[];
  sourceCenterScreen: { x: number; y: number } | [number, number];
  cameraPosition: number[];
  cameraTarget: number[];
  parameters?: { young_pa: number; [key: string]: number };
  tool: string;
  paused: boolean;
  gravity: boolean;
  metrics: {
    simulation_time_s: number; minimum_jacobian: number; floor_penetration_mm: number;
    maximum_speed_m_s: number; rejected_steps: number; finite_state: boolean;
    center_of_mass_mm: number[]; [key: string]: unknown;
  };
}
interface Prepared {
  parameters: { young_pa: number; [key: string]: number };
  learning: { source: string; [key: string]: unknown };
  source: { realized_id?: string; [key: string]: unknown };
  mesh: { reference_positions_mm: number[]; tets: number[]; [key: string]: unknown };
}

async function snapshot(page: Page): Promise<Snapshot> {
  const value = await page.getByTestId("playground-diagnostics").getAttribute("data-snapshot");
  if (!value) throw new Error("Playground diagnostics are not ready");
  return JSON.parse(value) as Snapshot;
}

function displacement(a: number[], b: number[]): { maximumMm: number; pairDistanceChangeRmsMm: number } {
  expect(a.length).toBe(b.length);
  let maximumMm = 0, square = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = [b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2]];
    maximumMm = Math.max(maximumMm, Math.hypot(...d));
    for (let j = 0; j < i; j += 3) {
      const before = Math.hypot(a[i] - a[j], a[i + 1] - a[j + 1], a[i + 2] - a[j + 2]);
      const after = Math.hypot(b[i] - b[j], b[i + 1] - b[j + 1], b[i + 2] - b[j + 2]);
      square += (after - before) ** 2;
    }
  }
  const count = a.length / 3;
  return { maximumMm, pairDistanceChangeRmsMm: Math.sqrt(square / (count * (count - 1) / 2)) };
}

function independentMinimumJacobian(state: Snapshot, prepared: Prepared): number {
  const volume6 = (positions: number[], indices: number[]): number => {
    const [a, b, c, d] = indices.map(index => positions.slice(index * 3, index * 3 + 3));
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const w = d.map((value, axis) => value - a[axis]);
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  let minimum = Infinity;
  for (let offset = 0; offset < prepared.mesh.tets.length; offset += 4) {
    const indices = prepared.mesh.tets.slice(offset, offset + 4);
    minimum = Math.min(minimum, volume6(state.nodePositionsMm, indices) / volume6(prepared.mesh.reference_positions_mm, indices));
  }
  return minimum;
}

function checkFinite(state: Snapshot, prepared: Prepared): void {
  expect(state.nodePositionsMm.every(Number.isFinite)).toBe(true);
  expect(state.metrics.finite_state).toBe(true);
  expect(state.metrics.minimum_jacobian).toBeGreaterThan(0);
  expect(state.metrics.floor_penetration_mm).toBeLessThanOrEqual(0.2);
  expect(independentMinimumJacobian(state, prepared)).toBeGreaterThan(0);
}

async function open(page: Page): Promise<{ prepared: Prepared; errors: string[]; transient503: string[] }> {
  const errors: string[] = [];
  const transient503: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (message.location().url.endsWith("/api/physics/playground") && message.text().includes("503")) transient503.push(message.text());
    else errors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toBeEnabled({ timeout: 60000 });
  const ready = page.waitForResponse(response => response.url().endsWith("/api/physics/playground") && response.request().method() === "POST" && response.status() !== 503);
  await page.getByRole("button", { name: "Physics lab", exact: true }).click();
  const response = await ready;
  expect(response.status(), await response.text()).toBe(200);
  const prepared = await response.json() as Prepared;
  await expect(page.getByTestId("physics-playground-viewport").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("playground-diagnostics")).toHaveAttribute("data-snapshot", /.+/);
  await expect.poll(async () => (await snapshot(page)).nodePositionsMm.length).toBeGreaterThan(3);
  return { prepared, errors, transient503 };
}

async function gravity(page: Page, enabled: boolean): Promise<void> {
  const button = page.getByRole("button", { name: "Gravity", exact: true });
  if ((await button.getAttribute("aria-pressed") === "true") !== enabled) await button.click();
  await expect.poll(async () => (await snapshot(page)).gravity).toBe(enabled);
}

async function reset(page: Page): Promise<Snapshot> {
  await page.getByRole("button", { name: "Reset liver", exact: true }).click();
  await page.waitForTimeout(300); // Diagnostics publish at 5 Hz; physics runs independently.
  return snapshot(page);
}

async function point(page: Page): Promise<{ x: number; y: number }> {
  await page.getByTestId("physics-playground-viewport").scrollIntoViewIfNeeded();
  const state = await snapshot(page);
  const bounds = await page.getByTestId("physics-playground-viewport").boundingBox();
  if (!bounds) throw new Error("Playground viewport has no bounds");
  const p = state.sourceCenterScreen;
  return { x: bounds.x + (Array.isArray(p) ? p[0] : p.x), y: bounds.y + (Array.isArray(p) ? p[1] : p.y) };
}

function save(testInfo: TestInfo, name: string, value: unknown): void {
  writeFileSync(testInfo.outputPath(name), JSON.stringify(value, null, 2));
}

test("actual pointer tools deform the learned liver independently of the camera; room and controls remain stable", async ({ page }, testInfo) => {
  const { prepared, errors, transient503 } = await open(page);
  save(testInfo, "prepared-liver.json", prepared);
  expect(prepared.learning.source).toBe("learned");
  expect(prepared.source.realized_id).toBeTruthy();
  expect(prepared.parameters.young_pa).toBeGreaterThan(0);
  await gravity(page, false);
  const initial = await reset(page);
  if (initial.parameters) expect(initial.parameters.young_pa).toBe(prepared.parameters.young_pa);
  checkFinite(initial, prepared);
  const evidence: Record<string, unknown> = { source: prepared.source, learning: prepared.learning, parameters: prepared.parameters, initial, transient503 };
  await page.screenshot({ path: testInfo.outputPath("01-room-ready.png") });

  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).paused).toBe(true);
  const paused = await snapshot(page);
  await page.waitForTimeout(450);
  expect((await snapshot(page)).metrics.simulation_time_s).toBe(paused.metrics.simulation_time_s);
  await page.getByRole("button", { name: "Resume physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).paused).toBe(false);

  for (const [tool, dx, dy] of [["Grab", 100, -70], ["Push", 0, 70], ["Punch", 25, 20]] as const) {
    const before = await reset(page);
    await page.getByRole("button", { name: tool, exact: true }).click();
    const p = await point(page);
    await page.mouse.move(p.x, p.y);
    const samples: Snapshot[] = [];
    if (tool === "Punch") {
      // A 5 Hz diagnostic can miss a short impulse response. Use the existing
      // Pause control 40 ms after the real pointer event, then read its frozen
      // geometry. This changes observation timing, not force or the shape gate.
      const captures = [];
      for (let repetition = 0; repetition < 3; repetition++) {
        const repeatBefore = repetition === 0 ? before : await reset(page);
        const repeatPoint = await point(page);
        await page.mouse.move(repeatPoint.x, repeatPoint.y);
        await page.getByTestId("physics-playground-viewport").locator("canvas").evaluate(canvas => {
          canvas.addEventListener("pointerdown", () => {
            const startMs = performance.now();
            setTimeout(() => {
              const pause = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Pause physics");
              if (!pause) throw new Error("Pause physics control unavailable");
              pause.click();
              canvas.dataset.punchPauseDelayMs = String(performance.now() - startMs);
            }, 40);
          }, { once: true, capture: true });
        });
        await page.mouse.down();
        await expect.poll(async () => (await snapshot(page)).paused).toBe(true);
        const frozen = await snapshot(page);
        const shape = displacement(repeatBefore.nodePositionsMm, frozen.nodePositionsMm);
        const pauseDelayMs = Number(await page.getByTestId("physics-playground-viewport").locator("canvas").getAttribute("data-punch-pause-delay-ms"));
        captures.push({ repetition, pauseDelayMs, before: repeatBefore, frozen, motion: shape });
        samples.push(frozen);
        await page.mouse.up();
        await page.getByRole("button", { name: "Resume physics", exact: true }).click();
        await expect.poll(async () => (await snapshot(page)).paused).toBe(false);
        samples.push(await snapshot(page));
      }
      save(testInfo, "punch-early-captures.json", captures);
      for (const capture of captures) {
        expect(capture.motion.pairDistanceChangeRmsMm, `Punch transient ${capture.repetition + 1} changed shape`).toBeGreaterThan(0.05);
        expect(capture.pauseDelayMs, "Pause sampling delay remains an early observation").toBeLessThan(150);
      }
    } else {
      await page.mouse.down();
      await page.waitForTimeout(100);
      samples.push(await snapshot(page));
      for (let step = 1; step <= 4; step++) {
        await page.mouse.move(p.x + dx * step / 4, p.y + dy * step / 4, { steps: 6 });
        await page.waitForTimeout(80);
        samples.push(await snapshot(page));
      }
      await page.waitForTimeout(150); samples.push(await snapshot(page));
      await page.mouse.up();
    }
    const measured = samples.map(state => ({ state, motion: displacement(before.nodePositionsMm, state.nodePositionsMm) }));
    const peak = measured.reduce((best, next) => next.motion.pairDistanceChangeRmsMm > best.motion.pairDistanceChangeRmsMm ? next : best);
    const during = peak.state, motion = { ...peak.motion, maximumMm: Math.max(...measured.map(value => value.motion.maximumMm)) };
    save(testInfo, `${tool.toLowerCase()}-metrics.json`, { before, during, motion, samples, samplingProtocol: tool === "Punch" ? "Existing Pause control triggered 40 ms after pointerdown; next diagnostic observes frozen transient" : "5 Hz diagnostics during sustained gesture" });
    expect(motion.maximumMm, `${tool} moved the simulated mesh`).toBeGreaterThan(0.5);
    expect(motion.pairDistanceChangeRmsMm, `${tool} changed shape, excluding rigid translation and rotation`).toBeGreaterThan(0.05);
    expect(during.cameraPosition).toEqual(before.cameraPosition);
    expect(during.cameraTarget).toEqual(before.cameraTarget);
    checkFinite(during, prepared);
    evidence[tool.toLowerCase()] = { ...motion, state: during };
    await page.screenshot({ path: testInfo.outputPath(`02-${tool.toLowerCase()}.png`) });
  }

  const falling = await reset(page);
  await gravity(page, true);
  await expect.poll(async () => (await snapshot(page)).metrics.center_of_mass_mm[1], { timeout: 10000 }).toBeLessThan(falling.metrics.center_of_mass_mm[1] - 5);
  const timingStart = await snapshot(page);
  const wallStart = performance.now();
  await page.waitForTimeout(5000);
  const wallSeconds = (performance.now() - wallStart) / 1000;
  const settled = await snapshot(page);
  const timing = { wall_seconds: wallSeconds, simulated_seconds: settled.metrics.simulation_time_s - timingStart.metrics.simulation_time_s, simulation_to_wall_ratio: (settled.metrics.simulation_time_s - timingStart.metrics.simulation_time_s) / wallSeconds };
  save(testInfo, "floor-metrics.json", { falling, settled, timing });
  checkFinite(settled, prepared);
  expect(timing.simulated_seconds, "Gravity must keep advancing after floor impact").toBeGreaterThan(0.25);
  expect(settled.metrics.rejected_steps, "Ordinary floor settling must not freeze on rejected steps").toBe(0);
  evidence.gravity = { from: falling, settled, timing };
  await page.screenshot({ path: testInfo.outputPath("03-gravity-and-floor.png") });
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await page.getByRole("slider", { name: "Probe radius", exact: true }).fill("12");
  await page.getByRole("slider", { name: "Tool strength", exact: true }).fill("1.2");
  const supportedBefore = await snapshot(page), supportedPoint = await point(page);
  await page.mouse.move(supportedPoint.x, supportedPoint.y); await page.mouse.down();
  const supportedSamples: Snapshot[] = [];
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(supportedPoint.x, supportedPoint.y + step * 12, { steps: 4 });
    await page.waitForTimeout(100); supportedSamples.push(await snapshot(page));
  }
  await page.waitForTimeout(500); supportedSamples.push(await snapshot(page));
  await page.screenshot({ path: testInfo.outputPath("07-push-against-floor.png") });
  await page.mouse.up();
  const supportedPeak = supportedSamples.map(state => ({ state, motion: displacement(supportedBefore.nodePositionsMm, state.nodePositionsMm) })).reduce((best, next) => next.motion.pairDistanceChangeRmsMm > best.motion.pairDistanceChangeRmsMm ? next : best);
  save(testInfo, "supported-push-metrics.json", { before: supportedBefore, samples: supportedSamples, peak: supportedPeak });
  expect(supportedPeak.motion.pairDistanceChangeRmsMm, "Supported push must deform tissue beyond rigid motion").toBeGreaterThan(0.2);
  checkFinite(supportedPeak.state, prepared);
  expect(supportedPeak.state.cameraPosition).toEqual(supportedBefore.cameraPosition);
  evidence.supportedPush = supportedPeak;
  await page.getByRole("button", { name: "Lift & drop", exact: true }).click();
  await page.waitForTimeout(2000);
  const dropped = await snapshot(page);
  checkFinite(dropped, prepared);
  evidence.drop = dropped;

  await gravity(page, false);
  const restored = await reset(page);
  expect(displacement(initial.nodePositionsMm, restored.nodePositionsMm).maximumMm).toBeLessThan(0.01);
  await page.getByTestId("physics-playground-viewport").locator("canvas").focus();
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  const keyboardMoved = await snapshot(page);
  expect(displacement(restored.nodePositionsMm, keyboardMoved.nodePositionsMm).maximumMm).toBeGreaterThan(0.5);
  expect(keyboardMoved.cameraPosition).toEqual(restored.cameraPosition);
  await page.keyboard.press("Enter");
  evidence.keyboard = keyboardMoved;
  const beforeOrbit = await reset(page);
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  const p = await point(page);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 80, p.y + 30, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).cameraPosition).not.toEqual(beforeOrbit.cameraPosition);
  const orbited = await snapshot(page);
  expect(displacement(beforeOrbit.nodePositionsMm, orbited.nodePositionsMm).maximumMm).toBeLessThan(0.1);
  evidence.orbit = orbited;
  await page.getByRole("button", { name: "Reset room view", exact: true }).click();
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("06-tablet-room.png") });
  await page.getByRole("button", { name: "Close physics lab", exact: true }).click();
  await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toBeFocused();
  expect(errors).toEqual([]);
  save(testInfo, "interaction-metrics.json", evidence);
});

test("material changes are applied explicitly and strong repeated interactions preserve finite state", async ({ page }, testInfo) => {
  const { prepared, errors } = await open(page);
  await gravity(page, false);
  await page.getByRole("combobox", { name: "Parameter source" }).selectOption("manual");
  await page.getByRole("slider", { name: "Young’s modulus", exact: true }).fill("12000");
  const applyResponse = page.waitForResponse(response => response.url().endsWith("/api/physics/playground") && response.request().method() === "POST" && response.status() !== 503);
  await page.getByRole("button", { name: "Apply material", exact: true }).click();
  const response = await applyResponse;
  expect(response.status(), await response.text()).toBe(200);
  const changed = await response.json() as Prepared;
  expect(changed.parameters.young_pa).toBe(12000);
  expect(changed.source.realized_id).toBe(prepared.source.realized_id);
  await gravity(page, false);
  const before = await reset(page);
  if (before.parameters) expect(before.parameters.young_pa).toBe(12000);
  await page.getByRole("button", { name: "Punch", exact: true }).click();
  const strength = page.getByRole("slider", { name: "Tool strength", exact: true });
  await strength.fill((await strength.getAttribute("max")) ?? "1");
  const states: Snapshot[] = [];
  for (let index = 0; index < 6; index++) {
    await page.getByRole("button", { name: index % 2 ? "Grab" : "Punch", exact: true }).click();
    const p = await point(page);
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    await page.mouse.move(p.x + (index % 2 ? -90 : 70), p.y - 55, { steps: 16 });
    await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(200);
    const state = await snapshot(page); checkFinite(state, changed); states.push(state);
  }
  await page.screenshot({ path: testInfo.outputPath("04-strong-interactions.png") });
  save(testInfo, "strong-interaction-metrics.json", { prepared: { source: changed.source, parameters: changed.parameters, learning: changed.learning }, before, states });
  expect(errors).toEqual([]);
});

test.describe("mobile touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("touch drag changes tissue geometry and the room fits the viewport", async ({ page }, testInfo) => {
    const { prepared, errors } = await open(page);
    await gravity(page, false);
    const before = await reset(page);
    await page.getByRole("button", { name: "Grab", exact: true }).click();
    await page.getByTestId("physics-playground-viewport").scrollIntoViewIfNeeded();
    const p = await point(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x + step * 3, y: p.y - step * 2 }] });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(300);
    const moved = await snapshot(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    save(testInfo, "touch-metrics.json", { before, moved });
    expect(displacement(before.nodePositionsMm, moved.nodePositionsMm).maximumMm).toBeGreaterThan(0.5);
    expect(moved.cameraPosition).toEqual(before.cameraPosition);
    checkFinite(moved, prepared);
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("05-touch-mobile.png") });
    expect(errors).toEqual([]);
  });
});
