import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import type { PhysicsRun } from "../../apps/studio/src/atlasPhysics";

test("real liver runs learned indentation, grasp and cut with inspectable trajectories", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/"); await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Physics lab", exact: true }).click();
  await page.getByRole("button", { name: "Recorded experiments", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run experiment", exact: true })).toBeEnabled();
  const results: Record<string, unknown> = {};
  let defaultStiffness = 0;
  for (const [protocol, label] of [["indent", "Indentation"], ["grasp", "Grasp & release"], ["cut", "Cutting"]] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/physics/run") && response.request().method() === "POST", { timeout: 100000 });
    await page.getByRole("button", { name: "Run experiment", exact: true }).click();
    const response = await responsePromise; expect(response.status(), await response.text()).toBe(200);
    const result = await response.json() as PhysicsRun;
    expect(result.source.realized_id).toBeTruthy(); expect(result.learning.source).toBe("learned"); expect(result.protocol).toBe(protocol);
    expect(result.frames.length).toBeGreaterThan(10); expect(result.metrics.finite_state).toBe(true); expect(result.metrics.minimum_jacobian).toBeGreaterThan(0); expect(result.metrics.inverted_elements).toBe(0);
    expect(result.metrics.numerical_status).toBe("PASS"); expect(result.metrics.rejected_steps).toBe(0); expect(result.metrics.unconverged_steps).toBe(0);
    expect(result.metrics.peak_displacement_mm).toBeGreaterThan(0.1);
    if (protocol === "indent") {
      expect(result.metrics.loaded_contact_gap_frames).toBe(0); expect(result.metrics.maximum_contact_penetration_mm).toBeGreaterThanOrEqual(0);
      const heldForces = result.frames.filter(frame => frame.phase === "hold").map(frame => Math.hypot(...frame.tool_force_n));
      expect(heldForces.length).toBeGreaterThan(0); expect(Math.min(...heldForces)).toBeGreaterThan(0.01);
    }
    defaultStiffness = result.parameters.young_pa;
    await expect(page.getByText("Peak reaction", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Download run JSON" })).toBeEnabled();
    const first = await page.locator('[data-testid="physics-viewport"] canvas').screenshot();
    await page.getByRole("slider", { name: "Simulation time" }).fill(String(Math.floor(result.frames.length * 0.7)));
    const moved = await page.locator('[data-testid="physics-viewport"] canvas').screenshot(); expect(moved.equals(first)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`liver-${protocol}.png`) });
    await page.getByRole("button", { name: "Rewind simulation" }).click();
    await page.getByRole("button", { name: "Play simulation playback" }).click();
    await expect(page.getByRole("slider", { name: "Simulation time" })).toHaveValue(String(result.frames.length - 1), { timeout: 12000 });
    if (protocol === "cut") {
      expect(result.metrics.severed_bonds).toBeGreaterThan(0);
      await expect(page.getByText("TETRAHEDRAL CUT SURFACE", { exact: true })).toBeVisible();
    }
    results[protocol] = { metrics: result.metrics, mesh_nodes: result.mesh.reference_positions_mm.length / 3, surface_vertices: result.mesh.source_vertex_count, learning: result.learning, source: result.source };
  }
  const exampleResponse = await page.request.get("/api/physics/demo-observation"); expect(exampleResponse.ok()).toBe(true);
  const example = await exampleResponse.json();
  const calibration = { times_s: example.times_s, force_n: example.force_n.map((value: number) => value * 1.4), displacement_mm: example.displacement_mm, reference_length_mm: example.reference_length_mm, reference_area_mm2: example.reference_area_mm2, provenance: "Synthetic browser QA: built-in reference force scaled by 1.4; not tissue measurement." };
  await page.getByText("Use your calibration JSON", { exact: true }).click();
  await page.getByLabel("Calibration JSON", { exact: true }).setInputFiles({ name: "synthetic-stiffer-calibration.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(calibration)) });
  await page.getByRole("button", { name: "Indentation", exact: true }).click();
  const calibratedResponse = page.waitForResponse(response => response.url().endsWith("/api/physics/run") && response.request().method() === "POST", { timeout: 100000 });
  await page.getByRole("button", { name: "Run experiment", exact: true }).click();
  const calibrated = await calibratedResponse; expect(calibrated.status(), await calibrated.text()).toBe(200);
  const inferred = await calibrated.json() as PhysicsRun;
  expect(inferred.learning.observation_origin).toBe("user_supplied_calibration_unverified"); expect(inferred.parameters.young_pa).toBeGreaterThan(defaultStiffness * 1.3);
  await expect(page.getByText("Peak reaction", { exact: true })).toBeVisible();
  results.uploaded_synthetic_calibration = { parameters: inferred.parameters, learning: inferred.learning, metrics: inferred.metrics };
  await testInfo.attach("physics-live-results", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  writeFileSync(testInfo.outputPath("metrics-and-learning.json"), JSON.stringify(results, null, 2));
  await page.getByText("Applied parameters & evidence limits", { exact: true }).click();
  await expect(page.getByText("Fixed assumption", { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
