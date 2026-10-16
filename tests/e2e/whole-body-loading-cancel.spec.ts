import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

declare global {
  interface Window {
    referenceDecodeAudit: { reads: number; decodes: number; release: (() => void) | null };
  }
}

async function gateFirstReferenceDecode(page: Page) {
  await page.addInitScript(() => {
    const nativeDecode = HTMLImageElement.prototype.decode;
    const nativeRead = FileReader.prototype.readAsDataURL;
    window.referenceDecodeAudit = { reads: 0, decodes: 0, release: null };
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      ++window.referenceDecodeAudit.reads;
      nativeRead.call(this, blob);
    };
    HTMLImageElement.prototype.decode = async function () {
      await nativeDecode.call(this);
      if (this.src.startsWith("data:") && ++window.referenceDecodeAudit.decodes === 1) {
        await new Promise<void>(resolve => { window.referenceDecodeAudit.release = resolve; });
      }
    };
  });
}

async function openBodyPanel(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?mode=scene");
  await expect(page.locator("[data-scene-ready='true'] canvas")).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Whole-body colour", exact: true }).click();
}

async function cancelAndReleaseDecode(page: Page) {
  await page.waitForFunction(() => typeof window.referenceDecodeAudit.release === "function");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(async () => {
    window.referenceDecodeAudit.release!();
    // Flush the resumed decoder and its caller through the browser event loop.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test("cancelling a library load during local decode cannot resurrect loading or append stale sources", async ({ page }) => {
  const catalog = JSON.parse(await readFile("apps/studio/public/body-reference/catalog.json", "utf8"));
  catalog.sources = catalog.sources.slice(0, 2);
  // Masks are optional in the real catalog contract. This exposes the local
  // decode boundary without an intervening fetch automatically rejecting abort.
  for (const source of catalog.sources) for (const region of source.regions) delete region.mask_src;
  await page.route("**/body-reference/catalog.json", route => route.fulfill({ json: catalog }));
  await gateFirstReferenceDecode(page);
  await openBodyPanel(page);
  await page.getByRole("button", { name: "Load reference library", exact: true }).click();
  await cancelAndReleaseDecode(page);
  await expect(page.locator(".wb-activity")).toHaveCount(0);
  await expect(page.locator(".wb-source")).toHaveCount(0);
  expect(await page.evaluate(() => window.referenceDecodeAudit.reads)).toBe(1);
  await expect(page.getByRole("button", { name: "Apply all reviewed colours", exact: true })).toBeDisabled();
});

test("cancelling multi-image upload stops reading later files and leaves no stale sources", async ({ page }) => {
  const catalog = JSON.parse(await readFile("apps/studio/public/body-reference/catalog.json", "utf8"));
  await gateFirstReferenceDecode(page);
  await openBodyPanel(page);
  await page.getByLabel("Whole-body reference images", { exact: true }).setInputFiles(catalog.sources.slice(0, 2).map((source: { src: string }) => `apps/studio/public${source.src}`));
  await cancelAndReleaseDecode(page);
  await expect(page.locator(".wb-activity")).toHaveCount(0);
  await expect(page.locator(".wb-source")).toHaveCount(0);
  expect(await page.evaluate(() => window.referenceDecodeAudit.reads)).toBe(1);
  expect(await page.evaluate(() => window.referenceDecodeAudit.decodes)).toBe(1);
  await expect(page.getByRole("button", { name: "Apply all reviewed colours", exact: true })).toBeDisabled();
});
