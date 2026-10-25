import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out=process.env.JOIN_OUTPUT??'/tmp/viscera-vessel-joins-review/current';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
const context=await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:1.5});
const page=await context.newPage(),errors=[],cases=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
const click=name=>page.getByRole('button',{name,exact:true}).click();
const snapshot=()=>page.evaluate(()=>window.__visceraSceneSnapshot());
const capture=async name=>{await page.waitForTimeout(600);await page.screenshot({path:path.join(out,`${name}.png`)});cases.push({name,snapshot:await snapshot()});};
try {
 await page.goto(`${process.env.JOIN_URL??'http://127.0.0.1:5177/'}?mode=scene&scene=virtamed`);
 await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
 await capture('01-white');await click('Apply learned textures');await capture('02-operative');
 const box=await page.locator('.whole-scene-canvas canvas').boundingBox();
 for(const [name,dx,dy] of [['03-left',65,12],['04-right',-125,-20]]){
  await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+dx,box.y+box.height*.48+dy,{steps:18});await page.mouse.up();await capture(name);
 }
 for(const view of ['Front','Back','Left','Right','Top','Bottom','¾ view']){await page.locator('.whole-view-bar').getByRole('button',{name:view,exact:true}).click();await capture(`view-${view==='¾ view'?'three-quarter':view.toLowerCase()}`);}
 await click('Video camera · instruments enabled');
 await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.3+box.height*.47,box.y+box.height*.52,{steps:48});await page.mouse.up();await capture('06-posterior-lit');
 await page.mouse.move(box.x+box.width*.55,box.y+box.height*.45);await page.mouse.wheel(0,-180);await capture('07-posterior-close');
 await click('Video camera · instruments enabled');
 await page.mouse.move(box.x+box.width*.55,box.y+box.height*.38);await page.mouse.wheel(0,-260);await capture('05-close');
 if(errors.length)throw new Error(errors.join('\n'));
 await writeFile(path.join(out,'receipt.json'),JSON.stringify({url:page.url(),cases,errors},null,2));
} catch(e) {await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(e),errors,cases},null,2));throw e;}
finally{await context.close();await browser.close();}
