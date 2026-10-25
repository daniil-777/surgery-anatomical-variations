/** Focused visual evidence for default appearance and browser PBR generation. */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const out=process.env.TISSUE_REPAIR_OUTPUT??'artifacts/tissue-material-repair-2026-10-25/material-review';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],report={cases:[],errors};
page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
const host=()=>page.locator('[data-tissue-ready=true]');const state=async()=>JSON.parse(await host().getAttribute('data-tissue-snapshot'));
async function capture(name){await page.locator('.tissue-stage').screenshot({path:out+'/'+name+'.png'});report.cases.push({name,snapshot:await state()});}
try{
 await page.goto(process.env.TISSUE_PRODUCTION_URL??'http://127.0.0.1:5183/tissues.html');await host().waitFor({timeout:60000});
 await page.locator('.tissue-learned-gallery').scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.querySelectorAll('.tissue-learned-gallery img')].every(i=>i.complete&&i.naturalWidth===512));await page.screenshot({path:out+'/gallery.png'});
 const begin=performance.now();await page.getByRole('button',{name:'Use generative models',exact:true}).click();await page.locator('.tissue-model-panel').getByText(/Applied 512/).waitFor({timeout:60000});report.appearanceElapsedMs=performance.now()-begin;await capture('liver-42');
 await page.getByLabel('Appearance seed',{exact:true}).fill('43');await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-tissue-ready=true]')?.getAttribute('data-tissue-snapshot')??'{}').appearance?.seed==='43');await capture('liver-43');
 for(const light of ['grazing','camera']) {await page.getByLabel('Lighting',{exact:true}).selectOption(light);await capture('liver-light-'+light);}
 await page.getByRole('button',{name:'Use browser generator',exact:true}).click();const start=performance.now();
 await page.getByRole('button',{name:'Generate new tile',exact:true}).click();await page.getByRole('button',{name:'Return to tissue library'}).waitFor({timeout:60000});await host().waitFor();await capture('browser-bundle');report.bundleElapsedMs=performance.now()-start;
 for(const study of ['normal','roughness','albedo','lit']){await page.getByLabel('Surface study',{exact:true}).selectOption(study);await capture('browser-bundle-'+study);}
 const canvas=host().locator('canvas'),box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.55,{steps:30});await page.mouse.up();await capture('browser-bundle-oblique');
 for(const w of [375,768,1440]){await page.setViewportSize({width:w,height:1000});await page.screenshot({path:out+`/responsive-${w}.png`});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);report.cases.push({width:w,overflow});if(overflow)throw Error('Layout overflows at '+w);}
 if(errors.length)throw Error(errors.join('; '));report.passed=true;
}finally{await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({passed:report.passed,appearanceElapsedMs:report.appearanceElapsedMs,bundleElapsedMs:report.bundleElapsedMs,errors}));
