import { expect,test,type Page } from '@playwright/test';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
const lab=(page:Page)=>page.getByRole('region',{name:'Camera planning lab',exact:true});
const read=(page:Page)=>page.evaluate(()=>(window as any).__visceraCameraLabSnapshot?.());
const scene=(page:Page)=>page.evaluate(()=>(window as any).__visceraSceneSnapshot());
async function open(page:Page){await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready=true]')).toBeVisible();await lab(page).getByRole('button',{name:'Camera planning lab',exact:false}).click();await lab(page).getByRole('button',{name:'Use operative camera',exact:true}).click();}
async function train(page:Page){await lab(page).getByRole('button',{name:'Train camera policy',exact:true}).click();await expect.poll(async()=>(await read(page))?.phase,{timeout:150000}).toBe('ready');const result=await read(page);expect(result.stale).toBe(false);expect(result.policy.training.updates).toBeGreaterThan(0);return result;}
function watchErrors(page:Page){const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/Shader|WebGL|THREE/.test(message.text()))errors.push(message.text());});return errors;}
const anatomy=(snapshot:any)=>snapshot.organs.map((organ:any)=>[organ.geometrySignature,organ.materialSignature]);
async function study(page:Page){const pending=page.waitForEvent('download');await lab(page).getByRole('button',{name:'Export study',exact:true}).click();const download=await pending;return JSON.parse(await readFile((await download.path())!,'utf8'));}
async function monitorMotion(page:Page){await page.evaluate(()=>{
 const w=window as any;w.__cameraMotionFrames=[];
 const record=()=>{const s=w.__visceraSceneSnapshot?.()?.cameraPlanner;if(s?.phase==='playing')w.__cameraMotionFrames.push({elapsed:s.elapsedSeconds,position:s.positionMm,direction:s.direction,port:s.port,lap:s.lap});w.__cameraMotionRaf=requestAnimationFrame(record);};record();
});}
async function finishMotion(page:Page){const frames=await page.evaluate(()=>{const w=window as any;cancelAnimationFrame(w.__cameraMotionRaf);return w.__cameraMotionFrames as {elapsed:number,position:number[],direction:number[],port:number[],lap:number}[];});
 let peakSpeed=0,peakAngularSpeed=0,maxPivotError=0;
 for(let i=1;i<frames.length;i++){const a=frames[i-1]!,b=frames[i]!,dt=b.elapsed-a.elapsed;if(dt<=0)continue;
  peakSpeed=Math.max(peakSpeed,Math.hypot(...b.position.map((v,j)=>v-a.position[j]!))/dt);
  const cosine=Math.max(-1,Math.min(1,b.direction.reduce((sum,v,j)=>sum+v*a.direction[j]!,0)));peakAngularSpeed=Math.max(peakAngularSpeed,Math.acos(cosine)/dt*180/Math.PI);
  const radial=b.position.map((v,j)=>v-b.port[j]!),length=Math.hypot(...radial);maxPivotError=Math.max(maxPivotError,Math.hypot(...radial.map((v,j)=>v/length-b.direction[j]!)));
 }
 expect(frames.length).toBeGreaterThan(20);expect(peakSpeed).toBeLessThanOrEqual(24.01);expect(peakAngularSpeed).toBeLessThanOrEqual(18.01);expect(maxPivotError).toBeLessThan(1e-8);
 return {frames,peakSpeed,peakAngularSpeed,maxPivotError};
}

test('pretrained demonstration starts without training and loops continuously with pause and stop',async({page},info)=>{
 const errors=watchErrors(page);await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready=true]')).toBeVisible();
 await expect(lab(page).getByRole('button',{name:'Start camera demonstration',exact:true})).toBeEnabled();
 const before=await scene(page);await monitorMotion(page);await lab(page).getByRole('button',{name:'Start camera demonstration',exact:true}).click();
 await expect.poll(async()=>(await read(page))?.origin,{timeout:45000}).toBe('pretrained');
 const started=await read(page);expect(started.trainingMs).toBe(0);expect(started.policy.config.episodes).toBe(6000);expect(started.policy.training.updates).toBe(87903);expect(started.rollout.steps).toBeGreaterThanOrEqual(3);
 const hud=page.getByRole('region',{name:'Live scope path'});await expect(hud).toBeVisible();
 await hud.getByRole('button',{name:'Pause',exact:true}).click();const paused=await scene(page);
 await page.screenshot({path:info.outputPath('default-scope-paused.png')});
 await page.evaluate(async()=>{for(let i=0;i<12;i++)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
 expect((await scene(page)).camera.position).toEqual(paused.camera.position);
 await hud.getByRole('button',{name:'Resume',exact:true}).click();
 await expect.poll(async()=>(await read(page)).planner.lap,{timeout:60000}).toBeGreaterThanOrEqual(3);
 const looping=await read(page);expect(looping.planner.phase).toBe('playing');expect(looping.planner.blockedMoves).toBe(0);expect(looping.planner.returnSegments).toBeGreaterThan(0);
 await page.screenshot({path:info.outputPath('default-scope-loop.png')});await hud.getByRole('button',{name:'Stop camera',exact:true}).click();
 const stopped=await scene(page);expect(stopped.cameraPlanner.phase).toBe('stopped');expect(stopped.organs.map((o:any)=>o.geometrySignature)).toEqual(before.organs.map((o:any)=>o.geometrySignature));
 const exported=await study(page);await writeFile(info.outputPath('default-policy-study.json'),JSON.stringify(exported));
 const motion=await finishMotion(page);await writeFile(info.outputPath('default-loop-evidence.json'),JSON.stringify({before,started,paused,looping,stopped,motion,errors},null,2));expect(errors).toEqual([]);
});

for(const organ of ['liver','gallbladder'])test(`conditioned camera approaches ${organ} from the current pose and holds the inspection view`,async({page},info)=>{
 const errors=watchErrors(page);await open(page);const before=await scene(page);await monitorMotion(page);
 await lab(page).getByRole('button',{name:`Go to ${organ}`,exact:true}).click();
 await expect.poll(async()=>(await read(page))?.origin,{timeout:60000}).toBe('goal');
 const learned=await read(page);expect(learned.policy.config.episodes).toBe(10000);expect(learned.goal.id).toBe(organ);expect(learned.goalAudit.accepted).toBe(true);expect(learned.goalAudit.successRate).toBe(1);expect(learned.rollout.success).toBe(true);expect(learned.rollout.steps).toBeGreaterThan(0);expect(learned.goal.score).toBeGreaterThan(learned.goal.initialScore);
 await page.screenshot({path:info.outputPath(`${organ}-approach.png`)});
 await expect.poll(async()=>(await read(page)).planner.phase,{timeout:60000}).toBe('complete');
 const end=await scene(page),exported=await study(page),destination=exported.scene.graph.nodes[learned.goal.node].pose.position;
 expect(Math.hypot(...end.camera.position.map((v:number,i:number)=>v-destination[i]))).toBeLessThan(1e-6);expect(end.cameraPlanner.blockedMoves).toBe(0);expect(anatomy(end)).toEqual(anatomy(before));
 await page.screenshot({path:info.outputPath(`${organ}-arrival.png`)});await writeFile(info.outputPath(`${organ}-study.json`),JSON.stringify(exported));
 const motion=await finishMotion(page);expect(end.inspection.cameraLight.intensity).toBeLessThan(before.inspection.cameraLight.intensity);
 await writeFile(info.outputPath(`${organ}-evidence.json`),JSON.stringify({before,learned,end,motion,errors},null,2));expect(errors).toEqual([]);
});

test('switching organs from a close view preserves the pivot and learns a guarded retreat and approach',async({page},info)=>{
 const errors=watchErrors(page);await open(page);await lab(page).getByRole('button',{name:'Go to liver',exact:true}).click();
 await expect.poll(async()=>(await read(page))?.planner?.phase,{timeout:60000}).toBe('complete');
 const liver=await read(page),before=await scene(page);await monitorMotion(page);
 await lab(page).getByRole('button',{name:'Go to gallbladder',exact:true}).click();
 await expect.poll(async()=>(await read(page))?.goal?.id,{timeout:60000}).toBe('gallbladder');
 await expect.poll(async()=>(await read(page)).planner.phase,{timeout:60000}).toBe('complete');
 const gallbladder=await read(page),end=await scene(page),exported=await study(page);
 expect(gallbladder.planner.port).toEqual(liver.planner.port);expect(exported.scene.graph.nodes[0].pose.position).toEqual(before.camera.position);expect(gallbladder.goalAudit.accepted).toBe(true);expect(gallbladder.planner.blockedMoves).toBe(0);expect(anatomy(end)).toEqual(anatomy(before));
 const motion=await finishMotion(page);await page.screenshot({path:info.outputPath('changed-organ-arrival.png')});await writeFile(info.outputPath('changed-organ-evidence.json'),JSON.stringify({liver,before,gallbladder,end,motion,errors},null,2));expect(errors).toEqual([]);
});

test('mobile one-click demonstration keeps the scope controls visible and Escape stops it',async({page},info)=>{
 const errors=watchErrors(page);await page.setViewportSize({width:390,height:844});await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready=true]')).toBeVisible();
 await lab(page).getByRole('button',{name:'Start camera demonstration',exact:true}).click();await expect.poll(async()=>(await read(page)).planner.phase).toBe('playing');
 const hud=page.getByRole('region',{name:'Live scope path'});await expect(hud).toBeInViewport();const box=await hud.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);
 await page.screenshot({path:info.outputPath('mobile-default-scope.png')});await page.keyboard.press('Escape');await expect.poll(async()=>(await read(page)).planner.phase).toBe('stopped');expect(errors).toEqual([]);
});

test('default policy refuses edited anatomy while goal capture can be cancelled without later motion',async({page},info)=>{
 const errors=watchErrors(page);await open(page);const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});
 await editor.getByRole('textbox').fill('liver-cirrhosis, severity 0.65');await editor.getByRole('button',{name:'Apply text',exact:true}).click();await expect(editor).toContainText('Applied shape and appearance to liver');
 const edited=await scene(page);await lab(page).getByRole('button',{name:'Start camera demonstration',exact:true}).click();await expect(lab(page)).toContainText('The pretrained policy does not match this anatomy or view.');
 expect((await read(page)).planner.phase).not.toBe('playing');expect(anatomy(await scene(page))).toEqual(anatomy(edited));
 await lab(page).getByRole('button',{name:'Go to gallbladder',exact:true}).click();await expect.poll(async()=>(await read(page)).planner.captured).toBeGreaterThan(0);await lab(page).getByRole('button',{name:'Cancel training',exact:true}).click();
 await expect.poll(async()=>(await read(page)).phase).toBe('idle');const cancelled=await scene(page);await page.evaluate(async()=>{for(let i=0;i<20;i++)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
 expect((await scene(page)).camera.position).toEqual(cancelled.camera.position);expect((await read(page)).planner.phase).toBe('stopped');await writeFile(info.outputPath('default-rejection-cancel.json'),JSON.stringify({edited,cancelled,lab:await read(page),errors},null,2));expect(errors).toEqual([]);
});

test('RGBD camera policy trains, evaluates and replays without altering anatomy',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Shader|WebGL|THREE/.test(m.text()))errors.push(m.text());});
 await open(page);const before=await scene(page);
 await lab(page).getByRole('button',{name:'Train camera policy',exact:true}).click();
 await expect.poll(async()=>(await read(page))?.phase,{timeout:150000}).toBe('ready');
 const trained=await read(page),after=await scene(page);
 await expect(lab(page)).toContainText("Planned route completes the inspection goal");
 expect(trained.policy.training.updates).toBeGreaterThan(0);expect(trained.map.nodes).toBeGreaterThan(3);expect(trained.policy.training.holdoutStarts.length).toBeGreaterThan(0);
 expect(after.camera.position).toEqual(before.camera.position);expect(after.organs.map((o:any)=>[o.geometrySignature,o.materialSignature])).toEqual(before.organs.map((o:any)=>[o.geometrySignature,o.materialSignature]));
 await page.screenshot({path:info.outputPath('trained-lab.png')});
 const pending=page.waitForEvent('download');await lab(page).getByRole('button',{name:'Export study',exact:true}).click();await (await pending).saveAs(info.outputPath('camera-study.json'));
 await lab(page).getByRole('button',{name:'Replay camera path',exact:true}).click();
 await expect.poll(async()=>(await read(page))?.planner?.phase).toBe('playing');
 await expect.poll(async()=>JSON.stringify((await scene(page)).camera.position)).not.toBe(JSON.stringify(before.camera.position));
 await lab(page).getByRole('button',{name:'Pause path',exact:true}).click();const paused=await scene(page);await expect.poll(async()=>(await read(page)).planner.phase).toBe('paused');
 await page.screenshot({path:info.outputPath('replay-paused.png')});
 await lab(page).getByRole('button',{name:'Resume path',exact:true}).click();
 await expect.poll(async()=>(await read(page)).planner.phase,{timeout:45000}).toBe('complete');
 const end=await scene(page);expect(end.cameraPlanner.blockedMoves).toBe(0);expect(end.organs.map((o:any)=>[o.geometrySignature,o.materialSignature])).toEqual(before.organs.map((o:any)=>[o.geometrySignature,o.materialSignature]));
 await writeFile(info.outputPath('camera-evidence.json'),JSON.stringify({before,trained,after,end,errors},null,2));expect(errors).toEqual([]);
});

test('capture cancellation preserves camera and anatomy and a fresh real training run succeeds',async({page},info)=>{
 const errors=watchErrors(page);await open(page);const before=await scene(page);
 await lab(page).getByRole('button',{name:'Train camera policy',exact:true}).click();
 await expect.poll(async()=>{const state=await read(page);return state?.phase==='capturing'&&state.planner?.captured>0&&state.planner.captured<state.planner.total;},{timeout:60000}).toBe(true);
 await lab(page).getByRole('button',{name:'Cancel training',exact:true}).click();
 await expect.poll(async()=>(await read(page)).phase).toBe('idle');
 await expect.poll(async()=>(await read(page)).planner.phase).toBe('stopped');
 const cancelled=await scene(page);expect(cancelled.camera.position).toEqual(before.camera.position);expect(anatomy(cancelled)).toEqual(anatomy(before));
 const retried=await train(page),after=await scene(page);expect(retried.map.revision).toBe(retried.planner.revision);expect(after.camera.position).toEqual(before.camera.position);expect(anatomy(after)).toEqual(anatomy(before));
 await writeFile(info.outputPath('cancel-retry-evidence.json'),JSON.stringify({before,cancelled,retried,after,errors},null,2));expect(errors).toEqual([]);
});

test('a text disease edit invalidates the old map and can immediately recapture and learn a fresh policy',async({page},info)=>{
 const errors=watchErrors(page);await open(page);const original=await train(page),before=await scene(page);
 const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});
 await editor.getByRole('textbox').fill('liver-cirrhosis, severity 0.65, wetness 0.4');await editor.getByRole('button',{name:'Apply text',exact:true}).click();
 await expect(editor).toContainText('Applied shape and appearance to liver');
 await expect.poll(async()=>(await read(page)).stale).toBe(true);
 await expect(lab(page).getByRole('button',{name:'Replay camera path',exact:true})).toBeDisabled();
 const edited=await scene(page),liver=(snapshot:any)=>snapshot.organs.find((organ:any)=>organ.id==='liver');
 expect(liver(edited).geometrySignature).not.toBe(liver(before).geometrySignature);expect(liver(edited).materialSignature).not.toBe(liver(before).materialSignature);
 const retrained=await train(page);expect(retrained.map.revision).toBe(retrained.planner.revision);expect(retrained.map.revision).toBeGreaterThan(original.map.revision);expect(retrained.map.fingerprint).not.toBe(original.map.fingerprint);
 await expect(lab(page).getByRole('button',{name:'Replay camera path',exact:true})).toBeEnabled();expect(anatomy(await scene(page))).toEqual(anatomy(edited));
 await page.screenshot({path:info.outputPath('disease-retrained.png')});await writeFile(info.outputPath('disease-recapture-evidence.json'),JSON.stringify({original,before,edited,retrained,errors},null,2));expect(errors).toEqual([]);
});

test('invalid policy import preserves the trained policy, valid import succeeds and subsequent training stays current',async({page},info)=>{
 const errors=watchErrors(page);await open(page);const before=await train(page),exported=await study(page),input=lab(page).locator('input[type=file]');
 const invalid={...exported,policy:{...exported.policy,fingerprint:'a-different-captured-scene'}};
 await input.setInputFiles({name:'mismatched-policy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});
 await expect(lab(page)).toContainText(/does not match|fingerprint|different.*scene/i);
 const rejected=await read(page);expect(rejected.phase).toBe('ready');expect(rejected.map.fingerprint).toBe(before.map.fingerprint);expect(rejected.policy).toEqual(before.policy);expect(rejected.stale).toBe(false);
 await input.setInputFiles({name:'matching-policy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});
 await expect(lab(page)).toContainText('Imported policy matches this captured scene and passed validation.');
 const imported=await read(page);expect(imported.policy).toEqual(before.policy);expect(imported.map.fingerprint).toBe(before.map.fingerprint);
 await lab(page).getByRole('textbox',{name:'Camera training seed',exact:true}).fill('117');const retrained=await train(page);expect(retrained.policy.config.seed).toBe(117);expect(retrained.map.revision).toBe(retrained.planner.revision);
 await writeFile(info.outputPath('policy-import-evidence.json'),JSON.stringify({before,rejected,imported,retrained,errors},null,2));expect(errors).toEqual([]);
});

test('Escape takes manual control of replay while a sidebar input has focus',async({page},info)=>{
 const errors=watchErrors(page);await open(page);await train(page);
 await lab(page).getByRole('button',{name:'Replay camera path',exact:true}).click();await expect.poll(async()=>(await read(page)).planner.phase).toBe('playing');
 const seed=lab(page).getByRole('textbox',{name:'Camera training seed',exact:true});await seed.focus();await expect(seed).toBeFocused();await seed.press('Escape');
 await expect.poll(async()=>(await read(page)).planner.phase).toBe('stopped');
 const stopped=await scene(page);await page.evaluate(async()=>{for(let i=0;i<12;i++)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});const settled=await scene(page);
 expect(Math.hypot(...settled.camera.position.map((value:number,index:number)=>value-stopped.camera.position[index]))).toBeLessThan(1e-8);expect(anatomy(settled)).toEqual(anatomy(stopped));
 await expect(lab(page).getByRole('button',{name:'Replay camera path',exact:true})).toBeEnabled();await expect(lab(page).getByRole('button',{name:'Stop path',exact:true})).toHaveCount(0);
 await writeFile(info.outputPath('sidebar-escape-evidence.json'),JSON.stringify({stopped,settled,lab:await read(page),errors},null,2));expect(errors).toEqual([]);
});

test('the mobile planning lab trains and keeps observations and actions within the viewport',async({page},info)=>{
 const errors=watchErrors(page);await page.setViewportSize({width:390,height:844});await open(page);
 await lab(page).scrollIntoViewIfNeeded();await expect(lab(page).getByRole('combobox',{name:'Camera inspection task',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('mobile-lab-open.png')});const trained=await train(page);
 await lab(page).getByRole('combobox',{name:'Camera observation view',exact:true}).scrollIntoViewIfNeeded();
 await expect(lab(page).getByRole('img',{name:'Training episode return curve',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
 for(const name of ['Replay camera path','Export study','Import policy']){const action=lab(page).getByRole('button',{name,exact:true});await action.scrollIntoViewIfNeeded();await expect(action).toBeVisible();const bounds=(await action.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(391);}
 const observations=await lab(page).locator('.camera-rgbd canvas').evaluateAll(canvases=>canvases.map(canvas=>({width:(canvas as HTMLCanvasElement).width,height:(canvas as HTMLCanvasElement).height,bounds:canvas.getBoundingClientRect().toJSON()})));
 expect(observations).toHaveLength(2);for(const observation of observations){expect(observation.width).toBe(64);expect(observation.height).toBe(48);expect(observation.bounds.right).toBeLessThanOrEqual(391);}
 await page.screenshot({path:info.outputPath('mobile-lab-trained.png')});await writeFile(info.outputPath('mobile-lab-evidence.json'),JSON.stringify({trained,observations,errors},null,2));expect(errors).toEqual([]);
});

test('GPU RGBD observes unknown foreground tissue, ancestor visibility and camera layers consistently',async({page},info)=>{
 const errors=watchErrors(page);
 const fixture=await build({bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent',stdin:{resolveDir:resolve('apps/studio/src'),loader:'ts',contents:`
  import * as THREE from 'three';
  import { CameraRGBDSampler } from './cameraRGBD';
  const renderer=new THREE.WebGLRenderer();renderer.setSize(320,240);renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,4/3,.1,500);camera.position.set(0,0,80);camera.lookAt(0,0,0);
  const target=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshBasicMaterial({color:0xff0000}));target.position.z=20;
  const parent=new THREE.Group();parent.position.z=50;const fat=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshBasicMaterial({color:0x00ff00}));parent.add(fat);scene.add(target,parent);
  const overlay=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshBasicMaterial({color:0x0000ff,depthTest:false,depthWrite:false}));overlay.position.z=70;overlay.renderOrder=999;overlay.visible=false;scene.add(overlay);
  // The foreground fat is intentionally absent from the landmark surface list.
  const sampler=new CameraRGBDSampler(renderer,scene,[{id:'target',mesh:target}],[{id:'target',label:'Target'}]),center=24*64+32;
  const summarize=async()=>{const sample=await sampler.sample(camera);return{depth:sample.depth[center],rgb:sample.rgb.slice(center*3,center*3+3),targetPixels:sample.targetPixels,mask:sample.visibleMask}};
  try{
   const covered=await summarize();parent.visible=false;const exposed=await summarize();parent.visible=true;fat.layers.set(1);const differentLayer=await summarize();camera.layers.enable(1);const enabledLayer=await summarize();
   overlay.visible=true;const annotationOverlay=await summarize();
   window.__cameraRGBDOcclusion={covered,exposed,differentLayer,enabledLayer,annotationOverlay};
  }catch(error){window.__cameraRGBDOcclusion={error:String(error)}}finally{sampler.dispose();scene.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(material=>material.dispose())}});renderer.dispose()}
 `}});
 await page.setContent('<!doctype html><html><head><meta charset="utf-8"><title>RGBD occlusion regression</title></head><body></body></html>');
 await page.addScriptTag({type:'module',content:fixture.outputFiles[0]!.text});
 await page.waitForFunction(()=>(window as any).__cameraRGBDOcclusion,{timeout:30000});const result=await page.evaluate(()=>(window as any).__cameraRGBDOcclusion);
 expect(result.error).toBeUndefined();
 for(const key of ['covered','enabledLayer']){const observation=result[key];expect(Math.abs(observation.depth-30)).toBeLessThan(.004);expect(observation.rgb).toEqual([0,255,0]);expect(observation.targetPixels).toEqual([0]);expect(observation.mask).toBe(0);}
 for(const key of ['exposed','differentLayer']){const observation=result[key];expect(Math.abs(observation.depth-60)).toBeLessThan(.004);expect(observation.rgb).toEqual([255,0,0]);expect(observation.targetPixels[0]).toBeGreaterThanOrEqual(7);expect(observation.mask).toBe(1);}
 expect(result.annotationOverlay.rgb).toEqual([0,0,255]);expect(Math.abs(result.annotationOverlay.depth-30)).toBeLessThan(.004);expect(result.annotationOverlay.targetPixels).toEqual([0]);expect(result.annotationOverlay.mask).toBe(0);
 await writeFile(info.outputPath('gpu-rgbd-occlusion-evidence.json'),JSON.stringify({result,errors},null,2));expect(errors).toEqual([]);
});
