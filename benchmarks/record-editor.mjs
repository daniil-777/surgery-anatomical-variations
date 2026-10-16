/** Record the actual editor protocol with matching images, metrics and hardware. */
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "output-dir": { type: "string", default: "benchmarks/results/local" },
  },
});
const out = path.resolve(values["output-dir"]);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args:
    process.platform === "darwin"
      ? ["--use-gl=angle", "--use-angle=metal"]
      : [],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  recordVideo: { dir: out, size: { width: 1600, height: 1000 } },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:5174");
  await expect(page.getByTestId("organ-liver")).toHaveCount(1);
  await expect(page.locator(".viewport-loading")).toHaveCount(0);
  await expect(page.locator("canvas")).toBeVisible();
  const renderer = await page.locator("canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : "unavailable";
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, "studio-overview.png") });
  await page.getByTestId("run-probe").click();
  const report = page.getByTestId("probe-report");
  await expect(report).toBeVisible();
  await expect
    .poll(async () =>
      Number.parseFloat(await report.locator("strong").first().innerText()),
    )
    .toBeGreaterThan(0.5);
  await page.screenshot({ path: path.join(out, "probe-loading.png") });
  await expect(report).toHaveAttribute("data-status", "complete", {
    timeout: 45_000,
  });
  await page.screenshot({ path: path.join(out, "probe-recovery.png") });
  const downloading = page.waitForEvent("download");
  await report.getByRole("button", { name: "Report", exact: true }).click();
  const download = await downloading;
  await download.saveAs(path.join(out, "probe-metrics.json"));
  const metrics = JSON.parse(
    await readFile(path.join(out, "probe-metrics.json"), "utf8"),
  );
  expect(metrics.rejectedSteps).toBe(0);
  expect(metrics.minJacobian).toBeGreaterThan(0.8);
  expect(metrics.maxVolumeDrift).toBeLessThan(0.02);
  expect(metrics.recoveryResidualMm).toBeLessThan(
    metrics.maxDisplacementMm * 0.4,
  );
  const status = await page.locator(".statusbar").innerText();
  await report.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByTitle("Posterior view", { exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, "studio-posterior.png") });
  await page.getByTitle("Superior view", { exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, "studio-superior.png") });
  expect(errors).toEqual([]);
  await writeFile(
    path.join(out, "editor-recording.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        browser: browser.version(),
        node: process.version,
        platform: os.platform(),
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        renderer,
        viewport: { width: 1600, height: 1000 },
        statusbar: status,
        protocol:
          "Actual UI probe; 4.5 mm commanded distributed displacement, release after 0.8 s, approximately 3.5 s fixed-step simulation. Terminal state retained.",
        units: "SI in solver; mm in UI",
        metrics,
        page_errors: errors,
        evidence_limit:
          "A synthetic numerical interaction preview; not calibrated organ contact or tissue behavior.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  const video = page.video();
  await context.close();
  if (video)
    await rename(await video.path(), path.join(out, "editor-probe.webm"));
  await browser.close();
}
