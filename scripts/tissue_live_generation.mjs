// Live check: the real Tissue Lab talks to the real local generator (no mocks).
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const out = process.env.OUT, url = process.env.URL ?? "http://127.0.0.1:5193/tissues.html";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"] });
const report = { url, errors: [], runs: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("/api.json")) report.errors.push(m.text()); });
  await page.goto(url);
  const host = page.locator(".tissue-viewport[data-tissue-ready='true']");
  const snap = async () => JSON.parse(await host.getAttribute("data-tissue-snapshot"));
  await page.waitForFunction(() => document.querySelector(".tissue-viewport[data-tissue-ready='true']"), null, { timeout: 60000 });
  await page.getByLabel("Tissue region", { exact: true }).selectOption("pancreas");
  await page.waitForFunction(() => JSON.parse(document.querySelector(".tissue-viewport[data-tissue-ready='true']")?.dataset.tissueSnapshot ?? "{}").organ === "pancreas", null, { timeout: 60000 });
  await page.screenshot({ path: `${out}/01-gallery-pancreas.png` });
  await page.getByRole("button", { name: "Connect to local generator" }).click();
  await page.getByLabel("Generator tissue family").waitFor();
  for (const [family, mode] of [["pancreas", "clean"], ["liver", "guided"]]) {
    if (report.runs.length) { await page.getByRole("button", { name: "Return to tissue library" }).click(); await page.waitForTimeout(1500); }
    await page.getByLabel("Generator tissue family").selectOption(family);
    await page.getByLabel("Generation mode").selectOption(mode);
    const t0 = Date.now();
    await page.getByRole("button", { name: "Generate new tile" }).click();
    await page.getByRole("button", { name: "Return to tissue library" }).waitFor({ timeout: 300000 });
    await page.waitForFunction(() => JSON.parse(document.querySelector(".tissue-viewport[data-tissue-ready='true']")?.dataset.tissueSnapshot ?? "{}").importedMaterial, null, { timeout: 60000 });
    const seconds = (Date.now() - t0) / 1000, state = await snap();
    const status = await page.locator(".tissue-learned-panel [role=status]").last().innerText().catch(() => "");
    await page.screenshot({ path: `${out}/02-generated-${family}-${mode}.png` });
    const png = await host.evaluate(el => el.captureTissueFrame(3840, 2160, 0));
    await writeFile(`${out}/03-${family}-${mode}-surface-3840x2160.png`, Buffer.from(png.split(",")[1], "base64"));
    await page.getByLabel("View", { exact: true }).selectOption("organ");
    await page.waitForFunction(() => JSON.parse(document.querySelector(".tissue-viewport[data-tissue-ready='true']")?.dataset.tissueSnapshot ?? "{}").geometry === "source-atlas-exterior-v1", null, { timeout: 60000 });
    await page.waitForTimeout(800);
    const organ = await host.evaluate(el => el.captureTissueFrame(3840, 2160, 0));
    await writeFile(`${out}/04-${family}-${mode}-organ-3840x2160.png`, Buffer.from(organ.split(",")[1], "base64"));
    await page.getByLabel("View", { exact: true }).selectOption("surface");
    report.runs.push({ family, mode, secondsClickToApplied: seconds, organ: state.organ, bundleSha256: state.importedMaterial?.bundleSha256, status });
    console.log(JSON.stringify(report.runs.at(-1)));
  }
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ errors: report.errors }));
