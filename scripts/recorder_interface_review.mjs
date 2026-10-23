/** Exercise the shipped interface and actual preview playback; no screenshot baseline claim. */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.RECORDER_REVIEW_URL ?? "http://127.0.0.1:5174/";
const output = path.resolve(process.env.RECORDER_REVIEW_OUTPUT ?? "artifacts/video-recorder-2026-10-20/interface-final");
if ((await readdir(output).catch(error => {
  if (error.code === "ENOENT") return [];
  throw error;
})).length) throw new Error(`Preserve previous evidence; choose a new output directory: ${output}`);
await mkdir(output, { recursive: true });
const report = {
  url: base, startedAt: new Date().toISOString(), browser: "", cases: [], pageErrors: [],
  failedRequests: [], playback: null, verdict: "NOT RUN",
  limitations: [
    "No approved screenshot baseline: visual regression is INCONCLUSIVE.",
    "Keyboard and layout checks are not a complete screen-reader or WCAG audit.",
    "A browser viewport emulates a phone layout, not phone hardware or encoding performance.",
  ],
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}),
    args: ["--use-gl=angle", "--use-angle=metal"],
  });
  report.browser = browser.version();
  for (const width of [1440, 768, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push({ width, message: error.message }));
    page.on("requestfailed", request => report.failedRequests.push({ width, url: request.url(), error: request.failure()?.errorText }));
    const entry = new URL(base); entry.searchParams.set("mode", "tissues");
    await page.goto(entry.href);
    await page.locator('[data-tissue-ready="true"]').waitFor({ timeout: 60_000 });
    const textButton = page.getByRole("button", { name: "Display settings", exact: true });
    assert.match(await textButton.innerText(), /Text size/);
    await textButton.focus(); await page.keyboard.press("Enter");
    const display = page.getByRole("dialog", { name: "Make this workspace yours" });
    await display.waitFor();
    const slider = display.getByRole("slider", { name: "Interface text size" });
    await slider.focus(); await page.keyboard.press("End");
    assert.equal(await slider.inputValue(), "200");
    await page.keyboard.press("Escape");
    assert.equal(await textButton.evaluate(button => document.activeElement === button), true);
    assert.match(await textButton.innerText(), /200%/);
    const trigger = page.getByRole("button", { name: "Video recorder", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Video recorder", exact: true });
    await dialog.waitFor();
    const hd = dialog.getByRole("radio", { name: "HD · 1280 × 720", exact: true });
    await hd.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowRight");
    assert.equal(await dialog.getByRole("radio", { name: "Full HD · 1920 × 1080", exact: true }).isChecked(), true);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await hd.isChecked(), true);
    await dialog.getByRole("button", { name: "Close video recorder", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.getByRole("button", { name: "Start recording", exact: true }).evaluate(button => document.activeElement === button), true);
    await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("button", { name: "Close video recorder", exact: true }).evaluate(button => document.activeElement === button), true);
    for (let index = 0; index < 22; index++) {
      await page.keyboard.press("Tab");
      const focus = await dialog.evaluate(element => ({ inside: element.contains(document.activeElement), active: document.activeElement?.outerHTML.slice(0, 350), pageFocused: document.hasFocus() }));
      assert.equal(focus.inside, true, `Modal focus escaped: ${JSON.stringify(focus)}`);
    }
    const geometry = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        overflow: element.scrollWidth - element.clientWidth,
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        textScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-text-scale").trim(),
      };
    });
    assert(geometry.left >= 0 && geometry.right <= width + 1 && geometry.top >= 0 && geometry.bottom <= 1001);
    assert(geometry.overflow <= 1 && geometry.documentOverflow <= 1, JSON.stringify(geometry));
    assert.equal(geometry.textScale, "2");
    await dialog.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `${output}/recorder-${width}-200.png` });
    await page.keyboard.press("Escape");
    assert.equal(await trigger.evaluate(button => document.activeElement === button), true);
    await page.screenshot({ path: `${output}/header-${width}-200.png` });
    await page.reload();
    await page.locator('[data-tissue-ready="true"]').waitFor({ timeout: 60_000 });
    assert.match(await textButton.innerText(), /200%/);
    report.cases.push({ width, textPercent: 200, geometry, keyboardRadioGroup: "PASS", focusTrapAndRestoration: "PASS", preferencePersistence: "PASS" });
    if (width === 1440) {
      await textButton.click(); await display.getByRole("button", { name: "100%", exact: true }).click();
      await display.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByLabel("View", { exact: true }).selectOption("walkthrough");
      await page.getByRole("button", { name: "Start camera", exact: true }).click();
      await trigger.click(); await hd.check();
      await dialog.getByRole("button", { name: "Start recording", exact: true }).click();
      await page.getByRole("button", { name: "Pause video recording", exact: true }).waitFor();
      await page.waitForTimeout(2600);
      await page.getByRole("button", { name: "Stop video recording", exact: true }).click();
      await page.getByRole("region", { name: "Finished recording" }).waitFor({ timeout: 20_000 });
      const preview = page.getByLabel("Recording preview", { exact: true });
      await page.waitForFunction(() => {
        const video = document.querySelector('video[aria-label="Recording preview"]');
        return video?.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
      }, null, { timeout: 20_000 });
      const playback = await preview.evaluate(async video => {
        video.muted = true;
        await video.play();
        await new Promise(resolve => setTimeout(resolve, 350));
        video.pause();
        const advancedTo = video.currentTime;
        const seekTarget = video.duration * 0.65;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Preview did not seek")), 5000);
          video.addEventListener("seeked", () => { clearTimeout(timeout); resolve(); }, { once: true });
          video.currentTime = seekTarget;
        });
        return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, advancedTo, seekTarget, currentTime: video.currentTime, error: video.error?.message ?? null };
      });
      assert.equal(playback.width, 1280); assert.equal(playback.height, 720);
      assert(playback.advancedTo > 0.1 && Math.abs(playback.currentTime - playback.seekTarget) < 0.15);
      assert.equal(playback.error, null); report.playback = playback;
      await page.screenshot({ path: `${output}/finished-preview.png` });
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: /^Download (MP4|WebM)$/i }).click();
      const file = await download;
      await file.saveAs(`${output}/preview-validation.${file.suggestedFilename().split(".").pop()}`);
    }
    await context.close();
  }
  assert.deepEqual(report.pageErrors, []);
  report.verdict = "PASS: keyboard, responsive layout, persistence and real preview playback; visual regression INCONCLUSIVE";
} catch (error) {
  report.verdict = "FAIL"; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, cases: report.cases.length, playback: report.playback, error: report.error, output }, null, 2));
}
