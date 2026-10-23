#!/usr/bin/env node
// Native Chrome/Metal validation of the public cutting UI. No product test hook.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {capturePublicBuildSources} from './stage_public_assets.mjs';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'artifacts/cutting-2026-10-20', `native-${Date.now()}`);
await fs.mkdir(out, {recursive:true});
const targetUrl=process.env.CUTTING_URL ?? 'http://127.0.0.1:5174/';
const staticConfig=process.env.CUTTING_STATIC_COPY==='1'?await fetch(new URL('api.json',targetUrl)).then(r=>{if(!r.ok)throw new Error('Static API configuration unavailable');return r.json();}):null;
if(staticConfig&&staticConfig.api!==null)throw new Error('Offline health expectation requires explicit api:null');
const expectedHealth=location=>Boolean(staticConfig)&&location===new URL('api/health',targetUrl).href;
// Test implementations are verified separately; they are not loaded by Studio.
// Runtime, shaders, build configuration and cutting assets must remain frozen.
const sources=async()=>[...capturePublicBuildSources(root).filter(entry=>! /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.path)),...await Promise.all(['apps/studio/public/cutting/liver-reference.json','apps/studio/public/models/cutting-v1/model.json'].map(async file=>({path:file,sha256:createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')})))];
const report = {out, startedAt:new Date().toISOString(), errors:[], failedRequests:[], expectedOfflineProbes:[], expectedOfflineConsole:[], observations:[], checks:[], sourceBefore:await sources(), clinicalRealismCertified:false, realTimeClaim:false};
const browser = await chromium.launch({headless:true, handleSIGINT:false, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--use-gl=angle','--use-angle=metal']});
let abortRequested=false;process.once('SIGINT',()=>{abortRequested=true;});
const page = await browser.newPage({viewport:{width:1600,height:1100}, deviceScaleFactor:1, acceptDownloads:true});
page.setDefaultTimeout(45000);
// Read-only recorder of actual worker responses. It neither replaces messages
// nor changes solver state. A separate replay uses accepted physical timestamps.
await page.addInitScript(() => {
  const NativeWorker=window.Worker;
  window.__acceptedCuttingFrames=[];
  window.Worker=class extends NativeWorker {
    constructor(...args){super(...args);this.cutting=false;this.addEventListener('message',event=>{
      const d=event.data;if(!this.cutting||!d.accepted||!d.metrics||!d.positionsMm)return;
      const frames=window.__acceptedCuttingFrames,t=d.metrics.timeSeconds,last=frames.at(-1);
      if(last&&t<last.timeSeconds)frames.length=0;
      const prior=frames.at(-1);
      if(!prior||t-prior.timeSeconds>=1/30-1e-10||d.pose.active!==prior.scalpelPose.active){
        frames.push({timeSeconds:t,nodePositionsMm:Array.from(d.positionsMm),damage:Array.from(d.damage),scalpelPose:{...d.pose},metrics:structuredClone(d.metrics)});
      }
    });}
    postMessage(message,...options){if(message?.action==='init'&&message.reference?.schema==='viscera.cutting-reference/v1')this.cutting=true;return super.postMessage(message,...options);}
  };
});

page.on('pageerror', error=>report.errors.push(String(error)));
page.on('console', msg=>{if(msg.type()==='error'){if(expectedHealth(msg.location().url))report.expectedOfflineConsole.push(msg.text());else report.errors.push(msg.text());}});
page.on('response', response=>{if(response.status()>=400)(expectedHealth(response.url())&&response.status()===404?report.expectedOfflineProbes:report.failedRequests).push({url:response.url(),status:response.status()});});
const button = name=>(name==='Video recorder'?page.getByRole('dialog',{name:'Liver physics lab',exact:true}):page).getByRole('button',{name,exact:true});
const host = page.getByTestId('cutting-viewport');
const state = async()=>JSON.parse(await host.getAttribute('data-cutting-diagnostics'));
const capture = async name=> {await host.screenshot({path:path.join(out,`${name}.png`)}); const s=await state(); report.observations.push({name, ...s}); await fs.writeFile(path.join(out,`${name}.json`),JSON.stringify(s,null,2));};
const saveReplay=async(complete,scene)=>{
 const frames=await page.evaluate(()=>window.__acceptedCuttingFrames??[]);if(!frames.length)return;
 if(scene&&scene.metrics.timeSeconds>frames.at(-1).timeSeconds)frames.push({timeSeconds:scene.metrics.timeSeconds,nodePositionsMm:scene.nodePositionsMm,damage:scene.damage,scalpelPose:scene.scalpel.accepted,metrics:scene.metrics});
 await fs.writeFile(path.join(out,'accepted-trajectory.json'),JSON.stringify({schema:'viscera.cutting-trajectory/v1',referenceSha256:report.sourceBefore.find(s=>s.path==='apps/studio/public/cutting/liver-reference.json').sha256,complete,status:complete?'COMPLETE_ACCEPTED_STROKE':'INCOMPLETE',scope:'Actual accepted native worker states; offline replay is not real-time simulation',source:scene?.source,bulk:scene?.bulk,equilibriumModel:scene?.equilibrium?.model,equilibrium:scene?.equilibrium,cohesive:scene?.cohesive,scalpelDimensions:scene?.scalpel?.dimensions,sourceHashes:Object.fromEntries(report.sourceBefore.map(s=>[s.path,s.sha256])),frames}));report.acceptedReplayFrames=frames.length;report.replayPhysicalDuration=frames.at(-1).timeSeconds;
};
const exported = async name=>{const promise=page.waitForEvent('download'); await button('Export mechanical state').click(); const item=await promise; const file=path.join(out,name); await item.saveAs(file); return JSON.parse(await fs.readFile(file,'utf8'));};
try {
 await page.goto(targetUrl,{waitUntil:'domcontentloaded'});
 await button('Physics lab').click();
 await button('Scalpel & fracture').click();
 await expect(host.locator('canvas')).toHaveCount(1);
 await expect.poll(async()=>Boolean(await host.getAttribute('data-cutting-diagnostics')),{timeout:90000}).toBe(true);
 await expect(page.getByRole('alert')).toHaveCount(0);
 report.graphics=await host.locator('canvas').evaluate(canvas=>{
   const gl=canvas.getContext('webgl2')??canvas.getContext('webgl');
   if(!gl)return null;
   const info=gl.getExtension('WEBGL_debug_renderer_info');
   return {version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(info?.UNMASKED_RENDERER_WEBGL??gl.RENDERER)};
 });
 await page.screenshot({path:path.join(out,'ui-initial.png'),fullPage:true});
 await capture('rest');
 expect((await state()).acceptedSteps).toBe(0);
 if(process.env.CUTTING_SNAPSHOT_ONLY){await button('Inspect incision').click();await capture('rest-close');report.status='DIAGNOSTIC_ONLY';}
 else {
 report.stroke={speedMmS:Number(process.env.CUTTING_SPEED??30),depthMm:Number(process.env.CUTTING_DEPTH??12),sweepMm:24};
 await page.getByRole('slider',{name:'Blade speed',exact:true}).fill(String(report.stroke.speedMmS));
 await page.getByRole('slider',{name:'Incision depth',exact:true}).fill(String(report.stroke.depthMm));
 await button('Run demonstration').click();
 const start=Date.now(); let previous=-1, captured=new Set(), recording=false, recordingWallStart=0;
 while(Date.now()-start<720000){
   await page.waitForTimeout(2000); const s=await state();
   if(abortRequested)throw new Error('Validation stopped by operator; incomplete motion is not a passing result');
   if(s.acceptedSteps!==previous){
     const wallSeconds=(Date.now()-start)/1000;
     await fs.appendFile(path.join(out,'trajectory.jsonl'),JSON.stringify({wallSeconds,...s})+'\n');
     console.log(JSON.stringify({wallSeconds,timeSeconds:s.timeSeconds,steps:s.acceptedSteps,retries:s.timeStepRetries,minimumJ:s.minimumJacobian,openingMm:s.maximumOpeningMm,residualN:s.stationarityResidualN,blade:s.blade}));
     previous=s.acceptedSteps;
   }
   if(s.lastError || await page.getByRole('alert').count()) throw new Error(`Mechanical failure ${JSON.stringify(s)}`);
   for(const t of [1,1.5,2,2.5,3,4]) if(s.timeSeconds>=t&&!captured.has(t)){await capture(`time-${t}`);captured.add(t);}
   if(s.fractureDissipationJ>0&&!captured.has('damage')){
     await button('Inspect incision').click();
     await button('Hide handle').click();
     report.cosmeticHandleHiddenForInspection=true;
     await capture('first-damage-close');captured.add('damage');
     if(process.env.CUTTING_RECORD==='1'){
       await button('Pause').click();
       await expect.poll(async()=>(await state()).workerStepInFlight).toBe(false);
       report.recordingPhysicalStart=(await state()).timeSeconds;
       await button('Video recorder').click();
       await page.getByRole('radio',{name:/4K/}).check();
       await page.getByLabel('Recording frame rate',{exact:true}).selectOption('30');
       await page.getByRole('checkbox',{name:'Record microphone audio',exact:true}).uncheck();
       await button('Start recording').click();
       await expect.poll(()=>host.locator('canvas').evaluate(c=>[c.width,c.height])).toEqual([3840,2160]);
       await button('Resume').click(); recording=true; recordingWallStart=Date.now();
     }
   }
   if(recording && (s.timeSeconds-report.recordingPhysicalStart>.65 || Date.now()-recordingWallStart>30000)){
     await button('Video recorder').click();await button('Stop & preview').click();
     await expect(page.getByRole('region',{name:'Finished recording'})).toBeVisible({timeout:60000});
     const download=page.waitForEvent('download');await page.getByRole('link',{name:/^Download (MP4|WEBM)$/}).click();const item=await download;
     report.videoFile=`cutting-native-4k${path.extname(item.suggestedFilename())}`;await item.saveAs(path.join(out,report.videoFile));
     const details=page.waitForEvent('download');await button('Capture details').click();const receipt=await details;await receipt.saveAs(path.join(out,'recording.json'));
     report.recordingPhysicalEnd=(await state()).timeSeconds;
     await button('Close video recorder').click();recording=false;
   }
   if(s.timeSeconds>1 && await button('Resume').count() && !recording) break;
 }
 await capture('withdrawn-close');
 await button('Fit liver').click(); await capture('withdrawn-whole');
 const final=await exported('withdrawn-state.json');report.final=final.metrics;
 expect((await state()).timeSeconds).toBeGreaterThan(2);
 expect((await state()).rejectedSteps).toBe(0);
 expect((await state()).minimumJacobian).toBeGreaterThan(0);
 expect((await state()).fractureDissipationJ).toBeGreaterThan(0);
 expect((await state()).blade.active).toBe(false);
 report.checks.push('finite demo with damage, withdrawal and no rejected step');
 const withdrawalTime=(await state()).timeSeconds;
 await button('Resume').click();
 await expect.poll(async()=>{
   const s=await state();
   if(s.lastError)throw new Error(s.lastError);
   return s.timeSeconds;
 },{timeout:120000,intervals:[500,1000]}).toBeGreaterThanOrEqual(withdrawalTime+.35);
 await button('Pause').click();
 await expect.poll(async()=>(await state()).workerStepInFlight).toBe(false);
 await button('Inspect incision').click();await capture('relaxed-close');
 const relaxed=await exported('relaxed-state.json');report.relaxed=relaxed.metrics;
 expect(relaxed.metrics.fractureDissipationJ).toBeGreaterThanOrEqual(final.metrics.fractureDissipationJ-1e-12);
 expect(relaxed.metrics.rejectedSteps).toBe(0);
 expect(relaxed.metrics.minimumJacobian).toBeGreaterThan(.09);
 expect(relaxed.scalpel.accepted.active).toBe(false);
 report.checks.push('unloaded motion after blade withdrawal preserves irreversible damage');
 await saveReplay(true,relaxed);
 await button('Reset liver').click();
 await expect.poll(async()=>(await state())?.timeSeconds).toBe(0);
 const reset=await exported('reset-state.json');
 expect((await state()).fractureDissipationJ).toBe(0); report.checks.push('reset clears fracture history');
 await page.getByText('Learn cutting parameters from a measured curve',{exact:true}).click();
 await page.getByLabel('Cutting calibration JSON',{exact:true}).setInputFiles(path.join(root,'apps/studio/public/models/cutting-v1/example-observation.json'));
 await expect(button('Apply fitted material & reset')).toBeEnabled();
 await button('Apply fitted material & reset').click();
 await expect.poll(async()=>(await state())?.timeSeconds).toBe(0);
 const fitted=await exported('fitted-state.json');report.fittedProvenance=fitted.cohesiveProvenance;
 expect(fitted.cohesiveProvenance.modelId).toBeTruthy();report.checks.push('trained curve inference applies and exports model provenance');
 await page.screenshot({path:path.join(out,'ui-fitted.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);
 await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
 report.mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
 expect(report.mobileOverflow).toBe(false);
 expect(report.errors).toEqual([]);
 expect(report.failedRequests).toEqual([]);
 report.status='PASS';
 }
} catch(error){report.status='FAIL';report.failure=String(error); await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});if(!page.isClosed()&&await button('Export mechanical state').isVisible().catch(()=>false)){report.lastAccepted=await exported('failure-accepted-state.json').catch(()=>null);if(!report.acceptedReplayFrames)await saveReplay(false,report.lastAccepted).catch(()=>{});}console.error(error);}
finally{report.sourceAfter=await sources();report.sourceUnchanged=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);if(report.status==='PASS'&&!report.sourceUnchanged){report.status='FAIL';report.failure='Sources changed during validation';}await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({out,status:report.status,failure:report.failure}));}
if(report.status!=='PASS'&&report.status!=='DIAGNOSTIC_ONLY') process.exitCode=1;
