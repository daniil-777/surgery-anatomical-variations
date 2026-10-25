/** Guarded visible-surface contact matrix. Collision guards always stay active.
 * Default keeps all anatomy visible. CONTACT_ISOLATED=1 explicitly hides other
 * surfaces for a separate mechanics test; it does not validate intact-scene access.
 * JSON includes publication timestamps: production snapshots are ~2 Hz; recorded video is 25 fps.
 * CONTACT_PARTS, CONTACT_ANGLES and CONTACT_MODES may select a subset for diagnosis.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.env.CONTACT_OUTPUT??'/tmp/viscera-cavity-contact/baseline');
const angles=(process.env.CONTACT_ANGLES??'0,65,-65').split(',').map(Number);
const requireCameraGuard=process.env.CONTACT_REQUIRE_CAMERA_GUARD!=='0';
const isolated=process.env.CONTACT_ISOLATED==='1',view=process.env.CONTACT_VIEW??'operative';
const modeFilter=process.env.CONTACT_MODES?.split(',');
const partsFilter=process.env.CONTACT_PARTS?.split(',');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
await mkdir(out,{recursive:true});
const context=await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:1,recordVideo:{dir:path.join(out,'video'),size:{width:1600,height:1100}}});
const page=await context.newPage(),errors=[],requests=[],cases=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
page.on('response',r=>{if(r.status()>=400)requests.push({url:r.url(),status:r.status()});});
const read=()=>page.evaluate(()=>typeof window.__visceraSceneSnapshot==='function'?window.__visceraSceneSnapshot():JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
const beginTrace=()=>page.evaluate(()=>{if(typeof window.__visceraSceneSnapshot!=='function')return false;window.__contactTrace=[];window.__contactTraceRunning=true;const frame=t=>{if(!window.__contactTraceRunning)return;const s=window.__visceraSceneSnapshot();if(window.__contactTrace.length<1800)window.__contactTrace.push({atMs:t,publishedMs:s.wall_time_ms,renderedFrames:s.renderedFrames,physicsTime:s.physics?.time_s,finite:s.physics?.finite,displacementMm:s.physics?.displacement_mm,speedMs:s.physics?.maximum_speed_m_s,energyJ:s.physics?.stored_energy_j,droppedSeconds:s.physics?.dropped_time_s,gradient:s.physics?.displacement_gradient_bound,active:s.tools.active,organId:s.tools.organId,reactionN:s.tools.reactionN,uploadGapMm:s.tools.solverUploadGapMm,tipClearanceMm:s.tools.geometricClearanceMm,tipGapMm:s.tools.visualTipAnchorGapMm,cameraClearanceMm:s.tools.cameraClearanceMm,cameraGuardRadiusMm:s.tools.cameraGuardRadiusMm,slipMm:s.tools.slipMm,surfacePointMm:s.tools.surfacePointMm,guard:s.tools.guard,organs:s.physics?.renderedSamples.map(p=>({id:p.id,displacementMm:p.maxSampleDisplacementMm}))});requestAnimationFrame(frame);};requestAnimationFrame(frame);return true;});
const endTrace=async trial=>{const trace=await page.evaluate(()=>{window.__contactTraceRunning=false;return window.__contactTrace??[];});if(trace.length){await writeFile(path.join(out,trial.key,'frame-trace.json'),JSON.stringify(trace));const gaps=trace.slice(1).map((s,i)=>s.atMs-trace[i].atMs).sort((a,b)=>a-b),releaseIndex=trace.findIndex((s,i)=>i>0&&!s.active&&trace[i-1].active),release=releaseIndex>=0?trace.slice(releaseIndex):[];trial.trace={releaseEnergy:release.length&&release.every(s=>Number.isFinite(s.energyJ))?{firstJ:release[0].energyJ,lastJ:release.at(-1).energyJ,maxIncreaseJ:Math.max(0,...release.slice(1).map((s,i)=>s.energyJ-release[i].energyJ))}:null,frames:trace.length,durationSeconds:(trace.at(-1).atMs-trace[0].atMs)/1000,p95IntervalMs:gaps[Math.floor(gaps.length*.95)],finite:trace.every(s=>s.finite),maxReactionN:Math.max(...trace.map(s=>s.reactionN)),maxUploadGapMm:Math.max(...trace.map(s=>s.uploadGapMm)),minTipClearanceMm:Math.min(...trace.filter(s=>s.active).map(s=>s.tipClearanceMm)),minCameraClearanceMm:trace.some(s=>s.active&&Number.isFinite(s.cameraClearanceMm))?Math.min(...trace.filter(s=>s.active&&Number.isFinite(s.cameraClearanceMm)).map(s=>s.cameraClearanceMm)):null,nonmonotonicSolverTime:trace.some((s,i)=>i&&s.physicsTime<trace[i-1].physicsTime)};}return trace.length;};
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const release=async()=>{await page.locator('.whole-scene-canvas canvas').focus();await page.keyboard.press('Escape');await settle();};
const click=async name=>{await page.getByRole('button',{name,exact:true}).click();await settle();};
const sample=async(label,trial)=>{const snapshot=await read(),now=await page.evaluate(()=>performance.now()),entry={label,capturedAtMs:now,snapshot};trial.samples.push(entry);if(process.env.CONTACT_STILLS==='all'||['rest','engaged','unreachable','held-2','lateral-2','released-0','released-2'].includes(label)){entry.image=`${String(trial.samples.length).padStart(2,'0')}-${label}.png`;await page.screenshot({path:path.join(out,trial.key,entry.image)});}return snapshot;};
const observe=async(label,ms,trial)=>{
 const start=Date.now(),offsets=[Math.min(200,ms),Math.min(600,ms),ms];
 for(const [i,t] of [...new Set(offsets)].entries()){await page.waitForTimeout(Math.max(1,t-(Date.now()-start)));await sample(`${label}-${i}`,trial);}
};
const save=async()=>{await writeFile(path.join(out,'receipt.json.tmp'),JSON.stringify({url:page.url(),createdAt:new Date().toISOString(),protocol:{viewport:{width:1600,height:1100},angles,guards:isolated?'unaltered; explicitly isolated target surface, all other anatomy hidden from rendering/contact tests':'unaltered; all anatomy visible',view,diagnostics:'Uses the optional live snapshot getter when available; per-animation-frame traces are saved for contacts. Falls back to published approximately500ms snapshots, preserving timestamps. Screenshots and video are actual rendered output, no interpolation.',checks:'finite solver, reaction force, upload gap, tip clearance, release recovery, connected organ response. Shared-field motion is not proof of physical collision correctness.'},cases,errors,requests},null,2));await rename(path.join(out,'receipt.json.tmp'),path.join(out,'receipt.json'));};
const summarize=trial=>{
 const snapshots=trial.samples.map(s=>s.snapshot),active=snapshots.filter(s=>s.tools.active);
 const finite=snapshots.every(s=>s.physics?.finite),maxReactionN=Math.max(0,...active.map(s=>s.tools.reactionN)),maxUploadGapMm=Math.max(0,...active.map(s=>s.tools.solverUploadGapMm));
 const minCameraClearanceMm=active.some(s=>Number.isFinite(s.tools.cameraClearanceMm))?Math.min(...active.filter(s=>Number.isFinite(s.tools.cameraClearanceMm)).map(s=>s.tools.cameraClearanceMm)):null;
 const minClearanceMm=Math.min(0,...active.map(s=>s.tools.geometricClearanceMm)),maxTipGapMm=Math.max(0,...active.map(s=>s.tools.visualTipAnchorGapMm));
 const responses=Object.fromEntries((snapshots[0]?.physics?.renderedSamples??[]).map(p=>[p.id,Math.max(0,...snapshots.map(s=>s.physics?.renderedSamples.find(q=>q.id===p.id)?.maxSampleDisplacementMm??0))]));
 const component=snapshots[0]?.physics?.attachment_components?.find(c=>c.includes(trial.organId)),maxDisconnectedMotionMm=component?Math.max(0,...Object.entries(responses).filter(([id])=>!component.includes(id)).map(([,d])=>d)):null;
 const release=trial.samples.filter(s=>s.label.startsWith('released')),last=release.at(-1)?.snapshot;
 const hold=trial.samples.filter(s=>s.label.startsWith('held')),held=hold.at(-1)?.snapshot;
 const temporal=trial.samples.slice(1).map((s,i)=>{const prev=trial.samples[i],dt=(s.snapshot.wall_time_ms-prev.snapshot.wall_time_ms)/1000;return {from:prev.label,to:s.label,diagnosticDeltaSeconds:dt,renderedFrameDelta:s.snapshot.renderedFrames-prev.snapshot.renderedFrames,solverDeltaSeconds:(s.snapshot.physics?.time_s??0)-(prev.snapshot.physics?.time_s??0),sceneDisplacementDeltaMm:(s.snapshot.physics?.displacement_mm??0)-(prev.snapshot.physics?.displacement_mm??0),active:s.snapshot.tools.active};});
 return {deformationObserved:Math.max(0,...snapshots.map(s=>s.physics?.displacement_mm??0))>.01&&Math.max(maxReactionN,trial.trace?.maxReactionN??0)>1e-4,finite,maxReactionN,maxUploadGapMm,minClearanceMm,minCameraClearanceMm,maxTipGapMm,responses,maxDisconnectedMotionMm,recovery:{heldMm:held?.physics.displacement_mm??null,finalMm:last?.physics.displacement_mm??null,fraction:held?.physics.displacement_mm?last?.physics.displacement_mm/held.physics.displacement_mm:null},temporal,warnings:[...(requireCameraGuard&&active.length&&minCameraClearanceMm===null?['Missing camera-clearance diagnostics']:[]),...(minCameraClearanceMm<-.05?['Instrument intersects laparoscope clearance volume']:[]),...(maxDisconnectedMotionMm>.005?['Disconnected anatomy moved without a contact path']:[]),...(!finite?['Nonfinite solver state']:[]),...(maxReactionN>3.01?['Reaction exceeds3N cap']:[]),...(maxUploadGapMm>.02?['Rendered and solver surface mismatch']:[]),...(minClearanceMm<-.06?['Tip envelope penetrates visible surface']:[]),...(active.length&&!last?['No release observation']:[])]};
};
try{
 await page.goto(`${process.env.CONTACT_URL??'http://127.0.0.1:5177/'}?mode=scene&scene=virtamed`);await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'),{timeout:120000});
 await click('Apply learned textures');await click('Apply learned physics to all organs');await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).physics?.running,{timeout:30000});
 const breath=page.getByRole('checkbox',{name:/Breathing/});if(await breath.isChecked())await breath.uncheck();
 await page.getByText('Explore the structures',{exact:false}).click();
 const organs=(await read()).organs.filter(p=>!partsFilter||partsFilter.includes(p.id));
 for(const organ of organs){
  const modes=modeFilter??(['gallbladder','small-intestine','hepatocystic-fat','hepatoduodenal-ligament','falciform-ligament'].includes(organ.id)?['Push','Grasp']:['Push']);
  for(const mode of modes)for(const angle of angles){
   const trial={key:`${organ.id}-${mode.toLowerCase()}-${angle}`,organId:organ.id,mode,angle,attempts:[],samples:[],status:'pending'};
   cases.push(trial);await mkdir(path.join(out,trial.key),{recursive:true});
   await click('Camera');await click('Reset motion');await click('Video camera · instruments enabled');
   if(isolated){for(const other of (await read()).organs){const visible=other.id===organ.id;if(other.visible!==visible)await click(`${visible?'Show':'Hide'} ${other.label}`);}await click(`Focus ${organ.label}`);await page.waitForTimeout(650);}
   if(view==='anterior'){await click('Explore cavity');for(let step=0;step<18+angle;step++)await click('Look left');await click('Use this view for instruments');await page.waitForTimeout(600);}
   const canvas=page.locator('.whole-scene-canvas canvas'),box=await canvas.boundingBox();
   if(angle&&view!=='anterior'){await page.mouse.move(box.x+box.width*.64,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.64+angle,box.y+box.height*.48+angle*.14,{steps:18});await page.mouse.up();await page.waitForTimeout(550);}
   const select=page.getByRole('button',{name:organ.label,exact:true});if(await select.getAttribute('aria-pressed')!=='true')await select.click();await click(mode);
   // Small calibrated probe gives fine anatomy a legitimate reachable footprint.
   if(mode==='Push'){const radius=page.getByRole('slider',{name:'Probe tip radius',exact:true});await radius.press('Home');const depth=page.getByRole('slider',{name:'Initial push depth',exact:true});await depth.press('Home');await settle();}
   await page.waitForTimeout(650);const before=await sample('rest',trial);trial.physicsSupported=before.physics.organs.some(p=>p.id===organ.id);trial.hiddenAnatomy=before.organs.filter(p=>!p.visible).map(p=>p.id);trial.view=view;
   const candidates=before.tools.pickCandidates.filter(p=>p.organId===organ.id);trial.visibleCandidateCount=candidates.length;
   for(const candidate of candidates){
    if(!await page.evaluate(p=>document.elementFromPoint(p.clientX,p.clientY)===document.querySelector('.whole-scene-canvas canvas'),candidate)){trial.attempts.push({candidate,outcome:'covered-by-ui'});continue;}
    const clickAt=await page.evaluate(()=>performance.now());await page.mouse.click(candidate.clientX,candidate.clientY);await page.waitForFunction(t=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).wall_time_ms>t,clickAt);const result=await read();trial.attempts.push({candidate,active:result.tools.active,organId:result.tools.organId,message:result.tools.message,guard:result.tools.guard});
    if(result.tools.active&&result.tools.organId===organ.id)break;
    if(result.tools.active)await release();
   }
   const engaged=await read();
   if(!engaged.tools.active||engaged.tools.organId!==organ.id){trial.status=!trial.physicsSupported?'unsupported':candidates.length?'blocked-approach':'occluded-or-no-candidate';await sample('unreachable',trial);trial.summary=summarize(trial);await save();console.log(trial.key,trial.status);continue;}
   trial.status='contact';await sample('engaged',trial);await beginTrace();
   for(let step=0;step<Number(process.env.CONTACT_DEPTH_STEPS??2);step++){if(!(await read()).tools.active)break;const deeper=page.getByRole('button',{name:'Move deeper',exact:true});if(await deeper.isEnabled())await deeper.click({timeout:1000}).catch(e=>{if(!String(e).includes('Timeout'))throw e;});await settle();}await observe('held',1200,trial);trial.contactSurvivedHold=(await read()).tools.active;
   // A small actual pointer slide tests footprint migration without hiding occluders.
   const anchor=trial.attempts.findLast(a=>a.active&&a.organId===organ.id)?.candidate;
   await page.mouse.move(anchor.clientX,anchor.clientY);await settle();await page.mouse.move(anchor.clientX+12,anchor.clientY+5,{steps:8});await observe('lateral',700,trial);trial.contactSurvivedLateral=(await read()).tools.active;
   if((await read()).tools.active){const withdraw=page.getByRole('button',{name:'Withdraw',exact:true});if(await withdraw.isEnabled())await withdraw.click({timeout:1000}).catch(e=>{if(!String(e).includes('Timeout'))throw e;});await settle();await observe('withdrawn',600,trial);}
   if((await read()).tools.active)await release();await observe('released',2200,trial);await endTrace(trial);
   trial.summary=summarize(trial);await save();console.log(trial.key,trial.status,JSON.stringify({forceN:trial.summary.maxReactionN,uploadGapMm:trial.summary.maxUploadGapMm,recovery:trial.summary.recovery.fraction,warnings:trial.summary.warnings}));
  }
 }
 await page.screenshot({path:path.join(out,'final-ui.png')});await save();
 const rows=cases.map(t=>`<tr><td>${t.key}</td><td>${t.status}</td><td>${t.summary.maxReactionN.toFixed(3)}</td><td>${t.summary.maxUploadGapMm.toFixed(5)}</td><td>${t.summary.recovery.fraction?.toFixed(3)??'—'}</td><td>${t.samples.filter(s=>s.image).map(s=>`<a href="${t.key}/${s.image}">${s.label}</a>`).join(' · ')}</td></tr>`).join('');
 await writeFile(path.join(out,'index.html'),`<!doctype html><meta charset="utf-8"><title>Guarded contact temporal review</title><style>body{font:15px system-ui;background:#171b20;color:#e2e7ed;margin:30px}a{color:#84c4ff}td,th{padding:10px;text-align:left;border-bottom:1px solid #455}table{border-collapse:collapse}td:last-child{max-width:600px}</style><h1>Guarded contact temporal review</h1><p>${isolated?'Isolated target surface; occluding anatomy explicitly hidden. This does not validate instrument approach through the intact scene.':'All organs visible; collision guards unchanged.'} Fresh snapshot samples and animation-frame traces are recorded when available; screenshots and video are unmodified rendered evidence. Unsupported/occluded structures are recorded explicitly.</p><p><a href="receipt.json">Complete diagnostics</a> · Video in video/.</p><table><tr><th>Case</th><th>Outcome</th><th>Peak N</th><th>Upload gap mm</th><th>Recovery ratio</th><th>Temporal frames</th></tr>${rows}</table>`);
 console.log(JSON.stringify({output:out,cases:cases.length,statuses:cases.reduce((a,c)=>(a[c.status]=(a[c.status]??0)+1,a),{}),errors,requests}));
 if(errors.length||cases.some(c=>c.summary.warnings.length||c.trace&&(!c.trace.finite||c.trace.nonmonotonicSolverTime||c.trace.maxReactionN>3.01||c.trace.maxUploadGapMm>.02||c.trace.minCameraClearanceMm<-.05)))process.exitCode=1;
}catch(error){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,snapshot:await read().catch(()=>null)},null,2));await save();throw error;}
finally{await context.close();await browser.close();}
