import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
const url = process.env.TISSUE_PRODUCTION_URL ?? './?mode=tissues';
const out = process.env.TISSUE_TEST_OUTPUT ?? 'artifacts/tissue-material-repair-2026-10-25/browser';
const host = (page: any) => page.locator('[data-tissue-ready=true]');
const state = async (page: any) => JSON.parse(await host(page).getAttribute('data-tissue-snapshot') ?? '{}');
test('all 48 gallery images decode and each organ receives the matching detailed model', async ({page}) => {
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
  await mkdir(out,{recursive:true});await page.goto(url);await expect(host(page)).toBeVisible();
  for(const organ of ['liver','spleen','stomach','pancreas','small_bowel','large_bowel']) {
    await page.getByLabel('Tissue region',{exact:true}).selectOption(organ);
    await expect.poll(async()=>(await state(page)).organ).toBe(organ);
    await page.locator('.tissue-learned-gallery').scrollIntoViewIfNeeded();
    await expect.poll(()=>page.locator('.tissue-learned-gallery img').evaluateAll(imgs=>imgs.filter(i=>(i as HTMLImageElement).complete&&(i as HTMLImageElement).naturalWidth===512).length)).toBe(8);
    await page.getByRole('button',{name:'Use generative models',exact:true}).click();
    await expect.poll(async()=>(await state(page)).appearance?.region).toBe(organ);
    await expect.poll(async()=>(await state(page)).appearance?.resolution).toBe(512);
    await page.locator('.tissue-stage').screenshot({path:`${out}/${organ}-learned.png`});
  }
  expect(errors).toEqual([]);
});
test('old saved smoke-test weights cannot restore the washed-out appearance',async({page})=>{
  await page.goto(url);await expect(host(page)).toBeVisible();
  const old=await readFile('apps/studio/public/tissue-models/spatial-v3-laparoscopic.tissue-model.json','utf8');
  await page.evaluate(async source=>{await new Promise<void>((resolve,reject)=>{const request=indexedDB.open('viscera-tissue-appearance-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('models');request.onsuccess=()=>{const db=request.result,tx=db.transaction('models','readwrite');tx.objectStore('models').put(source,'active');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error)};request.onerror=()=>reject(request.error)});},old);
  await page.reload();await expect(host(page)).toBeVisible();
  await expect(page.getByText(/An early test model was saved here/)).toBeVisible();
  expect((await state(page)).appearance).toBeNull();
  await page.getByRole('button',{name:'Use generative models',exact:true}).click();
  await expect.poll(async()=>(await state(page)).appearance?.evidence).toBe('exemplar_fitted');
  await page.reload();await expect.poll(async()=>(await state(page)).appearance?.evidence).toBe('exemplar_fitted');
});
test('browser generation produces a verified native-512 bundle and cancellation preserves it',async({page})=>{
  await page.goto(url);await expect(host(page)).toBeVisible();
  await page.getByRole('button',{name:'Use browser generator',exact:true}).click();
  await page.getByRole('button',{name:'Generate new tile',exact:true}).click();
  await expect(page.getByRole('button',{name:'Return to tissue library'})).toBeVisible();await expect(host(page)).toBeVisible();
  const first=await state(page);expect(first.resolution).toEqual([512,512]);expect(first.importedMaterial.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole('button',{name:'Generate new tile',exact:true}).click();
  await page.locator('.tissue-generator').getByRole('button',{name:'Cancel generation',exact:true}).click();
  await expect(page.locator('.tissue-generator').getByText('Cancelled. The current material is unchanged.')).toBeVisible();
  expect((await state(page)).importedMaterial.bundleSha256).toBe(first.importedMaterial.bundleSha256);
});
