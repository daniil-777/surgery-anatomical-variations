import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AtlasGeneration } from "../../apps/studio/src/atlas";

async function frame(page: Page, info: TestInfo, name: string) {
  const image = await page.getByTestId("atlas-viewport").locator("canvas").evaluate(async (canvas: HTMLCanvasElement) => {
    // Allow React effects and the actual WebGL render loop to display the commit.
    for (let i = 0; i < 3; ++i) await new Promise(requestAnimationFrame);
    const png = canvas.toDataURL("image/png");
    const source = new Image(); source.src = png; await source.decode();
    const target = document.createElement("canvas"); target.width = source.width; target.height = source.height;
    const context = target.getContext("2d")!; context.drawImage(source, 0, 0);
    const rgba = context.getImageData(0, 0, target.width, target.height).data;
    let pixels = 0, minX = target.width, maxX = 0, minY = target.height, maxY = 0;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]! > 200) {
      const x = (i / 4) % target.width, y = Math.floor(i / 4 / target.width);
      ++pixels; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { png, pixels, bounds: [minX, minY, maxX, maxY], size: [target.width, target.height] };
  });
  const directory = process.env.VISCERA_LIVE_QA_DIR ?? info.outputPath("frames");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.png`), Buffer.from(image.png.split(",")[1]!, "base64"));
  expect(image.pixels).toBeGreaterThan(10000);
  return { ...image, png: undefined, dimensions: await page.locator(".atlas-dimensions").innerText() };
}

test("real liver updates visibly, preserves scale on screen, and generates distinct recipes", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (cause) => errors.push(cause.message));
  const generations: AtlasGeneration[] = [];
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/atlas/generate") && response.ok()) generations.push(await response.json());
  });
  await page.goto("/?template=hra-liver-female");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clay", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clay", exact: true })).toHaveAttribute("aria-pressed", "true");
  const baseline = await frame(page, info, "01-reference");
  const baselineHash = generations.at(-1)!.scene.metadata?.geometry_sha256;

  await page.getByRole("slider", { name: "Width", exact: true }).fill("-1");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  const narrow = await frame(page, info, "02-width-minus-one");
  expect(generations.at(-1)!.scene.metadata?.geometry_sha256).not.toBe(baselineHash);
  await page.getByRole("slider", { name: "Width", exact: true }).fill("1");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  const wide = await frame(page, info, "03-width-plus-one");
  expect(wide.pixels).toBeGreaterThan(narrow.pixels * 1.08);
  expect(wide.dimensions).not.toBe(narrow.dimensions);

  for (const name of ["Height", "Depth"]) await page.getByRole("slider", { name, exact: true }).fill("1");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  const larger = await frame(page, info, "04-all-dimensions-plus-one");
  // Automatic camera refitting previously erased this visible size difference.
  expect(larger.pixels).toBeGreaterThan(baseline.pixels * 1.15);
  const recipes = [];
  for (let index = 0; index < 3; ++index) {
    const response = page.waitForResponse((item) => item.url().endsWith("/api/atlas/generate") && item.ok());
    await page.getByRole("button", { name: "Generate variation", exact: true }).click();
    const generated = await (await response).json() as AtlasGeneration;
    await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
    const image = await frame(page, info, `0${index + 5}-broad-variation`);
    recipes.push({ spec: generated.spec, geometry_sha256: generated.scene.metadata?.geometry_sha256, image });
  }
  expect(new Set(recipes.map((item) => item.spec.seed)).size).toBe(3);
  expect(new Set(recipes.map((item) => item.geometry_sha256)).size).toBe(3);
  expect(recipes.every((item) => Object.values(item.spec.controls).every((value) => Math.abs(value) <= 1))).toBe(true);
  await page.getByRole("button", { name: "Tissue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tissue", exact: true })).toHaveAttribute("aria-pressed", "true");
  const beforeSurface = generations.at(-1)!.scene.metadata?.geometry_sha256;
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await page.getByRole("button", { name: "Rich pigment surface preset", exact: true }).click();
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  const surface = await frame(page, info, "08-live-surface");
  expect(generations.at(-1)!.scene.metadata?.geometry_sha256).toBe(beforeSurface);
  expect(errors).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const directory = process.env.VISCERA_LIVE_QA_DIR ?? info.outputPath("frames");
  await page.screenshot({ path: join(directory, "09-studio.png") });
  await writeFile(join(directory, "real-editor-audit.json"), JSON.stringify({ baseline, narrow, wide, larger, recipes, surface, browserErrors: errors }, null, 2));
});
