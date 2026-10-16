import { expect, test, type Page, type Route } from "@playwright/test";
import type { AtlasSpec } from "../../apps/studio/src/atlas";
import type { PhysicsObservation, PhysicsParameters, PhysicsProtocol, PhysicsSource } from "../../apps/studio/src/atlasPhysics";

const defaults: PhysicsParameters = { young_pa: 4800, poisson: 0.45, relaxation_fraction: 0.42, relaxation_time_s: 0.65, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const positions = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
const indices = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2];
interface Request { spec: AtlasSpec; protocol: PhysicsProtocol; amplitude_mm: number; parameter_source: PhysicsSource; parameters?: PhysicsParameters; observation?: PhysicsObservation }
function observation(): PhysicsObservation {
  const times_s = Array.from({ length: 81 }, (_, index) => index * 0.075);
  return { times_s, force_n: times_s.map(time => time === 0 ? 0 : 0.01), displacement_mm: times_s.map(time => 0.5 * Math.min(Math.max(0, Math.min(1, time / 0.6)), Math.max(0, Math.min(1, (4.2 - time) / 0.6)))), reference_length_mm: 20, reference_area_mm2: 100, provenance: "Synthetic browser-test observation; not a tissue measurement" };
}
function result(request: Request) {
  return { schema_version: "liver-physics-experiment-1.0.0", protocol: request.protocol, source: { template_id: request.spec.template_id, realized_id: request.spec.realized_id }, parameters: request.parameters ?? defaults,
    learning: { source: request.parameter_source, model_id: "synthetic-physics-fixture", scope: "Synthetic calibration fixture; not human-validated." },
    mesh: { reference_positions_mm: positions, tets: [0, 1, 2, 3], surface_indices: indices, source_vertex_count: 4, source_face_count: 4, embedding: { tet_indices: [0, 0, 0, 0], weights: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } },
    tool: { kind: request.protocol === "cut" ? "blade" : request.protocol === "grasp" ? "grasper" : "sphere", radius_mm: 8 },
    frames: Array.from({ length: 41 }, (_, index) => { const amount = Math.sin(index / 40 * Math.PI); return { time_s: index / 10, positions_mm: positions.map((value, axis) => value - (axis === 1 ? amount * request.amplitude_mm : 0)), tool_position_mm: [0, 78 - amount * request.amplitude_mm, 0], tool_force_n: [0, amount * 0.2, 0], phase: index < 10 ? "load" : index < 30 ? "hold" : "release", severed_bonds: request.protocol === "cut" && index > 20 ? 2 : 0, ...(request.protocol === "cut" ? { active_surface_indices: indices } : {}) }; }),
    metrics: { minimum_jacobian: 0.982, maximum_volume_error_pct: 0.48, inverted_elements: 0, peak_tool_force_n: 0.2, peak_displacement_mm: request.amplitude_mm, residual_displacement_mm: 0.03, rejected_steps: 0, mean_step_ms: 2.4, p95_step_ms: 3.8, severed_bonds: request.protocol === "cut" ? 2 : 0, fracture_dissipation_j: request.protocol === "cut" ? 0.001 : 0, maximum_contact_penetration_mm: 0.35, maximum_mean_contact_penetration_mm: 0.1, loaded_contact_gap_frames: 0, finite_state: true }, limitations: ["Synthetic evidence only. No surgical video calibration."] };
}
function playgroundResult(request: Request) {
  const fixture = result(request);
  return { schema_version: "liver-physics-playground-1.0.0", source: fixture.source, parameters: fixture.parameters, learning: fixture.learning,
    mesh: { ...fixture.mesh, tets: [0, 2, 1, 3], embedding: { tet_indices: [0, 0, 0, 0], weights: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1] } }, room: { floor_y_mm: 0, gravity_m_s2: 9.81 }, limitations: fixture.limitations };
}
function generation(spec: AtlasSpec, realizedId = "displayed-geometry") {
  return { spec: { ...spec, realized_id: realizedId }, summary: {}, scene: { organs: [{ id: "organ", name: "liver reference", kind: "organ", color: "#913831", positions, indices }], metadata: { geometry_sha256: "test-geometry" } } };
}
async function setup(page: Page) {
  const requests: Request[] = []; const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: { organs: ["liver", "kidney"].map(id => ({ id, label: id, templates: [{ id: `${id}-reference`, label: `${id} reference`, source: "Test atlas", license: "CC BY 4.0" }] })), controls: [{ key: "bend", label: "Bend", min: -1, max: 1, default: 0 }] } }));
  await page.route("**/api/atlas/models", route => route.fulfill({ json: { source: "defaults", lanes: {} } }));
  await page.route("**/api/atlas/generate", route => route.fulfill({ json: generation(route.request().postDataJSON()) }));
  await page.route("**/api/physics/status", route => route.fulfill({ json: { status: "ready", defaults, model_id: "synthetic-physics-fixture", scope: "Synthetic calibration fixture; not human-validated." } }));
  await page.route("**/api/physics/demo-observation", route => route.fulfill({ json: observation() }));
  await page.route("**/api/physics/playground", route => route.fulfill({ json: playgroundResult(route.request().postDataJSON() as Request) }));
  await page.route("**/api/physics/run", route => { const request = route.request().postDataJSON() as Request; requests.push(request); return route.fulfill({ json: result(request) }); });
  await page.goto("/"); await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  return { requests, errors };
}
async function open(page: Page) { await page.getByRole("button", { name: "Physics lab", exact: true }).click(); await expect(page.getByRole("dialog", { name: "Liver physics lab" })).toBeVisible(); await page.getByRole("button", { name: "Recorded experiments", exact: true }).click(); await expect(page.getByRole("button", { name: "Run experiment", exact: true })).toBeEnabled(); }
async function run(page: Page) { await page.getByRole("button", { name: "Run experiment", exact: true }).click(); await expect(page.getByText("Finite · no inverted elements", { exact: true })).toBeVisible(); }

test("physical interaction entry stays visible and waits for the displayed generation before opening", async ({ page }) => {
  const { errors } = await setup(page);
  const lab = page.getByRole("button", { name: "Physics lab", exact: true });
  await expect(page.getByText("Physical interaction", { exact: true })).toBeVisible();
  await expect(lab).toHaveCount(1); await expect(lab).toBeVisible(); await expect(lab).toBeEnabled();
  await expect(lab).toHaveAccessibleDescription("Grasp, press and release the displayed liver.");
  let pending: Route | undefined; const preparations: Request[] = [];
  await page.route("**/api/atlas/generate", route => { pending = route; });
  await page.route("**/api/physics/playground", route => {
    const request = route.request().postDataJSON() as Request; preparations.push(request);
    return route.fulfill({ json: playgroundResult(request) });
  });
  await page.getByRole("slider", { name: "Bend", exact: true }).fill("0.4");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(lab).toBeVisible(); await expect(lab).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "Liver physics lab" })).toHaveCount(0);
  await pending!.fulfill({ json: generation(pending!.request().postDataJSON(), "updated-displayed-geometry") });
  await expect(lab).toBeEnabled(); await lab.click();
  await expect(page.getByRole("dialog", { name: "Liver physics lab" })).toBeVisible();
  await expect.poll(() => preparations.length).toBe(1);
  expect(preparations[0]).toMatchObject({ spec: { template_id: "liver-reference", realized_id: "updated-displayed-geometry", controls: { bend: 0.4 } } });
  expect(errors).toEqual([]);
});

test("hands-on opens automatically, retries a busy service, and applies manual material only on request", async ({ page }) => {
  const { errors } = await setup(page); const preparations: Request[] = [];
  await page.route("**/api/physics/playground", route => {
    const request = route.request().postDataJSON() as Request; preparations.push(request);
    return preparations.length === 1 ? route.fulfill({ status: 503, headers: { "Retry-After": "0.5" }, json: { detail: "Physics preparation busy" } }) : route.fulfill({ json: playgroundResult(request) });
  });
  await page.getByRole("button", { name: "Physics lab", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hands-on", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Physics service is busy", { exact: true })).toBeVisible();
  const appliedYoung = async () => JSON.parse(await page.getByTestId("playground-diagnostics").getAttribute("data-snapshot") ?? "{}").parameters?.young_pa;
  await expect.poll(appliedYoung).toBe(4800); expect(preparations).toHaveLength(2);
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await page.getByRole("combobox", { name: "Parameter source" }).selectOption("manual");
  await page.getByRole("slider", { name: "Young’s modulus" }).fill("9000");
  await expect(page.getByText(/Material edits are pending/)).toBeVisible();
  expect(await appliedYoung()).toBe(4800); expect(preparations).toHaveLength(2);
  await page.getByRole("button", { name: "Apply material", exact: true }).click();
  await expect.poll(appliedYoung).toBe(9000); expect(preparations).toHaveLength(3);
  expect(preparations[2]).toMatchObject({ parameter_source: "manual", parameters: { young_pa: 9000 }, spec: { realized_id: "displayed-geometry" } });
  await expect(page.getByText(/Material edits are pending/)).toHaveCount(0); expect(errors).toEqual([]);
});

test("closing hands-on ignores late preparation and reopening creates a fresh scene", async ({ page }) => {
  const { errors } = await setup(page); let pending: Route | undefined; let preparations = 0;
  await page.route("**/api/physics/playground", route => {
    preparations++;
    if (preparations === 1) { pending = route; return; }
    return route.fulfill({ json: playgroundResult(route.request().postDataJSON() as Request) });
  });
  await page.getByRole("button", { name: "Physics lab", exact: true }).click(); await expect.poll(() => preparations).toBe(1);
  await page.getByRole("button", { name: "Close physics lab", exact: true }).click();
  if (pending) await pending.fulfill({ json: playgroundResult(pending.request().postDataJSON() as Request) }).catch(() => {});
  await expect(page.getByRole("dialog", { name: "Liver physics lab" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Physics lab", exact: true }).click();
  await expect(page.getByTestId("physics-playground-viewport").locator("canvas")).toBeVisible();
  await expect.poll(() => preparations).toBe(2); expect(errors).toEqual([]);
});

test("learned lab applies to displayed geometry, shows metrics and exports reproducible trajectory", async ({ page }, testInfo) => {
  const { requests, errors } = await setup(page); await open(page);
  await expect(page.getByText("SYNTHETIC PROTOTYPE", { exact: true })).toBeVisible();
  await run(page); expect(requests[0]).toMatchObject({ spec: { template_id: "liver-reference", realized_id: "displayed-geometry" }, parameter_source: "learned", protocol: "indent", amplitude_mm: 6 });
  await page.getByRole("slider", { name: "Simulation time", exact: true }).fill("20");
  await expect(page.getByRole("slider", { name: "Simulation time", exact: true })).toHaveAttribute("aria-valuetext", "2.00 seconds, hold");
  await expect(page.getByRole("img", { name: /Tool reaction force over/ })).toBeVisible();
  await expect(page.getByText(/Max probe penetration 0.350 mm/)).toBeVisible();
  await expect(page.locator('[data-testid="physics-viewport"] canvas')).toBeVisible();
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "Download run JSON" }).click(); const download = await downloaded;
  expect(download.suggestedFilename()).toBe("viscera-liver-indent-physics.json");
  const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const saved = JSON.parse(Buffer.concat(chunks).toString()); expect(saved.displayed_spec.realized_id).toBe("displayed-geometry"); expect(saved.frames).toHaveLength(41);
  await page.screenshot({ path: testInfo.outputPath("physics-desktop.png") });
  await page.getByRole("button", { name: "Close physics lab" }).click(); await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toBeFocused(); expect(errors).toEqual([]);
});

test("protocol and parameter edits clear stale results and manual cutting uses coarse surface", async ({ page }) => {
  const { requests, errors } = await setup(page); await open(page); await run(page);
  await page.getByRole("button", { name: "Cutting", exact: true }).click(); await expect(page.getByRole("button", { name: "Download run JSON" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Parameter source" }).selectOption("manual");
  await page.getByRole("slider", { name: "Young’s modulus" }).fill("9000"); await page.getByRole("slider", { name: "Retraction travel" }).fill("8"); await run(page);
  expect(requests.at(-1)).toMatchObject({ protocol: "cut", parameter_source: "manual", amplitude_mm: 8, parameters: { young_pa: 9000 } });
  await expect(page.getByText("TETRAHEDRAL CUT SURFACE", { exact: true })).toBeVisible(); await expect(page.getByText(/2 severed bonds/)).toBeVisible();
  await page.getByRole("button", { name: "Rewind simulation" }).click(); await expect(page.getByRole("slider", { name: "Simulation time" })).toHaveValue("0"); expect(errors).toEqual([]);
});

test("canceling and changing protocol reject a late result; Escape restores focus", async ({ page }) => {
  await setup(page); await open(page);
  let pending: Route | undefined;
  await page.route("**/api/physics/run", route => { pending = route; });
  await page.getByRole("button", { name: "Run experiment", exact: true }).click(); await expect(page.getByRole("button", { name: "Stop waiting" })).toBeVisible();
  await page.getByRole("button", { name: "Grasp & release" }).click();
  await expect(page.getByRole("button", { name: "Run experiment", exact: true })).toBeEnabled();
  await expect(page.getByText(/The server finishes its current solve/)).toBeVisible();
  if (pending) await pending.fulfill({ json: result(pending.request().postDataJSON()) }).catch(() => {});
  await expect(page.getByRole("button", { name: "Download run JSON" })).toBeDisabled(); await expect(page.getByText("Peak reaction", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Liver physics lab" })).toHaveCount(0); await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toBeFocused();
});

test("calibration import is explicit, validates protocol and units, transmits only verified schema and clears to demo", async ({ page }) => {
  const { requests, errors } = await setup(page); await open(page);
  await page.getByText("Use your calibration JSON", { exact: true }).click();
  const supplied = observation();
  await page.getByLabel("Calibration JSON", { exact: true }).setInputFiles({ name: "my-calibration.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...supplied, extra: "not transmitted" })) });
  await expect(page.getByText("Loaded · unverified: my-calibration.json", { exact: true })).toBeVisible(); await run(page);
  expect(requests.at(-1)?.observation).toEqual(supplied);
  await page.getByRole("button", { name: "Use synthetic demo", exact: true }).click(); await expect(page.getByRole("button", { name: "Download run JSON" })).toBeDisabled();
  await run(page); expect(requests.at(-1)?.observation).toBeUndefined();
  const invalid = observation(); invalid.displacement_mm[8] = 99;
  await page.getByLabel("Calibration JSON", { exact: true }).setInputFiles({ name: "unsupported.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(invalid)) });
  await expect(page.getByRole("alert").filter({ hasText: "Unsupported loading" })).toBeVisible(); await expect(page.getByRole("button", { name: "Run experiment", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Use synthetic demo", exact: true }).click(); await expect(page.getByRole("button", { name: "Run experiment", exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "Download example", exact: true }).click(); expect((await downloaded).suggestedFilename()).toBe("viscera-synthetic-calibration-example.json");
  expect(errors).toEqual([]);
});

test("rejects a result for the wrong realized liver and gates other organs", async ({ page }) => {
  await setup(page); await open(page);
  await page.route("**/api/physics/run", route => { const value = result(route.request().postDataJSON()); value.source.realized_id = "another-liver"; return route.fulfill({ json: value }); });
  await page.getByRole("button", { name: "Run experiment", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "provenance" })).toBeVisible(); await expect(page.getByRole("button", { name: "Download run JSON" })).toBeDisabled();
  await page.getByRole("button", { name: "Close physics lab" }).click(); await page.locator(".atlas-organ-button").filter({ hasText: "kidney" }).click(); await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Physics lab", exact: true })).toHaveAccessibleDescription("Hands-on physics currently supports liver only.");
});

test("unconverged solves remain inspectable but never receive a green numerical status", async ({ page }) => {
  await setup(page); await open(page);
  await page.route("**/api/physics/run", route => { const value = result(route.request().postDataJSON()); return route.fulfill({ json: { ...value, metrics: { ...value.metrics, unconverged_steps: 8, numerical_status: "NEEDS_REFINEMENT" } } }); });
  await page.getByRole("button", { name: "Run experiment", exact: true }).click();
  await expect(page.locator(".physics-unstable")).toHaveText("Numerical refinement needed");
  await expect(page.getByText("8 unconverged steps", { exact: true })).toBeVisible();
  await expect(page.getByText("Finite · no inverted elements", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download run JSON" })).toBeEnabled();
});

test("mobile lab fits viewport and reduced motion requires explicit playback", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  const { errors } = await setup(page); await open(page); await run(page);
  await expect(page.getByRole("button", { name: "Play simulation playback" })).toBeVisible(); await expect(page.getByRole("slider", { name: "Simulation time" })).toHaveValue("0");
  await page.getByRole("slider", { name: "Simulation time" }).scrollIntoViewIfNeeded();
  expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("physics-mobile.png") }); expect(errors).toEqual([]);
});


test("v2 accepts varied calibrated histories and exposes uncertainty; rejected evidence cannot be applied", async ({ page }) => {
  const { requests, errors } = await setup(page);
  await page.route("**/api/physics/status", route => route.fulfill({ json: { status: "ready", defaults, model_version: "liver-inverse-sls-2.0.0", scope: "Synthetic v2 test" } }));
  await open(page);
  await expect(page.getByText("Physics AI v2 · varied loading histories", { exact: true })).toBeVisible();
  await page.getByText("Use your calibration JSON", { exact: true }).click();
  const supplied = observation();
  supplied.times_s = Array.from({ length: 41 }, (_, index) => 8 * (index / 40) ** 1.2);
  supplied.displacement_mm = supplied.times_s.map(time => 0.8 * Math.max(0, 1 - Math.abs(time - 2) / 2));
  supplied.force_n = supplied.times_s.map(time => time === 0 ? 0 : 0.01);
  await page.getByLabel("Calibration JSON", { exact: true }).setInputFiles({ name: "varied-calibration.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(supplied)) });
  await page.route("**/api/physics/run", route => {
    const request = route.request().postDataJSON() as Request; requests.push(request);
    const value = result(request);
    return route.fulfill({ json: { ...value, learning: { ...value.learning, version: "liver-inverse-sls-2.0.0", accepted_for_application: true,
      parameter_intervals_90: { young_pa: { lower: 3900, upper: 7100 } }, uncertainty_scope: "Nominal 90% marginal intervals on synthetic specimens only; not human uncertainty." } } });
  });
  await run(page);
  expect(requests.at(-1)?.observation).toEqual(supplied);
  await expect(page.getByText("3,900–7,100 · synthetic 90% interval", { exact: true })).toBeVisible();
  await expect(page.getByText(/Nominal 90% marginal intervals/)).toBeVisible();
  await page.getByRole("button", { name: "Grasp & release", exact: true }).click();
  await page.route("**/api/physics/run", route => { const value = result(route.request().postDataJSON()); return route.fulfill({ json: { ...value, learning: { ...value.learning, accepted_for_application: false } } }); });
  await page.getByRole("button", { name: "Run experiment", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "provenance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download run JSON" })).toBeDisabled();
  expect(errors).toEqual([]);
});
