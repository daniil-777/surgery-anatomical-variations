import {chromium} from '@playwright/test';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-gl=angle','--use-angle=metal']});
const errors=[],results=[];
try{for(const mode of ['scene','imports']){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${process.env.REVIEW_URL ?? "http://127.0.0.1:5177/"}?mode=${mode}`);
 if(mode==='scene')await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'));
 else{await page.getByRole('button',{name:'Laparoscopic abdomen (24 structures)',exact:true}).click();await page.getByRole('button',{name:'Scope: Under the liver',exact:true}).waitFor({timeout:120000});}
 await page.getByRole('button',{name:mode==='scene'?'Under the liver':'Scope: Under the liver',exact:true}).last().click();
 const read=()=>page.evaluate(mode=>mode==='scene'?JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation:JSON.parse(document.querySelector('[data-operative-scope]').dataset.operativeScope),mode);
 await page.waitForFunction(mode=>mode==='scene'?JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation.mode==='explore':JSON.parse(document.querySelector('[data-operative-scope]')?.dataset.operativeScope??'{}').active,mode);
 const initial=await read(),start=initial.positionMm??initial.position;
 const button=page.getByRole('button',{name:mode==='scene'?'Move camera back':'back',exact:true});await button.click();
 await page.waitForFunction(({mode,start})=>{const s=mode==='scene'?JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation:JSON.parse(document.querySelector('[data-operative-scope]').dataset.operativeScope);return Math.hypot(...(s.positionMm??s.position).map((v,i)=>v-start[i]))>1;},{mode,start});
 const back=await read();
 // A deliberately long sequence must stop at a visible surface, never tunnel through.
 const forward=page.getByRole('button',{name:mode==='scene'?'Move camera forward':'forward',exact:true});for(let i=0;i<25;i++)await forward.click();
 const stop=await read();for(let i=0;i<3;i++)await forward.click();const still=await read();
 const a=stop.positionMm??stop.position,b=still.positionMm??still.position;if(Math.hypot(...a.map((v,i)=>v-b[i]))>.1)throw new Error(`${mode}: camera did not stop at tissue`);
 await button.click();const canvas=page.locator(mode==='scene'?'.whole-scene-canvas canvas':'.import-viewport canvas');await canvas.focus();await page.keyboard.press('Escape');
 await page.waitForFunction(mode=>mode==='scene'?JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation.mode==='orbit':!JSON.parse(document.querySelector('[data-operative-scope]').dataset.operativeScope).active,mode);
 results.push({mode,initial,back,stop,exit:true});await page.close();
}if(errors.length)throw new Error(errors.join('\n'));console.log(JSON.stringify({results,errors},null,2));}finally{await browser.close();}
