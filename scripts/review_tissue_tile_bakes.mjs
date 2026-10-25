/** Compare actual liver renders and UV atlases, including a previously active appearance model. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const out=process.env.TILE_BAKE_OUTPUT??'artifacts/tissue-tile-bake-2026-10-25/final';
const baseline=process.env.TILE_BAKE_BASELINE==='1';
const url=process.env.TISSUE_PRODUCTION_URL??'http://127.0.0.1:5191/tissues.html';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),report={url,baseline,cases:[],errors:[],comparisons:[]};
const hash=s=>createHash('sha256').update(s).digest('hex');
const host=()=>page.locator('[data-tissue-ready=true]');
const state=async()=>JSON.parse(await host().getAttribute('data-tissue-snapshot'));
page.on('pageerror',e=>report.errors.push(e.message));
page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/api.json'))report.errors.push(`${r.status()} ${r.url()}`)});
async function capture(name,time){
 const data=await host().evaluate((el,time)=>el.captureTissueFrame(960,720,time),time);
 await writeFile(`${out}/${name}.png`,Buffer.from(data.split(',')[1],'base64'));
 return {hash:hash(data),data};
}
async function difference(a,b){return page.evaluate(async([a,b])=>{
 const pixels=async src=>{const img=new Image();img.src=src;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
 const x=await pixels(a),y=await pixels(b);let sum=0,count=0,changed=0;
 for(let i=0;i<x.length;i+=4){if(Math.max(x[i],x[i+1],x[i+2],y[i],y[i+1],y[i+2])<28)continue;count++;const d=(Math.abs(x[i]-y[i])+Math.abs(x[i+1]-y[i+1])+Math.abs(x[i+2]-y[i+2]))/3;sum+=d;if(d>2)changed++;}
 return {meanAbsoluteByteDifference:sum/Math.max(1,count),changedForegroundFraction:changed/Math.max(1,count),foregroundPixels:count};
},[a,b]);}
try{
 await page.goto(url);await expect(host()).toBeVisible();
 await page.getByRole('button',{name:'Use generative models',exact:true}).click();
 await expect.poll(async()=>(await state()).appearance?.evidence).toBe('exemplar_fitted');
 const response=await page.request.get(new URL('tissue-materials/catalog.json',url).href);const catalog=await response.json();
 const tiles=catalog.materials.filter(e=>e.family==='liver'&&e.group&&e.group!=='Authored library');
 const sequence=baseline?tiles.slice(0,2):[...tiles,tiles[0]];const renders=[];
 for(const [index,tile] of sequence.entries()){
  const options=page.getByLabel('Tissue region',{exact:true});
  await page.locator('.tissue-learned-tile').nth(tiles.indexOf(tile)).click();
  await expect(options).toHaveValue(tile.id);await expect(host()).toBeVisible();
  await expect(page.locator('.tissue-loading')).toHaveCount(0);
  await page.getByRole('button',{name:/^(Bake onto|Baked on) 3D liver mesh/}).click();
  await expect.poll(async()=>(await state()).organBake?.organ).toBe('liver');
  if(baseline)await expect.poll(async()=>(await state()).appearance?.evidence).toBe('exemplar_fitted');
  await page.getByLabel('Wet coat',{exact:true}).fill('0.65');
  const snapshot=await state();
  if(!baseline)expect(snapshot.appearance).toBeNull();
  const atlas=await page.getByRole('img',{name:'Baked liver albedo UV atlas',exact:true}).getAttribute('src');
  await writeFile(`${out}/tile-${index}-atlas.png`,Buffer.from(atlas.split(',')[1],'base64'));
  const frames=[];
  for(const time of baseline?[0]:[0,6,12])frames.push(await capture(`tile-${index}-angle-${time}`,time));
  if(!baseline){
   await page.getByLabel('Surface study',{exact:true}).selectOption('albedo');
   for(const time of [0,6,12])frames.push(await capture(`tile-${index}-albedo-${time}`,time));
   await page.getByLabel('Surface study',{exact:true}).selectOption('lit');
  }
  renders.push(frames);report.cases.push({id:tile.id,label:tile.label,atlasHash:hash(atlas),frames:frames.map(({hash})=>hash),snapshot});
 }
 for(let i=1;i<sequence.length;i++)for(let angle=0;angle<renders[i].length;angle++){
  const replay=i===tiles.length;const metrics=await difference(renders[replay?0:i-1][angle].data,renders[i][angle].data);
  report.comparisons.push({from:replay?0:i-1,to:i,angle,study:angle<3?'lit':'albedo',replay,...metrics});
  if(!baseline){if(replay)expect(metrics.meanAbsoluteByteDifference).toBe(0);else{// Dim side views attenuate visible differences; unlit renders verify the full texture.
   expect(metrics.meanAbsoluteByteDifference).toBeGreaterThan(angle===0||angle>=3?1:.25);expect(metrics.changedForegroundFraction).toBeGreaterThan(angle===0||angle>=3?.1:.02);}}
 }
 if(!baseline){expect(new Set(report.cases.slice(0,8).map(c=>c.atlasHash)).size).toBe(8);expect(report.errors).toEqual([]);}
 report.passed=!baseline;
}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,comparisons:report.comparisons,errors:report.errors}));
