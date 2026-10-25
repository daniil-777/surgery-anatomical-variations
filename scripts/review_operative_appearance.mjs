import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.env.OPERATIVE_REVIEW_OUTPUT??'/tmp/virtamed-operative/pass-1');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1.5});
const errors=[],requests=[],cases=[],frames=new Map();
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('Failed to load resource'))errors.push(m.text());});
page.on('response',r=>{if(r.status()>=400)requests.push({url:r.url(),status:r.status()});});
const snapshot=()=>page.evaluate(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function capture(name){await settle();const bytes=await page.locator('.whole-scene-canvas').screenshot({path:path.join(out,`${name}.png`)});frames.set(name,bytes.toString('base64'));cases.push({name,snapshot:await snapshot()});}
try{
  await page.goto(`${process.env.REVIEW_URL??'http://127.0.0.1:5177/'}?mode=scene&scene=virtamed`);
  await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
  await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();
  const residue=page.getByRole('slider',{name:'Operative residue',exact:true});
  for(const level of [0,50,100]){
    await residue.press('Home');for(let n=0;n<level/5;n++)await residue.press('ArrowRight');
    await page.getByRole('button',{name:'Video camera · instruments enabled',exact:true}).click();await page.waitForTimeout(650);
    await capture(`${level}-front`);
    const box=await page.locator('.whole-scene-canvas canvas').boundingBox();
    for(const [angle,dx] of [['left',65],['right',-125]]){
      await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+dx,box.y+box.height*.49,{steps:18});await page.mouse.up();await page.waitForTimeout(650);await capture(`${level}-${angle}`);
    }
  }
  const stats=await page.evaluate(async encoded=>{
    const images=await Promise.all(encoded.map(async bytes=>{const im=new Image();im.src='data:image/png;base64,'+bytes;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);return ctx.getImageData(0,0,c.width,c.height);}));
    const [a,b]=images;let changed=0,darkened=0,sum=0;
    for(let i=0;i<a.data.length;i+=4){const delta=[0,1,2].reduce((s,c)=>s+Math.abs(a.data[i+c]-b.data[i+c]),0);sum+=delta;if(delta>9)changed++;if(a.data[i]+a.data[i+1]+a.data[i+2]-b.data[i]-b.data[i+1]-b.data[i+2]>15)darkened++;}
    return {pixels:a.width*a.height,changed,darkened,meanAbsoluteRgbDifference:sum/(a.width*a.height*3)};
  },[frames.get('0-front'),frames.get('50-front')]);
  if(stats.changed<1000||stats.darkened<500)throw new Error('Operative layer did not visibly change the rendered surface');
  if(errors.length)throw new Error(errors.join('\n'));
  await writeFile(path.join(out,'receipt.json'),JSON.stringify({cases,errors,requests,stats},null,2));console.log(JSON.stringify(stats));
}catch(e){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(e),errors,requests,cases},null,2));throw e;}finally{await browser.close();}
