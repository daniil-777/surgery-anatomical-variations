import { expect, test, type Page } from "@playwright/test";

const identities = /\b(?:Qwen[\w.\/-]*|LoRA|StableMaterials|Stable[ -]Diffusion|SD1\.5|CVAE|VAE|GAN|Fourier|Colab)\b|Joint Flow|Spline flow|conditional_spline_flow|conditional_vae/i;
async function noModelIdentities(page: Page) {
  const presented = await page.evaluate(() => [
    document.body.innerText,
    ...Array.from(document.querySelectorAll("[aria-label], [title], [alt], option, optgroup"), element =>
      [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("alt"),
        element.tagName === "OPTION" ? element.textContent : "", element.getAttribute("label")].filter(Boolean).join(" ")),
  ].join("\n"));
  expect(presented).not.toMatch(identities);
}

test("public atlas uses neutral names in selectors, details and generation", async ({ page }, info) => {
  await page.goto("./?mode=atlas");
  const variation = page.getByRole("button", { name: "Generative Model 2 variation", exact: true });
  await expect(variation).toBeEnabled();
  await page.getByRole("button", { name: "Choose generation model", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Generation models" })).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-model-option]").first()).toContainText("Generative Model");
  await noModelIdentities(page);
  await page.screenshot({ path: info.outputPath("model-selector.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Manage weights & imports" }).click();
  await expect(page.getByRole("dialog").getByText("Generative Model 5", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Preserved joint model")).toBeVisible();
  await noModelIdentities(page);
  await page.screenshot({ path: info.outputPath("model-library.png") });
  await page.getByRole("button", { name: "Close trained models" }).click();
  await variation.click();
  await expect(page.getByText("Generative Model 2 variation applied", { exact: true })).toBeVisible();
  await noModelIdentities(page);
});

test("tissue catalogs, three appearance models and PBR import keep neutral names", async ({ page }, info) => {
  await page.goto("./?mode=tissues");
  await expect(page.getByLabel("Available generative models")).toBeVisible();
  const options = page.getByLabel("Available generative models").locator("option");
  await expect(options).toHaveText(["Generative Model 8", "Generative Model 9", "Generative Model 10"]);
  await noModelIdentities(page);
  for (const id of ["spatial-v3-laparoscopic", "directional-v2-detail", "periodic-v1-baseline"]) {
    await page.getByLabel("Available generative models").selectOption(id);
    await expect(page.locator(".tissue-model-panel")).toContainText("Applied 256² learned RGB", { timeout: 45_000 });
    await expect(page.locator(".tissue-model-panel [role=alert]")).toHaveCount(0);
    await noModelIdentities(page);
  }
  await page.getByLabel("Available generative models").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("appearance-library.png") });
  await page.getByRole("button", { name: "Use generated PBR model", exact: true }).click();
  await expect(page.locator(".tissue-pbr-panel")).toContainText("Generative Model 11");
  await expect(page.getByRole("button", { name: "Export imported PBR bundle" })).toBeVisible();
  await noModelIdentities(page);
});

test("older and unknown catalog labels never leak into the model picker", async ({ page }) => {
  await page.route("**/tissue-models/catalog.json", async route => {
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.appearance_models[0].label = "Qwen / LoRA / Private Architecture";
    catalog.appearance_models.push({ ...catalog.appearance_models[0], id: "unknown-model", label: "PrivateProvider SecretModel", rank: 99 });
    await route.fulfill({ json: catalog });
  });
  await page.goto("./?mode=tissues");
  await expect(page.getByLabel("Available generative models").locator("option")).toHaveCount(4);
  await expect(page.getByLabel("Available generative models")).not.toContainText("Private");
  await noModelIdentities(page);
});

test("import guidance and model-loading errors use neutral names", async ({ page }, info) => {
  await page.goto("./?mode=imports");
  await expect(page.locator(".import-workspace, .import-studio").first()).toBeVisible();
  await noModelIdentities(page);
  await page.screenshot({ path: info.outputPath("import-guidance.png") });
  await page.route("**/models/joint-v2/model.json", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry model loading" })).toBeVisible();
  await expect(page.locator(".import-error").first()).toContainText("Generative Model 2");
  await noModelIdentities(page);
});


test("numbered model choices stay within the viewport after the header wraps", async ({ page }) => {
  await page.goto("./?mode=atlas");
  for (const width of [390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole("button", { name: "Choose generation model", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Generation models" });
    await expect(picker).toHaveAttribute("aria-busy", "false");
    const box = await picker.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await noModelIdentities(page);
    await page.getByRole("button", { name: "Close model selector" }).click();
  }
});
