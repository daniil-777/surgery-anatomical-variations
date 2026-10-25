import { expect, test, type Page } from "@playwright/test";

const defaults = { source: "defaults", bundle_sha256: null, max_upload_bytes: 134217728,
  lanes: { shape: { status: "available", scope: "packaged shape model" }, material: { status: "available", scope: "packaged appearance prior" }, disease: { status: "available", scope: "packaged disease prior" } } };
const imported = { ...defaults, source: "imported", bundle_sha256: "a".repeat(64), lanes: {
  shape: { status: "active", method: "ridge", scope: "synthetic geometry controls" },
  material: { status: "active", method: "ridge", scope: "procedural appearance controls" },
  disease: { status: "active", method: "conditional_vae", scope: "synthetic disease surface recipes" },
  language: { status: "stored_research_adapter_not_enabled", scope: "Guarded deterministic text compiler stays active" },
  physics: { status: "not_trained", scope: "no constitutive mechanics learned" },
  clinical: { status: "stored_retrieval_prior", scope: "observed cases only", groups: [{ organ: "pancreas", disease_code: "pancreatic_ductal_adenocarcinoma" }] },
} };
async function setup(page: Page, statusUnavailable = false, openModels = true, initialStatus: typeof defaults | typeof imported = defaults) {
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: { organs: [{ id: "liver", label: "Liver", templates: [{ id: "liver-test", label: "Reference", source: "Fixture", license: "Test" }] }], controls: [{ key: "bend", label: "Bend", min: -1, max: 1, default: 0 }] } }));
  await page.route("**/api/atlas/generate", route => route.fulfill({ json: { spec: { ...route.request().postDataJSON(), realized_id: "bound" }, summary: {}, scene: { organs: [{ id: "liver", name: "Liver", kind: "organ", color: "#913831", positions: [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70], indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2] }], metadata: { geometry_sha256: "geometry" } } } }));
  await page.route("**/api/atlas/models", route => route.fulfill(statusUnavailable ? { status: 503, json: { detail: "Active model manifest changed; restore defaults" } } : { json: initialStatus }));
  await page.route("**/api/atlas/models/joint/history", route => route.fulfill({ json: { versions: [], selected_generation: 1, active_bundle: null, selection_error: null } }));
  await page.goto("/");
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  if (!openModels) return;
  const manage = page.getByRole("button", { name: "Trained models", exact: true });
  if (await manage.isVisible()) {
    await manage.click();
  } else {
    await page.getByRole("button", { name: "Choose generation model", exact: true }).click();
    await page.getByRole("button", { name: "Manage weights & imports", exact: true }).click();
  }
  await expect(page.getByRole("dialog")).toBeVisible();
  if (!statusUnavailable) await expect(page.getByText("Packaged default models", { exact: true })).toBeVisible();
}

test("Colab weights activate atomically, show lane scope, and restore defaults", async ({ page }) => {
  await setup(page);
  let posted: Buffer | null = null;
  await page.route("**/api/atlas/models/import", route => { posted = route.request().postDataBuffer(); expect(route.request().headers()["content-type"]).toBe("application/zip"); return route.fulfill({ json: imported }); });
  await page.route("**/api/atlas/models/defaults", route => route.fulfill({ json: defaults }));
  await page.getByLabel("Model weight archive").setInputFiles({ name: "viscera-final-weights.zip", mimeType: "application/zip", buffer: Buffer.from("fixture-zip") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await expect(page.getByText("Your imported weights are active", { exact: true })).toBeVisible();
  expect(posted?.toString()).toBe("fixture-zip");
  await expect(page.getByText("Stored · research only", { exact: true })).toBeVisible();
  await expect(page.getByText("Not trained", { exact: true })).toBeVisible();
  await expect(page.getByText("a".repeat(64), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await expect(page.getByText("Packaged default models", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Trained models", exact: true })).toBeFocused();
});

test("corrupted active registry can recover through Restore defaults", async ({ page }) => {
  await setup(page, true);
  await page.route("**/api/atlas/models/defaults", route => route.fulfill({ json: defaults }));
  await expect(page.getByRole("alert")).toContainText("manifest changed");
  await expect(page.getByRole("button", { name: "Restore defaults", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await expect(page.getByText("Packaged default models", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("language enable explicitly permits its download and source retrieval never edits geometry", async ({ page }) => {
  await setup(page);
  await page.route("**/api/atlas/models/import", route => route.fulfill({ json: imported }));
  await page.route("**/api/atlas/models/language/enable", route => { expect(route.request().postDataJSON()).toEqual({ allow_model_download: true }); return route.fulfill({ json: { ...imported, language_enabled: true } }); });
  await page.route("**/api/atlas/models/clinical/sample", route => route.fulfill({ json: { cases: [{ case_id: "observed-case", organ: "pancreas", disease_code: "pancreatic_ductal_adenocarcinoma", sampling: "empirical_case_retrieval", observed_training_patients: 1, measured_features: { organ_volume_ml: 100, lesion_volume_ml: 20 } }] } }));
  await page.getByLabel("Model weight archive").setInputFiles({ name: "weights.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await page.getByText("Observed clinical cases", { exact: true }).click();
  await page.getByRole("button", { name: "Retrieve observed case", exact: true }).click();
  await expect(page.getByText("observed-case", { exact: true })).toBeVisible();
  await expect(page.getByText("1 observed training patient in this group; no population variance is inferred.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Enable text adapter (downloads base model)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Text adapter enabled", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Use trained text adapter · shape edits, compiler guarded", exact: true })).toBeChecked();
  await page.route("**/api/atlas/compile", route => { expect(route.request().postDataJSON().use_trained_language).toBe(true); return route.fulfill({ json: { status: "unsupported", message: "Adapter guard rejected the proposal; no edit applied" } }); });
  await page.getByRole("textbox", { name: "Describe an anatomy variation", exact: true }).fill("slightly wider");
  await page.getByRole("button", { name: "Apply text instruction", exact: true }).click();
  await expect(page.getByText("Adapter guard rejected the proposal; no edit applied", { exact: true })).toBeVisible();
});

test("fresh browsers discover an enabled text adapter without opting in or downloading it", async ({ page }) => {
  let enableRequests = 0;
  await page.route("**/api/atlas/models/language/enable", route => { enableRequests += 1; return route.abort(); });
  const enabled = { ...imported, language_enabled: true };
  await setup(page, false, false, enabled);
  expect(await page.evaluate(() => localStorage.getItem("viscera-text-adapter-enabled"))).toBeNull();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const toggle = page.getByRole("checkbox", { name: "Use trained text adapter · shape edits, compiler guarded", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  let requests = 0;
  await page.route("**/api/atlas/compile", route => {
    expect(route.request().postDataJSON().use_trained_language).toBeUndefined();
    requests += 1;
    return route.fulfill({ json: { status: "unsupported", message: "Deterministic compiler response" } });
  });
  await page.getByRole("textbox", { name: "Describe an anatomy variation", exact: true }).fill("slightly wider");
  await page.getByRole("button", { name: "Apply text instruction", exact: true }).click();
  await expect(page.getByText("Deterministic compiler response", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  expect(enableRequests).toBe(0);
});

test("status refreshes and page reload never opt into the guarded text adapter", async ({ page }) => {
  await setup(page);
  const enabled = { ...imported, language_enabled: true, lanes: { ...imported.lanes, language: { status: "enabled_guarded_adapter", scope: "Research shape adapter with compiler validation" } } };
  await page.route("**/api/atlas/models", route => route.fulfill({ json: enabled }));
  const toggle = page.getByRole("checkbox", { name: "Use trained text adapter · shape edits, compiler guarded", exact: true });
  const reopen = async () => {
    await page.getByRole("button", { name: "Close trained models", exact: true }).click();
    await page.getByRole("button", { name: "Trained models", exact: true }).click();
    await expect(page.getByRole("button", { name: "Text adapter enabled", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  };
  await reopen();
  // An already loaded model makes the option available, but is not an opt-in.
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Text adapter enabled", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await reopen();
  await expect(toggle).not.toBeChecked();
  let requests = 0;
  await page.route("**/api/atlas/compile", route => {
    expect(route.request().postDataJSON().use_trained_language).toBeUndefined();
    requests += 1;
    return route.fulfill({ json: { status: "unsupported", message: "Deterministic compiler response" } });
  });
  await page.getByRole("textbox", { name: "Describe an anatomy variation", exact: true }).fill("slightly wider");
  await page.getByRole("button", { name: "Apply text instruction", exact: true }).click();
  await expect(page.getByText("Deterministic compiler response", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  // Availability must not select the research model in a new page session.
  await toggle.check();
  await page.reload();
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
});

test("text model loading reports its own action without claiming archive validation", async ({ page }) => {
  await setup(page);
  await page.route("**/api/atlas/models/import", route => route.fulfill({ json: imported }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/atlas/models/language/enable", async route => {
    await pending;
    return route.fulfill({ json: { ...imported, language_enabled: true } });
  });
  await page.getByLabel("Model weight archive").setInputFiles({ name: "weights.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await page.getByRole("button", { name: "Enable text adapter (downloads base model)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Loading text model…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Validate & activate", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Validating models…", exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole("button", { name: "Text adapter enabled", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close trained models", exact: true })).toBeEnabled();
});

test("failed import preserves model status and pending validation cannot close the dialog", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/atlas/models/import", async route => { await pending; return route.fulfill({ status: 422, json: { detail: "Weights were not activated: dataset mismatch" } }); });
  await page.getByLabel("Model weight archive").setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from("bad") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Validating models…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  release();
  await expect(page.getByRole("alert")).toContainText("dataset mismatch");
  await expect(page.getByText("Packaged default models", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore defaults", exact: true })).toBeDisabled();
});

test("model panel fits mobile and rejects non-ZIP files locally", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByLabel("Model weight archive").setInputFiles({ name: "model.pkl", mimeType: "application/octet-stream", buffer: Buffer.from("not allowed") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("model weights ZIP");
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("colab-models-mobile.png") });
});

// These contract tests model an online service, independent of the preview host.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", route => route.fulfill({ json: { status: "ok" } }));
});
