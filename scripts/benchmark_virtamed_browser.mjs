import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const out=process.env.BENCH_OUTPUT??'/tmp/virtamed-performance/baseline';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
try{
 const context=await browser.newContext({viewport:{width:1600,height:1100}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
 await page.goto(`${process.env.BENCH_URL??'http://127.0.0.1:5177/'}?mode=scene&scene=virtamed`);
 await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
 const snapshot=()=>page.evaluate(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 const runs=[];
 async function measure(name){
  await page.waitForTimeout(2000);const before=await snapshot(),cpuBefore=await metrics();
  const frames=await page.evaluate(()=>new Promise(resolve=>{const samples=[];let start,previous;function frame(t){if(start===undefined)start=t;else samples.push(t-previous);previous=t;if(t-start>=8000)resolve(samples);else requestAnimationFrame(frame);}requestAnimationFrame(frame);}));
  const after=await snapshot(),cpuAfter=await metrics(),sorted=[...frames].sort((a,b)=>a-b),seconds=(after.wall_time_ms-before.wall_time_ms)/1000;
  runs.push({name,frameMs:{p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)]},rafFps:1000/(frames.reduce((a,b)=>a+b,0)/frames.length),renderFps:(after.renderedFrames-before.renderedFrames)/seconds,surfaceUpdateHz:after.rendering.geometryUploads===undefined?null:(after.rendering.geometryUploads-before.rendering.geometryUploads)/seconds,surfaceWorkMs:after.rendering.surfaceCpuMs-before.rendering.surfaceCpuMs,solverWorkMs:after.rendering.solverCpuMs-before.rendering.solverCpuMs,mainThreadSeconds:cpuAfter.TaskDuration-cpuBefore.TaskDuration,scriptSeconds:cpuAfter.ScriptDuration-cpuBefore.ScriptDuration,heapBytes:cpuAfter.JSHeapUsedSize,physicsAdvancedSeconds:(after.physics?.time_s??0)-(before.physics?.time_s??0),droppedSeconds:(after.physics?.dropped_time_s??0)-(before.physics?.dropped_time_s??0),before,after});
  await page.locator('.whole-scene-canvas').screenshot({path:`${out}/${name}.png`});
 }
 await click('Apply learned textures');await measure('idle');
 await click('Apply learned physics to all organs');await measure('breathing');
 await page.getByRole('checkbox',{name:/Breathing/}).uncheck();await page.getByText('Explore the structures',{exact:false}).click();await click('Liver canopy');await click('Grasp');
 await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).tools?.pickCandidates?.length);
 for(const p of (await snapshot()).tools.pickCandidates){if(!await page.evaluate(p=>document.elementFromPoint(p.clientX,p.clientY)===document.querySelector('.whole-scene-canvas canvas'),p))continue;await page.mouse.click(p.clientX,p.clientY);try{await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).tools.active,{timeout:2000});break;}catch{}}
 if(!(await snapshot()).tools.active)throw new Error('No benchmark contact');await click('Move deeper');await measure('held-grasp');await click('Release instrument');await measure('recovery');
 if(errors.length)throw new Error(errors.join('\n'));
 await writeFile(`${out}/receipt.json`,JSON.stringify({url:page.url(),viewport:{width:1600,height:1100},runs,errors},null,2));console.log(JSON.stringify(runs.map(({before,after,...r})=>r),null,2));
}finally{await browser.close();}
