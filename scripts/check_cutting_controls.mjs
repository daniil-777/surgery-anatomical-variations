#!/usr/bin/env node
// Serial native browser control/fault gate. Do not run beside another GPU gate.
// No solver mocks or product hooks: all actions use the shipped UI. The only
// injected faults emit Worker errors at initialization and during an actual
// outstanding step; resets use the real worker, mesh and solver again.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.CUTTING_CONTROLS_OUT ?? path.join(root, 'artifacts/cutting-2026-10-20', `controls-${Date.now()}`));
const url = process.env.CUTTING_URL ?? 'http://127.0.0.1:5174/';
await fs.mkdir(out, { recursive: true });
const staticConfig = process.env.CUTTING_STATIC_COPY === '1' ? await fetch(new URL('api.json', url)).then(r => { if (!r.ok) throw new Error('Static API configuration unavailable'); return r.json(); }) : null;
if (staticConfig && staticConfig.api !== null) throw new Error('Offline health expectation requires explicit api:null');
const expectedHealth = location => Boolean(staticConfig) && location === new URL('api/health', url).href;
const report = { status: 'FAIL', url, out, startedAt: new Date().toISOString(), checks: [], errors: [], failedRequests: [], expectedOfflineProbes: [], expectedOfflineConsole: [] };
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? {
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-gl=angle', '--use-angle=metal'],
} : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true });
await context.addInitScript(() => {
  const NativeWorker = window.Worker;
  const audit = { installed: true, failNextCuttingInit: false, failNextCuttingStep: false, injected: 0, stepInjected: 0, stepFailures: [], workers: [], pointers: [] };
  window.__cuttingControlAudit = audit;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.auditEntry = { id: audit.workers.length, url: String(args[0]), cutting: false, terminated: 0, steps: 0, pendingSteps: [], responses: 0 };
      audit.workers.push(this.auditEntry);
      this.addEventListener('message', event => {
        this.auditEntry.responses++;
        this.auditEntry.pendingSteps = this.auditEntry.pendingSteps.filter(id => id !== event.data?.id);
      });
    }
    postMessage(message, ...options) {
      let injectStepFailure = false;
      if (message?.action === 'init' && message.reference?.schema === 'viscera.cutting-reference/v1') {
        this.auditEntry.cutting = true;
        if (audit.failNextCuttingInit) {
          audit.failNextCuttingInit = false; audit.injected++;
          setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'CUTTING_QA_EXPECTED_INIT_FAILURE' })), 0);
          return;
        }
      }
      if (this.auditEntry.cutting && message?.action === 'step') {
        this.auditEntry.steps++; this.auditEntry.pendingSteps.push(message.id);
        if (audit.failNextCuttingStep) {
          audit.failNextCuttingStep = false; injectStepFailure = true;
        }
      }
      const result = super.postMessage(message, ...options);
      if (injectStepFailure) {
        // The real step has been posted. A microtask runs before any Worker
        // response task, so the client has an outstanding request when its
        // ordinary error handler terminates this worker. This is not an
        // accepted:false mechanical response or a mocked solver result.
        queueMicrotask(() => {
          audit.stepInjected++;
          audit.stepFailures.push({ workerId: this.auditEntry.id, requestId: message.id, pendingBeforeError: [...this.auditEntry.pendingSteps] });
          this.dispatchEvent(new ErrorEvent('error', { message: 'CUTTING_QA_EXPECTED_MID_STEP_FAILURE' }));
        });
      }
      return result;
    }
    terminate() { this.auditEntry.terminated++; this.auditEntry.pendingSteps = []; return super.terminate(); }
  };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
    document.addEventListener(type, event => {
      if (!(event.target instanceof HTMLCanvasElement) || !event.target.closest('[data-testid="cutting-viewport"]')) return;
      audit.pointers.push({ type, pointerType: event.pointerType, isTrusted: event.isTrusted });
      if (audit.pointers.length > 200) audit.pointers.shift();
    }, true);
  }
});
const page = await context.newPage(); page.setDefaultTimeout(45000);
page.on('pageerror', error => report.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { if (expectedHealth(message.location().url)) report.expectedOfflineConsole.push(message.text()); else report.errors.push(message.text()); } });
page.on('response', response => { if (response.status() >= 400) (expectedHealth(response.url()) && response.status() === 404 ? report.expectedOfflineProbes : report.failedRequests).push({ url: response.url(), status: response.status() }); });
const lab = page.getByRole('dialog', { name: 'Liver physics lab', exact: true });
const button = name => lab.getByRole('button', { name, exact: true });
const host = page.getByTestId('cutting-viewport'), canvas = host.locator('canvas'), stage = lab.locator('.cutting-stage');
const diagnostic = async () => JSON.parse(await host.getAttribute('data-cutting-diagnostics'));
const audit = () => page.evaluate(() => window.__cuttingControlAudit);
const check = (name, details = {}) => report.checks.push({ name, status: 'PASS', ...details });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const exported = async name => {
  const pending = page.waitForEvent('download'); await button('Export mechanical state').click();
  const file = await pending, destination = path.join(out, `${name}.json`); await file.saveAs(destination);
  return JSON.parse(await fs.readFile(destination, 'utf8'));
};
const ready = async (waitForWorker = true) => {
  await expect(canvas).toHaveCount(1);
  await expect.poll(async () => Boolean(await host.getAttribute('data-cutting-diagnostics')), { timeout: 90000 }).toBe(true);
  if (waitForWorker) await expect.poll(async () => (await diagnostic())?.workerReady, { timeout: 90000 }).toBe(true);
};
const settlePaused = async () => {
  if (await button('Pause').count()) await button('Pause').click();
  await expect(button('Resume')).toBeVisible();
  await expect.poll(async () => (await audit()).workers.filter(w => w.cutting && !w.terminated).every(w => w.pendingSteps.length === 0)).toBe(true);
  // Diagnostics are published at 4Hz; wait for that accepted snapshot too.
  await expect.poll(async () => (await diagnostic()).workerStepInFlight).toBe(false);
  await frames();
};
const reset = async () => {
  await button('Reset liver').click();
  await expect.poll(async () => (await diagnostic()).timeSeconds).toBe(0);
  await expect(button('Resume')).toBeVisible(); await settlePaused();
};
const upload = async (name, value) => {
  await lab.getByLabel('Cutting calibration JSON', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
};
const canvasPoint = async (x = .58, y = .32) => {
  await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); expect(box).toBeTruthy();
  return { x: box.x + box.width * x, y: box.y + box.height * y };
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  expect((await audit()).installed).toBe(true);
  await page.getByRole('button', { name: 'Physics lab', exact: true }).click();
  await button('Scalpel & fracture').click(); await ready();
  await expect(lab.getByRole('alert')).toHaveCount(0);
  expect((await audit()).workers.some(w => w.cutting && !w.terminated)).toBe(true);
  await expect(canvas).toHaveAttribute('data-scene-recording-source', 'native');
  const initial = await exported('initial'); expect(initial.metrics.timeSeconds).toBe(0);
  check('Shipped cutting UI, real worker and native recording source initialize');

  // Keyboard guidance changes the accepted tool, with a genuine outstanding
  // worker request when Pause is requested. Snapshot stability is checked only
  // after that request finishes; no assumption that Pause cancels a solve.
  await button('Cut').click(); await canvas.focus(); await page.keyboard.press('Shift+ArrowRight');
  const outstanding = await page.waitForFunction(() => {
    const pending = window.__cuttingControlAudit.workers.filter(w => w.cutting && !w.terminated).flatMap(w => w.pendingSteps).length;
    return pending || false;
  }, null, { timeout: 45000 });
  const pendingAtPause = await outstanding.jsonValue(); await outstanding.dispose();
  expect(pendingAtPause).toBeGreaterThan(0); await settlePaused();
  const keyboard = await exported('keyboard-paused');
  expect(keyboard.scalpel.target.centerZMm - initial.scalpel.target.centerZMm).toBeCloseTo(3, 7);
  expect(keyboard.metrics.acceptedSteps).toBeGreaterThan(0);
  await page.waitForTimeout(600); const still = await exported('keyboard-still-paused');
  expect(still.metrics).toEqual(keyboard.metrics); expect(still.nodePositionsMm).toEqual(keyboard.nodePositionsMm);
  check('Keyboard target moves 3 mm; Pause waits for the outstanding accepted step and then holds state', { pendingAtPause });

  await reset(); await button('Cut').click(); const mouse = await canvasPoint();
  await page.mouse.move(mouse.x, mouse.y); await page.mouse.down(); await page.mouse.move(mouse.x + 25, mouse.y + 12, { steps: 4 }); await page.mouse.up();
  await expect(lab.getByText('Pointer movement sets a target; the displayed blade shows accepted physical motion.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await diagnostic()).acceptedSteps).toBeGreaterThan(0);
  await settlePaused(); const mouseState = await exported('mouse-target');
  expect(mouseState.scalpel.target.active).toBe(true);
  expect(Number.isFinite(mouseState.scalpel.target.tipYMm)).toBe(true);
  expect((await audit()).pointers.some(p => p.type === 'pointerdown' && p.pointerType === 'mouse' && p.isTrusted)).toBe(true);
  expect((await audit()).pointers.some(p => p.type === 'lostpointercapture' && p.pointerType === 'mouse')).toBe(true);
  check('Real mouse drag guides the finite-plane target and releases pointer capture');

  await reset(); await button('Cut').click(); const touch = await canvasPoint(.65, .36);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 7, x: touch.x, y: touch.y, radiusX: 4, radiusY: 4, force: .5 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 7, x: touch.x - 22, y: touch.y + 10, radiusX: 4, radiusY: 4, force: .5 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
  await expect.poll(async () => (await diagnostic()).acceptedSteps).toBeGreaterThan(0);
  await settlePaused(); const touched = await exported('touch-target');
  expect(touched.scalpel.target.active).toBe(true);
  expect((await audit()).pointers.some(p => p.type === 'pointerdown' && p.pointerType === 'touch' && p.isTrusted)).toBe(true);
  expect((await audit()).pointers.some(p => p.type === 'lostpointercapture' && p.pointerType === 'touch')).toBe(true);
  check('Trusted single-touch drag guides the tool and releases capture');

  await reset(); await button('Inspect').click(); await canvas.scrollIntoViewIfNeeded(); await frames();
  const inspectBefore = await exported('inspect-before'); await canvas.focus();
  const imageBefore = await canvas.screenshot();
  const orbit = await canvasPoint(.5, .55); await page.mouse.move(orbit.x, orbit.y); await page.mouse.down(); await page.mouse.move(orbit.x + 65, orbit.y + 18, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(450); const imageAfter = await canvas.screenshot({ path: path.join(out, 'inspect-orbit.png') });
  const inspectAfter = await exported('inspect-after');
  expect(hash(imageAfter)).not.toBe(hash(imageBefore));
  expect(inspectAfter.nodePositionsMm).toEqual(inspectBefore.nodePositionsMm); expect(inspectAfter.metrics).toEqual(inspectBefore.metrics);
  await canvas.focus(); await page.keyboard.press('f'); await frames();
  check('Inspect changes the rendered camera view without advancing mechanics; F fits');

  await button('Hide handle').click(); await frames();
  await expect.poll(async () => (await diagnostic()).handleVisible).toBe(false);
  const withoutHandle = await exported('handle-hidden');
  expect(withoutHandle.nodePositionsMm).toEqual(inspectAfter.nodePositionsMm);
  expect(withoutHandle.metrics).toEqual(inspectAfter.metrics);
  await button('Show handle').click();
  await expect.poll(async () => (await diagnostic()).handleVisible).toBe(true);
  check('Cosmetic handle inspection toggle preserves the accepted mechanics');

  await lab.getByText('Learn cutting parameters from a measured curve', { exact: true }).click();
  await expect(lab.getByLabel('Cutting calibration JSON', { exact: true })).toBeEnabled();
  const example = JSON.parse(await fs.readFile(path.join(root, 'apps/studio/public/models/cutting-v1/example-observation.json'), 'utf8'));
  await upload('invalid.json', { ...example, area_mm2: 0 });
  await expect(lab.getByRole('alert')).toContainText('Known positive fracture interface area');
  await expect(button('Apply fitted material & reset')).toHaveCount(0);
  const invalidState = await exported('invalid-calibration'); expect(invalidState.cohesiveProvenance).toEqual(initial.cohesiveProvenance);
  await upload('partial.json', { ...example, opening_mm: example.opening_mm.slice(0, 64), force_n: example.force_n.slice(0, 64) });
  await expect(lab.locator('.cutting-calibration-result')).toHaveAttribute('data-accepted', 'false');
  await expect(button('Apply fitted material & reset')).toBeDisabled();
  await expect(lab.locator('.cutting-calibration-result')).toContainText('complete_fracture_not_observed');
  check('Invalid known-area data and incomplete fracture curves cannot be applied');

  await upload('complete-synthetic.json', example);
  await expect(button('Apply fitted material & reset')).toBeEnabled(); await button('Apply fitted material & reset').click();
  await ready(); await expect.poll(async () => (await diagnostic()).timeSeconds).toBe(0);
  const fitted = await exported('applied-calibration');
  expect(fitted.cohesiveProvenance.source).toBe('synthetic-trained-coupon-calibration');
  expect(fitted.cohesiveProvenance.modelId).toMatch(/^[a-f0-9]{64}$/);
  expect(fitted.cohesiveProvenance.observationProvenance).toBe(example.provenance);
  expect(fitted.cohesiveProvenance.humanLiverValidated).toBe(false);
  expect(fitted.cohesive.fractureEnergyJm2).toBeCloseTo(20, 2);
  expect(fitted.cohesive.peakTractionPa).toBeCloseTo(16000, 0);
  expect(fitted.bulkProvenance).toBeTruthy(); expect(fitted.appearance.patientLearned).toBe(false);
  await lab.getByLabel('Cutting fracture energy', { exact: true }).fill('2.5');
  const pending = await exported('pending-manual'); expect(pending.cohesiveProvenance).toEqual(fitted.cohesiveProvenance);
  await button('Apply material & reset').click(); await ready();
  const manual = await exported('applied-manual');
  expect(manual.cohesive.fractureEnergyJm2).toBe(2.5);
  expect(manual.cohesiveProvenance.source).toBe('manual-or-prescribed-synthetic-demonstration');
  expect(manual.cohesiveProvenance.modelId).toBeUndefined();
  check('Accepted fit exports exact model/observation provenance; pending edits preserve it and manual Apply clears it');

  const baselineFont = await lab.locator('.cutting-control > span').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await button('Display settings').click();
  const display = page.getByRole('dialog', { name: 'Make this workspace yours', exact: true });
  await display.getByRole('button', { name: '200%', exact: true }).click(); await display.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => lab.locator('.cutting-control > span').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(baselineFont * 2, 2);
  for (const width of [390, 768, 1600]) {
    await page.setViewportSize({ width, height: 1100 }); await frames();
    // Font scaling and responsive modal layout can settle after two animation
    // frames under load. Require the final layout rather than a transient frame.
    await expect.poll(() => lab.evaluate(element => element.scrollWidth <= element.clientWidth + 1), {timeout:5000}).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), {timeout:5000}).toBe(true);
    await button('Export mechanical state').scrollIntoViewIfNeeded(); await expect(button('Export mechanical state')).toBeInViewport();
    await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
    if (width === 390) {
      await stage.scrollIntoViewIfNeeded();
      await stage.getByRole('button', { name: 'Scene full screen', exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('cutting-stage') ?? false)).toBe(true);
      await expect.poll(() => stage.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(stage.getByText(/s physical time$/)).toBeInViewport({ ratio: 1 });
      for (const name of ['Resume simulation', 'Withdraw instrument', 'Exit scene full screen']) {
        const control = stage.getByRole('button', { name, exact: true });
        await expect(control).toBeVisible(); await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
      }
      const narrowFullscreen = await stage.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
          controls: [...element.querySelectorAll('.cutting-fullscreen-controls > *')].map(control => { const r = control.getBoundingClientRect(); return { text: control.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }) };
      });
      expect(Math.abs(narrowFullscreen.width - narrowFullscreen.viewportWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(narrowFullscreen.height - narrowFullscreen.viewportHeight)).toBeLessThanOrEqual(1);
      for (const control of narrowFullscreen.controls) {
        expect(control.left).toBeGreaterThanOrEqual(-1); expect(control.right).toBeLessThanOrEqual(narrowFullscreen.viewportWidth + 1);
        expect(control.top).toBeGreaterThanOrEqual(-1); expect(control.bottom).toBeLessThanOrEqual(narrowFullscreen.viewportHeight + 1);
      }
      await page.screenshot({ path: path.join(out, 'fullscreen-390-text200.png') });
      await stage.getByRole('button', { name: 'Exit scene full screen', exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
      check('Narrow 390 px fullscreen at 200% text keeps clock and touch controls visible and unobscured', { layout: narrowFullscreen });
    }
  }
  await button('Display settings').click(); await display.getByRole('button', { name: 'Reset display preferences' }).click(); await display.getByRole('button', { name: 'Done', exact: true }).click();
  const oldControlsWidth = await lab.locator('.cutting-controls').evaluate(element => element.getBoundingClientRect().width);
  await stage.getByRole('separator', { name: 'Resize scene width', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => lab.locator('.cutting-controls').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(oldControlsWidth);
  await stage.scrollIntoViewIfNeeded();
  const oldHeight = await stage.evaluate(element => element.getBoundingClientRect().height);
  const handle = stage.getByRole('separator', { name: 'Resize scene height', exact: true });
  await handle.focus(); await page.keyboard.press('ArrowDown');
  await expect.poll(() => stage.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(oldHeight);
  await stage.getByRole('button', { name: 'Scene full screen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('cutting-stage') ?? false)).toBe(true);
  const fullscreen = await stage.evaluate(element => ({ w: element.clientWidth, h: element.clientHeight, viewportW: innerWidth, viewportH: innerHeight }));
  expect(Math.abs(fullscreen.w - fullscreen.viewportW)).toBeLessThanOrEqual(1); expect(Math.abs(fullscreen.h - fullscreen.viewportH)).toBeLessThanOrEqual(1);
  const fullscreenSteps = (await diagnostic()).acceptedSteps;
  await stage.getByRole('button', { name: 'Resume simulation', exact: true }).click();
  await expect.poll(async () => (await diagnostic()).acceptedSteps).toBeGreaterThan(fullscreenSteps);
  await stage.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await expect.poll(async () => (await diagnostic()).workerStepInFlight).toBe(false);
  await expect(stage.getByText(/s physical time$/)).toBeVisible();
  await stage.getByRole('button', { name: 'Withdraw instrument', exact: true }).click();
  await expect(stage.getByRole('button', { name: 'Pause simulation', exact: true })).toBeVisible();
  await stage.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await expect.poll(async () => (await diagnostic()).workerStepInFlight).toBe(false);
  await stage.getByRole('button', { name: 'Exit scene full screen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(lab.getByText('Withdrawing the blade before removing contact.', { exact: true })).toBeVisible();
  const fullscreenWithdrawal = await exported('fullscreen-withdrawal');
  expect(fullscreenWithdrawal.scalpel.target.active).toBe(true);
  expect(fullscreenWithdrawal.scalpel.target.tipYMm).not.toBe(initial.scalpel.target.tipYMm);
  check('200% text scales labels; width and height resize; fullscreen retains clock, Pause and Withdraw controls');

  // Retain the old canvas handle to verify teardown removes its registration,
  // even though the visible DOM no longer contains that canvas.
  await button('Video recorder').click();
  await expect(page.getByText('Current source:', { exact: true }).locator('..')).toContainText('Liver cohesive cutting');
  await page.getByRole('button', { name: 'Close video recorder', exact: true }).click();
  const retiredCanvas = await canvas.elementHandle();
  const retiredIds = (await audit()).workers.filter(w => w.cutting && !w.terminated).map(w => w.id);
  expect(retiredIds.length).toBe(1); await button('Recorded experiments').click();
  await expect(host).toHaveCount(0);
  await expect.poll(async () => (await audit()).workers.filter(w => retiredIds.includes(w.id)).every(w => w.terminated > 0)).toBe(true);
  expect(await retiredCanvas.evaluate(element => ({ connected: element.isConnected, source: element.dataset.sceneRecordingSource, active: element.dataset.sceneRecordingActive }))).toEqual({ connected: false, source: undefined, active: undefined });
  await retiredCanvas.dispose();
  // Recorded experiments legitimately creates its own native playback canvas.
  // It must replace the retired cutting source rather than leave it selectable.
  const replacementCanvas = lab.locator('canvas[data-scene-recording-label="Liver physics playback"]');
  await expect(replacementCanvas).toHaveCount(1);
  await expect(replacementCanvas).toHaveAttribute('data-scene-recording-source', 'native');
  await expect(lab.locator('canvas[data-scene-recording-label="Liver cohesive cutting"]')).toHaveCount(0);
  await button('Video recorder').click();
  const sourceLabel = page.getByText('Current source:', { exact: true }).locator('..');
  await expect(sourceLabel).toContainText('Liver physics playback');
  await expect(sourceLabel).not.toContainText('Liver cohesive cutting');
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close video recorder', exact: true }).click();
  check('Leaving cutting terminates its worker and unregisters its canvas; recorder selects the replacement playback source');

  await page.evaluate(() => { window.__cuttingControlAudit.failNextCuttingInit = true; });
  await button('Scalpel & fracture').click(); await ready(false);
  await expect(lab.getByRole('alert')).toContainText('The cutting worker stopped. Reset the experiment to restore it.');
  for (const name of ['Cut', 'Run demonstration', 'Resume']) await expect(button(name)).toBeDisabled();
  expect((await audit()).injected).toBe(1); expect((await audit()).failNextCuttingInit).toBe(false);
  await button('Reset liver').click(); await expect(lab.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await audit()).workers.filter(w => w.cutting && !w.terminated).length).toBe(1);
  await ready(); await expect(button('Resume')).toBeEnabled();
  await canvas.focus(); await page.keyboard.press('Space');
  await expect.poll(async () => (await diagnostic()).acceptedSteps, { timeout: 90000 }).toBeGreaterThan(0);
  await settlePaused(); const recovered = await exported('worker-init-recovered');
  expect(recovered.metrics.minimumJacobian).toBeGreaterThan(0); expect(recovered.metrics.lastError).toBe('');
  expect((await audit()).injected).toBe(1);
  check('Exactly one injected init failure is visible; Reset creates a real worker and resumes accepted mechanics');

  const beforeStepFailure = await exported('before-mid-step-failure');
  const runningWorkerId = (await audit()).workers.find(worker => worker.cutting && !worker.terminated)?.id;
  expect(runningWorkerId).toBeDefined();
  await page.evaluate(() => { window.__cuttingControlAudit.failNextCuttingStep = true; });
  await button('Resume').click();
  await expect(lab.getByRole('alert')).toContainText('The cutting worker stopped. Reset the experiment to restore it.');
  await expect.poll(async () => (await audit()).stepInjected).toBe(1);
  await expect.poll(async () => (await diagnostic()).workerReady).toBe(false);
  await expect.poll(async () => (await diagnostic()).workerStepInFlight).toBe(false);
  for (const name of ['Cut', 'Run demonstration', 'Resume', 'Withdraw blade']) await expect(button(name)).toBeDisabled();
  const failureAudit = await audit(), stepFailure = failureAudit.stepFailures[0];
  expect(failureAudit.failNextCuttingStep).toBe(false);
  expect(stepFailure.workerId).toBe(runningWorkerId);
  expect(stepFailure.pendingBeforeError).toContain(stepFailure.requestId);
  expect(failureAudit.workers.find(worker => worker.id === runningWorkerId).terminated).toBe(1);
  expect(failureAudit.workers.filter(worker => worker.cutting && !worker.terminated)).toHaveLength(0);
  const interrupted = await exported('mid-step-failure');
  expect(interrupted.workerReady).toBe(false);
  expect(interrupted.metrics).toEqual(beforeStepFailure.metrics);
  expect(interrupted.nodePositionsMm).toEqual(beforeStepFailure.nodePositionsMm);
  expect(interrupted.damage).toEqual(beforeStepFailure.damage);
  expect(interrupted.scalpel.accepted).toEqual(beforeStepFailure.scalpel.accepted);
  await button('Reset liver').click(); await ready();
  await expect(lab.getByRole('alert')).toHaveCount(0); await expect(button('Resume')).toBeEnabled();
  const replacementWorkers = (await audit()).workers.filter(worker => worker.cutting && !worker.terminated);
  expect(replacementWorkers).toHaveLength(1); expect(replacementWorkers[0].id).not.toBe(runningWorkerId);
  const resetAfterFailure = await exported('mid-step-reset');
  expect(resetAfterFailure.metrics.timeSeconds).toBe(0); expect(resetAfterFailure.metrics.acceptedSteps).toBe(0);
  await button('Resume').click();
  await expect.poll(async () => (await diagnostic()).acceptedSteps, { timeout: 90000 }).toBeGreaterThan(0);
  await settlePaused(); const stepRecovered = await exported('worker-step-recovered');
  expect(stepRecovered.workerReady).toBe(true); expect(stepRecovered.metrics.minimumJacobian).toBeGreaterThan(0);
  expect(stepRecovered.metrics.lastError).toBe(''); expect(stepRecovered.metrics.rejectedSteps).toBe(0);
  expect((await audit()).stepInjected).toBe(1); expect((await audit()).injected).toBe(1);
  check('A real outstanding step can fail without publishing partial state; readiness clears and Reset restores accepted mechanics', { failure: stepFailure });

  await page.screenshot({ path: path.join(out, 'final-ui.png'), fullPage: true });
  expect(report.errors).toEqual([]); expect(report.failedRequests).toEqual([]); report.status = 'PASS';
} catch (error) {
  report.failure = String(error); console.error(error);
  report.layoutFailure = await page.evaluate(() => ({width:innerWidth,root:document.documentElement.scrollWidth,clipped:[...document.querySelectorAll('*')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent?.slice(0,100),width:e.clientWidth,scroll:e.scrollWidth})),overflow:[...document.querySelectorAll('*')].flatMap(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1)?[{tag:e.tagName,cls:e.className,text:(e.textContent??'').slice(0,100),x:r.x,width:r.width,right:r.right}]:[]}).slice(0,40)})).catch(()=>null); process.exitCode = 1;
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  report.workerAudit = await audit().catch(() => null);
  report.finishedAt = new Date().toISOString();
  report.scope = 'Native UI/control/fault coverage, not a surgical realism or full mechanical validation claim.';
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); console.log(JSON.stringify({ out, status: report.status, failure: report.failure, checks: report.checks.length }));
}
