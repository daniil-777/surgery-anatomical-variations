/** Exercise actual wording/API/geometry integration; no network mocks. */
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.VISCERA_URL ?? 'http://127.0.0.1:5264';
const out = path.resolve(process.env.VISCERA_EVIDENCE ?? 'benchmarks/results/wording-v2-2026-10-07/browser');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-gl=angle', '--use-angle=metal'] : [] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, recordVideo: { dir: out, size: { width: 1600, height: 1100 } } });
const page = await context.newPage();
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().endsWith('/api/atlas/generate')) requests.push(request.postDataJSON()); });
async function responseTo(suffix, action) {
  const promise = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === 'POST');
  await action(); const response = await promise;
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function instruction(text) {
  await page.getByRole('textbox', { name: 'Describe an anatomy variation', exact: true }).fill(text);
  return responseTo('/api/atlas/compile', () => page.getByRole('button', { name: 'Apply text instruction', exact: true }).click());
}
try {
  await page.goto(base + '/?template=hra-liver-female');
  await expect(page.getByText('Reference geometry loaded', { exact: true })).toBeVisible({ timeout: 60000 });
  await page.getByRole('tab', { name: 'Disease', exact: true }).click();
  const initial = await responseTo('/api/atlas/generate', () => page.getByRole('combobox', { name: 'Disease profile', exact: true }).selectOption('liver-cirrhosis'));
  await expect(page.getByRole('button', { name: 'Export GLB', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(out, '01-before-healthier.png') });
  const generatedPromise = page.waitForResponse(r => r.url().endsWith('/api/atlas/generate') && r.request().method() === 'POST');
  const compiled = await instruction('Make the liver healthier');
  expect(compiled.status).toBe('accepted');
  const generated = await generatedPromise;
  expect(generated.status(), await generated.text()).toBe(200);
  const healthier = await generated.json();
  expect(healthier.spec.disease.severity).toBeCloseTo(initial.spec.disease.severity * .8, 7);
  expect(healthier.spec.disease.contrast).toBeCloseTo(initial.spec.disease.contrast * .8, 7);
  expect(healthier.spec.controls).toEqual(initial.spec.controls);
  expect(healthier.spec.disease.profile_id).toEqual(initial.spec.disease.profile_id);
  await expect(page.getByRole('button', { name: 'Export GLB', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(out, '02-healthier-applied.png') });
  const count = requests.length;
  const contradiction = await instruction('Make it healthier but do not change the disease');
  expect(['clarify', 'unsupported']).toContain(contradiction.status);
  await expect(page.getByRole('button', { name: 'Apply text instruction', exact: true })).toBeEnabled();
  expect(requests.length).toBe(count);
  const surgical = await instruction('Make it 5% wider and resect the left lobe');
  expect(surgical.status).toBe('unsupported');
  await expect(page.getByRole('button', { name: 'Apply text instruction', exact: true })).toBeEnabled();
  expect(requests.length).toBe(count);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(out, '03-atomic-unsupported.png') });
  const receipt = { base, initial: initial.spec, healthier: healthier.spec, compiled, contradiction, surgical, errors, partialEdits: false };
  await fs.writeFile(path.join(out, 'verification.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed: true, severityBefore: initial.spec.disease.severity, severityAfter: healthier.spec.disease.severity, errors, partialEdits: false }));
} finally {
  const video = page.video(); await context.close();
  if (video) await video.saveAs(path.join(out, 'wording-browser.webm'));
  await browser.close();
}
