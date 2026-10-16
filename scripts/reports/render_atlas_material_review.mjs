/** Actual Studio renderer, fixed geometry/camera, 12 organ families × 4 materials. */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const base=args.get('--base-url')??'http://127.0.0.1:5174';
const out=path.resolve(args.get('--out')??'benchmarks/results/material-v2-visual');
await fs.mkdir(path.join(out,'images'),{recursive:true});
const catalog=await (await fetch(`${base}/api/atlas/catalog`)).json();
if(!catalog.materials?.organ_presets)throw new Error('Material catalog unavailable');
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({status:'INCOMPLETE',started_at:new Date().toISOString(),records:[]},null,2));
const browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-gl=angle','--use-angle=metal']:[]});
let page;const errors=[],records=[];const started=Date.now();
async function fresh(){await page?.close();page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});page.setDefaultTimeout(120000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(`${base}/atlas-witness.html`);await page.waitForFunction(()=>Boolean(window.atlasWitness?.captureHero));}
async function capture(organ,spec,geometryHash,label,size,group){
 const rendered=await page.evaluate(async({spec,geometryHash,size})=>{const witness=await window.atlasWitness.render(spec,geometryHash);const hero=await window.atlasWitness.captureHero('oblique',size,size);const {png:discard,...metadata}=witness;return {png:hero.png,view:hero.view,...metadata};},{spec,geometryHash,size});
 if(rendered.renderer_version!=='atlas-neutral-inspection-material-2.0.0')throw new Error('Material preview did not use the versioned fragment shader');
 const bytes=Buffer.from(rendered.png.split(',')[1],'base64');const image=`images/${organ.id}-${label}.png`;
 await fs.writeFile(path.join(out,image),bytes);
 const {png,...metadata}=rendered;records.push({organ:organ.id,label,group,...metadata,image,image_sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 console.log(JSON.stringify({organ:organ.id,label,size,completed:records.length}));
}
try{
 for(const organ of catalog.organs){
  await fresh();const template=organ.templates[0];
  const baseSpec={template_id:template.id,seed:42,controls:Object.fromEntries(catalog.controls.map(c=>[c.key,0])),appearance:'tissue'};
  const response=await fetch(`${base}/api/atlas/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(baseSpec)});
  if(!response.ok)throw new Error(await response.text());
  const reference=await response.json(),geometryHash=reference.scene.metadata.geometry_sha256;
  for(const preset of catalog.materials.presets){
   const material={...catalog.materials.organ_presets[organ.id][preset.id].recipe,seed:42};
   await capture(organ,{...baseSpec,material},geometryHash,preset.id,512,'preset_grid');
  }
  if(['liver','pancreas'].includes(organ.id)){
   const material={...catalog.materials.organ_presets[organ.id].balanced.recipe,seed:42};
   for(const [label,patch]of [['fine-0',{fine_detail:0}],['fine-1',{fine_detail:1}],['seed-0',{seed:0}],['seed-max',{seed:4294967295}]])
    await capture(organ,{...baseSpec,material:{...material,...patch}},geometryHash,label,1024,'detail_and_seed');
  }
 }
 const manifest={status:errors.length?'FAIL':'PASS',created_at:new Date().toISOString(),catalog_release:catalog.release,material_version:catalog.materials.version,renderer_version:'atlas-neutral-inspection-material-2.0.0',fixed_shape_seed:42,shape_controls:'zero identity',poses:['oblique'],preset_views:records.filter(r=>r.group==='preset_grid').length,detail_seed_views:records.filter(r=>r.group==='detail_and_seed').length,browser_errors:errors,elapsed_seconds:(Date.now()-started)/1000,scope:'Actual procedural fragment shader; authored appearance, not measured tissue architecture',records};
 if(manifest.preset_views!==48||manifest.detail_seed_views!==8)throw new Error('Incomplete material coverage');
 await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
 if(errors.length)throw new Error(errors.join('\n'));
 console.log(JSON.stringify({status:manifest.status,views:records.length,elapsed_seconds:manifest.elapsed_seconds,out}));
}catch(error){
 await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({status:'FAIL',error:error.message,browser_errors:errors,records},null,2));
 throw error;
}finally{await browser.close();}
