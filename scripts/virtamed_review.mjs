import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.env.REVIEW_OUTPUT??'/tmp/virtamed-review/pass-2');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
const context=await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:1.5,recordVideo:{dir:path.join(out,'motion'),size:{width:1600,height:1100}}});
const page=await context.newPage(),errors=[],requests=[],cases=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
page.on('response',r=>{if(r.status()>=400)requests.push({url:r.url(),status:r.status()});});
const snapshot=()=>page.evaluate(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const capture=async name=>{await settle();await page.locator('.whole-scene-canvas').screenshot({path:path.join(out,`${name}.png`)});cases.push({name,snapshot:await snapshot()});};
const click=async name=>{await page.getByRole('button',{name,exact:true}).click();await settle();};
try {
  await page.goto(`${process.env.REVIEW_URL??'http://127.0.0.1:5177/'}?mode=scene&scene=virtamed`);
  await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
  await capture('01-white');const white=await snapshot();
  await click('Apply learned textures');await capture('02-tissue');const tissue=await snapshot();
  if(white.organs.some((p,i)=>p.geometrySignature!==tissue.organs[i].geometrySignature))throw new Error('Texture switch changed geometry');
  const canvas=page.locator('.whole-scene-canvas canvas'),box=await canvas.boundingBox();
  for(const [name,dx,dy] of [['03-oblique-left',65,12],['04-oblique-right',-125,-20]]){
    await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+dx,box.y+box.height*.48+dy,{steps:18});await page.mouse.up();await page.waitForTimeout(500);await capture(name);
  }
  await click('Video camera · instruments enabled');
  await page.getByRole('textbox',{name:'Scene seed',exact:true}).fill('319');
  const severity=page.getByRole('slider',{name:'Disease appearance',exact:true});await severity.press('End');for(let i=0;i<4;i++)await severity.press('ArrowLeft');
  for(const condition of ['gallbladder-cholecystitis','gallbladder-distension','liver-steatotic-enlargement','liver-cirrhosis','liver-metastases']){
    await page.getByRole('combobox',{name:'Disease variation',exact:true}).selectOption(condition);
    await click('Video camera · instruments enabled');await click('Replay seed');await capture(`05-${condition}-front`);
    const a=await snapshot();await click('Replay seed');const b=await snapshot();
    if(a.organs.some((p,i)=>p.geometrySignature!==b.organs[i].geometrySignature||p.materialSignature!==b.organs[i].materialSignature))throw new Error('Seed replay drift');
    if(a.severity<.75)throw new Error('High-severity review was not applied');
    if(a.videoReconstruction.interfaces.edges.length!==5||!a.videoReconstruction.interfaces.covers.length)throw new Error('Missing tissue transition fields');
    for(const [angle,dx,dy] of [['left',65,12],['right',-125,-20]]){
      await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+dx,box.y+box.height*.48+dy,{steps:18});await page.mouse.up();await page.waitForTimeout(550);await capture(`05-${condition}-${angle}`);
    }
    await click('Video camera · instruments enabled');await page.mouse.move(box.x+box.width*.55,box.y+box.height*.38);await page.mouse.wheel(0,-260);await page.waitForTimeout(600);await capture(`05-${condition}-close`);
  }
  await click('Restore video geometry');await click('Video camera · instruments enabled');
  await click('Apply learned physics to all organs');
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).physics?.running,{timeout:30000});
  // Disable breathing to isolate force response and recovery from respiratory loading.
  const breath=page.getByRole('checkbox',{name:/Breathing/});if(await breath.isChecked())await breath.uncheck();
  await page.getByText('Explore the structures',{exact:false}).click();
  for(const [label,id,mode,angle] of [['Liver canopy','liver','Push',0],['Gallbladder','gallbladder','Grasp',0],['Connected fatty apron','hepatocystic-fat','Push',0],['Liver canopy','liver','Push',45],['Gallbladder','gallbladder','Grasp',45],['Connected fatty apron','hepatocystic-fat','Push',45],['Liver canopy','liver','Push',-45],['Gallbladder','gallbladder','Grasp',-45],['Connected fatty apron','hepatocystic-fat','Push',-45]]){
    await click('Camera');await click('Video camera · instruments enabled');if(angle){await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+angle,box.y+box.height*.49,{steps:14});await page.mouse.up();await page.waitForTimeout(600);}await click(label);await click(mode);
    await page.waitForFunction(id=>{const s=JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot);return s.tools?.pickCandidates?.some(p=>p.organId===id);},id,{timeout:15000});
    const before=await snapshot();
    // A visible point is not necessarily reachable by the finite instrument.
    // Keep obstruction guards enabled and try a different visible triangle.
    for(const candidate of before.tools.pickCandidates.filter(p=>p.organId===id)){
      if(!await page.evaluate(p=>document.elementFromPoint(p.clientX,p.clientY)===document.querySelector(".whole-scene-canvas canvas"),candidate))continue;
      await page.mouse.click(candidate.clientX,candidate.clientY);
      try{await page.waitForFunction(id=>{const s=JSON.parse(document.querySelector("[data-scene-snapshot]").dataset.sceneSnapshot);return s.tools.active&&s.tools.organId===id;},id,{timeout:3000});break;}catch{}
    }
    let engaged=await snapshot();if(!engaged.tools.active||engaged.tools.organId!==id)throw new Error(`No ${mode} contact on ${id}`);
    await click('Move deeper');await page.waitForTimeout(1600);await capture(`06-${id}-${mode.toLowerCase()}-${angle}`);
    const forced=await snapshot();if(!forced.physics.finite||forced.tools.reactionN>3.01||forced.tools.solverUploadGapMm>.02)throw new Error(`Invalid contact ${id}`);
    await click('Release instrument');await page.waitForTimeout(1800);await capture(`07-${id}-release-${angle}`);
    await click('Reset motion');
  }
  await click('Camera');await click('White geometry');await capture('08-white-after-physics');
  if(errors.length)throw new Error(errors.join('\n'));
  await page.screenshot({path:path.join(out,'ui.png')});
  await writeFile(path.join(out,'receipt.json'),JSON.stringify({cases,errors,requests},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),snapshot:await snapshot().catch(()=>null),cases,errors,requests},null,2));throw error;}
finally{await context.close();await browser.close();}
