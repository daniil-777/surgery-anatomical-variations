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
