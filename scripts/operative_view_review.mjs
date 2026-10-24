import { chromium } from '@playwright/test';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve(process.env.REVIEW_OUTPUT ?? 'artifacts/operative-2026-10-24/pass-2');
if((await readdir(output).catch(()=>[])).length)throw new Error('Use a new empty review directory');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-gl=angle','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[],cases=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error' && /THREE.WebGLProgram|Shader Error/.test(m.text()))errors.push(m.text());});
const base=process.env.REVIEW_URL??'http://127.0.0.1:5176/';
const modes=(process.env.REVIEW_MODES??'scene,imports').split(',');
try {
for(const mode of modes){
 await page.goto(`${base}?mode=${mode}`);
 if(mode==='scene')await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
 else {await page.getByRole('button',{name:'Laparoscopic abdomen (24 structures)',exact:true}).click();await page.getByRole('button',{name:'Generate scene variation',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.import-inspector button.import-primary')?.disabled,{timeout:120000});await page.getByRole('button',{name:'Scope: Under the liver',exact:true}).waitFor({state:'visible'});}
 for(const label of ['Under the liver','Stomach & spleen','Bowel & mesentery']){
   await page.getByRole('button',{name:mode==='imports'?`Scope: ${label}`:label,exact:true}).last().click({timeout:120000});
   await page.waitForFunction(mode=>mode==='imports'?JSON.parse(document.querySelector('[data-operative-scope]')?.dataset.operativeScope??'{}').fat==='ready':JSON.parse(document.querySelector('[data-scene-snapshot]')?.dataset.sceneSnapshot??'{}').fat?.status==='ready',mode,{timeout:120000});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   if(mode==='scene'){const collapse=page.getByRole('button',{name:'Collapse camera controls',exact:true});if(await collapse.count())await collapse.click();}
   const read=()=>page.evaluate(mode=>{const host=document.querySelector(mode==='imports'?'[data-operative-scope]':'[data-scene-snapshot]');const s=JSON.parse(host.getAttribute(mode==='imports'?'data-operative-scope':'data-scene-snapshot'));return mode==='imports'?s:{camera:s.camera,inspection:s.inspection,fat:s.fat.status,triangles:s.organs.reduce((a,p)=>a+p.triangles,0)};},mode);
   cases.push({mode,label,pose:await read()});
   await page.screenshot({path:path.join(output,`${mode}-${label.replaceAll(' ','-').replaceAll('&','and')}.png`)});
   const canvas=page.locator(mode==='imports'?'.import-viewport canvas':'.whole-scene-canvas canvas');
   // Genuine changed camera angle, preserving all rendered tissue.
   const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.55);await page.mouse.down();await page.mouse.move(box.x+box.width*.7+70,box.y+box.height*.55-22,{steps:8});await page.mouse.up();
   await page.screenshot({path:path.join(output,`${mode}-${label.replaceAll(' ','-').replaceAll('&','and')}-oblique.png`)});
   cases.push({mode,label,oblique:await read()});
 }
 if(mode==='imports'){await page.getByRole('button',{name:'Return to overview',exact:true}).click();const s=await page.locator('[data-operative-scope]').getAttribute('data-operative-scope');if(JSON.parse(s).active)throw new Error('Import scope did not exit');}
 else{await page.getByRole('button',{name:'Exit interior exploration',exact:true}).click();await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation.mode==='orbit');}
}
if(errors.length)throw new Error(errors.join('\n'));
await writeFile(path.join(output,'receipt.json'),JSON.stringify({base,cases,errors},null,2));
} catch(error){await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),cases,errors},null,2));throw error;}finally{await browser.close();}
