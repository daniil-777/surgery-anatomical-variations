/** Actual API/browser evidence. Run with VISCERA_URL and VISCERA_EVIDENCE overrides. */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const url=process.env.VISCERA_URL??'http://127.0.0.1:5174';
const out=path.resolve(process.env.VISCERA_EVIDENCE??'benchmarks/results/surface-authoring-2026-10-07');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-gl=angle','--use-angle=metal']:[]});
const context=await browser.newContext({viewport:{width:1600,height:1000},recordVideo:{dir:out,size:{width:1600,height:1000}}});
const page=await context.newPage();const errors=[];let specimen=null,exportBody=null;
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('response',async response=>{if(response.url().endsWith('/api/atlas/generate')&&response.ok())specimen=await response.json();});
page.on('request',request=>{if(request.url().endsWith('/api/atlas/export'))exportBody=request.postDataJSON();});
try {
 await page.goto(url);await page.getByText('Reference geometry loaded',{exact:true}).waitFor({timeout:90000});
 await page.getByRole('tab',{name:'Surface',exact:true}).click();
 await page.getByRole('button',{name:'Rich pigment surface preset',exact:true}).click();
 await page.getByText('Preview matches this surface',{exact:true}).waitFor();
 await page.getByRole('slider',{name:'Vessel branch density',exact:true}).fill('0.65');
 await page.getByRole('slider',{name:'Vessel visibility',exact:true}).fill('0.85');
 await page.waitForTimeout(1200);await page.screenshot({path:out+'/01-vessels.png'});
 await page.getByRole('checkbox',{name:'Show surface vessels',exact:true}).uncheck();await page.waitForTimeout(300);await page.screenshot({path:out+'/02-without-vessels.png'});
 await page.getByRole('checkbox',{name:'Show surface vessels',exact:true}).check();
 await page.getByRole('tab',{name:'Sculpt',exact:true}).click();
 await page.getByRole('slider',{name:'Sculpt influence radius',exact:true}).fill('65');
 await page.getByRole('slider',{name:'Sculpt tissue resistance',exact:true}).fill('0.15');
 await page.waitForTimeout(400);await page.screenshot({path:out+'/03-before-sculpt.png'});
 const box=await page.getByTestId('atlas-viewport').boundingBox();
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.45);await page.mouse.down();
 await page.mouse.move(box.x+box.width*.5+75,box.y+box.height*.45-40,{steps:30});
 await page.waitForTimeout(300);await page.mouse.up();await page.mouse.move(50,60);await page.waitForTimeout(700);
 if(!await page.getByRole('button',{name:'Undo sculpture',exact:true}).isEnabled())throw new Error('Real pointer drag did not create a sculpture.');
 await page.screenshot({path:out+'/04-sculpted.png'});const sculptStatus=await page.locator('.atlas-sculpt-report').innerText();
 await page.getByRole('button',{name:'Undo sculpture',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:out+'/05-undone.png'});
 await page.getByRole('button',{name:'Redo sculpture',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:out+'/06-redone.png'});
 for(const label of ['Front','Back','Top','¾ view']) {await page.getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:out+`/view-${label==='¾ view'?'oblique':label.toLowerCase()}.png`});}
 const began=Date.now(),downloadPromise=page.waitForEvent('download',{timeout:240000});await page.getByRole('button',{name:'Unity 4K',exact:true}).click();
 const download=await downloadPromise;await download.saveAs(out+'/sculpted-liver-vessels-unity-4k.zip');
 const exportMilliseconds=Date.now()-began;
 await fs.writeFile(out+'/export-request.json',JSON.stringify(exportBody));
 await fs.writeFile(out+'/source-specimen.json',JSON.stringify(specimen));
 await fs.writeFile(out+'/browser-verification.json',JSON.stringify({url,sculptStatus,errors,exportMilliseconds,textureResolution:exportBody?.texture_resolution,sculptedMeshes:exportBody?.surface_edits?.length,vesselNetworks:exportBody?.surface_vessels?.map(binding=>binding.network.statistics),downloadFailure:await download.failure(),videoReview:'Recorded full interaction; sampled screenshots inspect static stages, not every video frame.'},null,2));
 if(errors.length)throw new Error(errors.join('\n'));
 console.log(await fs.readFile(out+'/browser-verification.json','utf8'));
} finally {
 const video=page.video();await context.close();if(video)await video.saveAs(out+'/surface-authoring.webm');await browser.close();
}
