import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

interface Snapshot {
  nodePositionsMm: number[];
  sourceCenterScreen: { x: number; y: number };
  cameraPosition: number[];
  cameraTarget: number[];
  tool: string;
  paused: boolean;
  gravity: boolean;
  instrument: {
    kind: "grasper" | "probe"; visible: boolean; tipMm: number[]; axis: number[];
    jawClosure: number; contactRadiusMm: number; engaged: boolean; contactModel: string;
  };
  contact: {
    probe: { centerMm: number[]; targetMm: number[]; radiusMm: number } | null;
    grab: { handleMm: number[]; targetMm: number[]; attachmentMm: number[] } | null;
  };
  metrics: { finite_state: boolean; minimum_jacobian: number; rejected_steps: number; floor_penetration_mm: number; simulation_time_s: number };
}

async function snapshot(page: Page): Promise<Snapshot> {
  const value = await page.getByTestId("playground-diagnostics").getAttribute("data-snapshot");
  if (!value) throw new Error("Playground diagnostics unavailable");
  return JSON.parse(value) as Snapshot;
}

async function open(page: Page): Promise<{ errors: string[]; transient503: string[] }> {
  const errors: string[] = [], transient503: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (message.location().url.endsWith("/api/physics/playground") && message.text().includes("503")) transient503.push(message.text());
    else errors.push(message.text());
  });
  await page.goto("/");
  const launch = page.getByRole("button", { name: "Physics lab", exact: true });
  await expect(launch).toBeEnabled({ timeout: 60000 });
  const ready = page.waitForResponse(response => response.url().endsWith("/api/physics/playground") && response.request().method() === "POST" && response.status() !== 503);
  await launch.click();
  const response = await ready;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByTestId("physics-playground-viewport").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("playground-diagnostics")).toHaveAttribute("data-snapshot", /.+/);
  await expect.poll(async () => (await snapshot(page)).instrument?.visible).toBe(true);
  return { errors, transient503 };
}

async function point(page: Page): Promise<{ x: number; y: number }> {
  const viewport = page.getByTestId("physics-playground-viewport");
  await viewport.scrollIntoViewIfNeeded();
  const state = await snapshot(page), box = await viewport.boundingBox();
  if (!box) throw new Error("Missing viewport bounds");
  return { x: box.x + state.sourceCenterScreen.x, y: box.y + state.sourceCenterScreen.y };
}

async function reset(page: Page, gravity = false): Promise<Snapshot> {
  const toggle = page.getByRole("button", { name: "Gravity", exact: true });
  if ((await toggle.getAttribute("aria-pressed") === "true") !== gravity) await toggle.click();
  await page.getByRole("button", { name: "Reset liver", exact: true }).click();
  await page.waitForTimeout(300);
  return snapshot(page);
}

function distance(a: number[], b: number[]): number { return Math.hypot(...a.map((value, axis) => value - b[axis])); }
function shapeChange(a: number[], b: number[]): number {
  let square = 0, count = 0;
  for (let i = 0; i < a.length; i += 3) for (let j = 0; j < i; j += 3) {
    square += (distance(a.slice(i, i + 3), a.slice(j, j + 3)) - distance(b.slice(i, i + 3), b.slice(j, j + 3))) ** 2; count++;
  }
  return Math.sqrt(square / count);
}
function check(state: Snapshot): void {
  expect(state.metrics.finite_state).toBe(true);
  expect(state.nodePositionsMm.every(Number.isFinite)).toBe(true);
  expect(state.metrics.minimum_jacobian).toBeGreaterThan(0);
  expect(state.metrics.floor_penetration_mm).toBeLessThanOrEqual(0.2);
  expect(state.instrument.tipMm.every(Number.isFinite)).toBe(true);
  expect(Math.hypot(...state.instrument.axis)).toBeCloseTo(1, 6);
}
function checkProbe(state: Snapshot): number {
  check(state);
  expect(state.instrument.kind).toBe("probe");
  expect(state.instrument.visible).toBe(true);
  expect(state.instrument.engaged).toBe(true);
  expect(state.instrument.contactModel).toBe("sphere");
  expect(state.contact.probe).not.toBeNull();
  const contact = state.contact.probe!;
  expect(state.instrument.contactRadiusMm).toBe(contact.radiusMm);
  const visualCenter = state.instrument.tipMm.map((v, axis) => v + state.instrument.axis[axis] * state.instrument.contactRadiusMm);
  const error = distance(visualCenter, contact.centerMm);
  expect(error, "Visible sphere must follow actual contact, including bounded tool movement").toBeLessThan(1e-5);
  return error;
}
function save(info: TestInfo, name: string, value: unknown): void { writeFileSync(info.outputPath(name), JSON.stringify(value, null, 2)); }

test("visible articulated grasper and probe follow actual contacts and release on pause or tool switch", async ({ page }, info) => {
  const { errors, transient503 } = await open(page);
  const evidence: Record<string, unknown> = { transient503 };
  const idle = await reset(page);
  await page.getByRole("button", { name: "Record motion", exact: true }).click();
  expect(idle.instrument.kind).toBe("grasper");
  expect(idle.instrument.visible).toBe(true);
  expect(idle.instrument.engaged).toBe(false);
  expect(idle.instrument.jawClosure).toBeLessThan(0.1);
  await page.screenshot({ path: info.outputPath("01-idle-grasper.png") });
  const p = await point(page);
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(250);
  evidence.hover = await snapshot(page);
  await page.mouse.down();
  await page.mouse.move(p.x + 65, p.y - 70, { steps: 24 });
  await expect.poll(async () => (await snapshot(page)).instrument.jawClosure).toBeGreaterThan(0.9);
  await page.waitForTimeout(350);
  const grasped = await snapshot(page);
  check(grasped);
  expect(grasped.instrument.engaged).toBe(true);
  expect(grasped.instrument.contactModel).toBe("compliant_patch");
  expect(grasped.contact.grab).not.toBeNull();
  expect(distance(grasped.instrument.tipMm, grasped.contact.grab!.handleMm)).toBeLessThan(1e-5);
  expect(shapeChange(idle.nodePositionsMm, grasped.nodePositionsMm)).toBeGreaterThan(0.2);
  expect(grasped.cameraPosition).toEqual(idle.cameraPosition);
  await page.screenshot({ path: info.outputPath("02-grasper-lifting.png") });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(false);
  await expect.poll(async () => (await snapshot(page)).instrument.jawClosure).toBeLessThan(0.1);
  const released = await snapshot(page);
  expect(released.contact.grab).toBeNull();
  await page.screenshot({ path: info.outputPath("03-grasper-released.png") });
  evidence.grasp = { before: idle, grasped, released, pairDistanceChangeRmsMm: shapeChange(idle.nodePositionsMm, grasped.nodePositionsMm) };

  // Activate a grab through the keyboard so Pause can be clicked without an earlier pointer-up releasing it.
  await reset(page);
  await page.getByTestId("physics-playground-viewport").locator("canvas").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(true);
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).paused).toBe(true);
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(false);
  await expect.poll(async () => (await snapshot(page)).instrument.jawClosure).toBeLessThan(0.1);
  const paused = await snapshot(page);
  expect(paused.contact.grab).toBeNull();
  await page.waitForTimeout(300);
  expect((await snapshot(page)).metrics.simulation_time_s).toBe(paused.metrics.simulation_time_s);
  evidence.paused = paused;
  await page.getByRole("button", { name: "Resume physics", exact: true }).click();
  await page.getByTestId("physics-playground-viewport").locator("canvas").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(true);
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).instrument.kind).toBe("probe");
  const switched = await snapshot(page);
  expect(switched.contact.grab).toBeNull();
  expect(switched.instrument.engaged).toBe(false);
  expect(await page.getByRole("slider", { name: "Probe radius", exact: true }).inputValue()).toBe("6");
  evidence.switched = switched;

  await reset(page, true); await page.waitForTimeout(5000);
  await page.getByRole("slider", { name: "Probe radius", exact: true }).fill("12");
  await page.getByRole("slider", { name: "Tool strength", exact: true }).fill("1.2");
  const supported = await snapshot(page), q = await point(page);
  await page.mouse.move(q.x, q.y); await page.mouse.down();
  const samples: Snapshot[] = [];
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(q.x, q.y + step * 9, { steps: 4 }); await page.waitForTimeout(100);
    const state = await snapshot(page); checkProbe(state); samples.push(state);
  }
  await page.waitForTimeout(500); samples.push(await snapshot(page));
  const alignmentErrorsMm = samples.map(checkProbe);
  const deformation = Math.max(...samples.map(state => shapeChange(supported.nodePositionsMm, state.nodePositionsMm)));
  expect(deformation, "The small physical probe deforms a floor-supported liver").toBeGreaterThan(0.2);
  expect(samples.at(-1)!.cameraPosition).toEqual(supported.cameraPosition);
  await page.screenshot({ path: info.outputPath("04-probe-pressing.png") });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).contact.probe).toBeNull();
  expect((await snapshot(page)).instrument.engaged).toBe(false);
  evidence.push = { before: supported, samples, alignmentErrorsMm, pairDistanceChangeRmsMm: deformation, released: await snapshot(page) };
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).instrument.visible).toBe(false);
  expect((await snapshot(page)).contact.probe).toBeNull();
  await page.getByRole("button", { name: "Grab", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).instrument.visible).toBe(true);
  expect((await snapshot(page)).instrument.jawClosure).toBeLessThan(0.1);
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download motion JSON", exact: true }).click();
  const download = await downloadReady;
  const capture = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(capture.schema).toBe("viscera.liver-motion-capture/1");
  expect(capture.samples.some((sample: { contact: { probe: unknown }; metrics: { probe_normal_force_n: number } }) => sample.contact.probe && sample.metrics.probe_normal_force_n > 0)).toBe(true);
  writeFileSync(info.outputPath("tool-motion-capture.json"), JSON.stringify(capture, null, 2));
  expect(errors).toEqual([]);
  save(info, "instrument-metrics.json", evidence);
});

test.describe("touch instruments", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("mobile touch shows a closed gripping instrument and an open released instrument", async ({ page }, info) => {
    const { errors, transient503 } = await open(page);
    const before = await reset(page), p = await point(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x + step * 2, y: p.y - step * 3 }] });
      await page.waitForTimeout(25);
    }
    await expect.poll(async () => (await snapshot(page)).instrument.jawClosure).toBeGreaterThan(0.9);
    const grasped = await snapshot(page); check(grasped);
    expect(grasped.instrument.visible).toBe(true);
    expect(grasped.instrument.engaged).toBe(true);
    expect(shapeChange(before.nodePositionsMm, grasped.nodePositionsMm)).toBeGreaterThan(0.1);
    expect(grasped.cameraPosition).toEqual(before.cameraPosition);
    expect(distance(grasped.instrument.tipMm, grasped.contact.grab!.handleMm)).toBeLessThan(1e-5);
    await page.screenshot({ path: info.outputPath("05-mobile-grasper.png") });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(false);
    await expect.poll(async () => (await snapshot(page)).instrument.jawClosure).toBeLessThan(0.1);
    expect((await snapshot(page)).contact.grab).toBeNull();
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
    save(info, "touch-instrument-metrics.json", { before, grasped, released: await snapshot(page), transient503 });
  });
});

test("punch shows probe recoil and the keyboard grab remains visible in Orbit mode", async ({ page }, info) => {
  const { errors } = await open(page);
  await reset(page);
  await page.getByRole("button", { name: "Punch", exact: true }).click();
  const p = await point(page);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).instrument.contactModel, { intervals: [25, 25, 50] }).toBe("impulse");
  const struck = await snapshot(page);
  expect(struck.instrument.kind).toBe("probe");
  expect(struck.instrument.visible).toBe(true);
  expect(struck.instrument.engaged).toBe(true);
  expect(struck.contact.probe).toBeNull();
  expect(struck.contact.grab).toBeNull();
  await page.screenshot({ path: info.outputPath("06-punch-probe.png") });
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(false);
  const recoiled = await snapshot(page);
  await reset(page);
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).instrument.visible).toBe(false);
  await page.getByTestId("physics-playground-viewport").locator("canvas").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(true);
  const keyboard = await snapshot(page);
  expect(keyboard.instrument.visible).toBe(true);
  expect(keyboard.instrument.kind).toBe("grasper");
  expect(keyboard.contact.grab).not.toBeNull();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await snapshot(page)).instrument.engaged).toBe(false);
  await expect.poll(async () => (await snapshot(page)).instrument.visible).toBe(false);
  expect((await snapshot(page)).contact.grab).toBeNull();
  expect(errors).toEqual([]);
  save(info, "transient-instrument-metrics.json", { struck, recoiled, keyboard, released: await snapshot(page) });
});
