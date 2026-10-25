import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.REVIEW_OUTPUT??'/tmp/virtamed-detail/pass-1';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
page.on('response',r=>{if(r.status()>=400)requests.push({url:r.url(),status:r.status()});});
try{
 await page.goto(process.env.REVIEW_URL??'http://127.0.0.1:5177/?mode=scene&scene=virtamed');await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
 const panel=page.locator('.whole-scene-canvas'),canvas=panel.locator('canvas'),box=await canvas.boundingBox();
 await panel.screenshot({path:`${out}/white.png`});await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();await page.waitForTimeout(1000);await panel.screenshot({path:`${out}/tissue.png`});
 for(const [name,dx,dy] of [['left',60,10],['right',-120,-20]]){await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+dx,box.y+box.height*.48+dy,{steps:18});await page.mouse.up();await page.waitForTimeout(700);await panel.screenshot({path:`${out}/${name}.png`});}
 const snap=await page.evaluate(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));await writeFile(`${out}/receipt.json`,JSON.stringify({errors,requests,snapshot:snap},null,2));if(errors.length)throw Error(errors.join('\n'));
}finally{await browser.close();}
