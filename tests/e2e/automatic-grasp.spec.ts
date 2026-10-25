import { expect, test, type Page } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
const read=(page:Page)=>page.evaluate(()=>(window as any).__visceraSceneSnapshot());
const lab=(page:Page)=>page.evaluate(()=>(window as any).__visceraCameraLabSnapshot());
const cameraLab=(page:Page)=>page.getByRole('region',{name:'Camera planning lab',exact:true});
async function open(page:Page){await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready=true]')).toBeVisible();await cameraLab(page).getByRole('button',{name:'Camera planning lab',exact:false}).click();await cameraLab(page).getByRole('button',{name:'Use operative camera',exact:true}).click();}

test('camera approach and learned liver grasp complete with visible contact and recovery',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await open(page);
 const before=await read(page), stages:any[]=[];
 await cameraLab(page).getByRole('button',{name:'Approach & grasp liver',exact:true}).click();
 try {
   await expect.poll(async()=>{
     const {state,l}=await page.evaluate(()=>({state:(window as any).__visceraSceneSnapshot(),l:(window as any).__visceraCameraLabSnapshot()})), grasp=state.automaticGrasp;
     const phase=grasp?.phase==='idle'?'camera':grasp?.phase;
     if(stages.at(-1)?.phase!==phase){console.log('Automatic task',phase,l.message);stages.push({phase,state,lab:l});await page.screenshot({path:info.outputPath(`stage-${phase}.png`)});}
     if(!l.taskActive&&phase!=='complete')throw new Error(`Task stopped: ${l.message}; ${grasp?.message}`);
     return grasp?.phase;
   },{timeout:200000,intervals:[300]}).toBe('complete');
   const end=await read(page), grasp=end.automaticGrasp;
   expect(grasp.succeeded).toBe(true);expect(grasp.policy.episodes).toBe(12);expect(grasp.policy.visits.reduce((a:number,b:number)=>a+b,0)).toBe(12);
   expect(grasp.policy.evaluation.every((e:any)=>e.success)).toBe(true);expect(grasp.holdDisplacementMm).toBeGreaterThanOrEqual(.5);
   expect(grasp.policy.baseline.selectedReward).toBeGreaterThanOrEqual(grasp.policy.baseline.uniformReward);expect(grasp.trainingInput.materials.model_id).toBe(grasp.policy.modelId);
   expect(grasp.peakForceN).toBeLessThanOrEqual(.8);expect(grasp.peakGradient).toBeLessThanOrEqual(.35);expect(grasp.recoveryMm).toBeLessThan(.2);
   expect(end.tools.active).toBe(false);expect(end.tools.instrumentVisible).toBe(false);expect(end.physics.finite).toBe(true);
   expect(stages.map(s=>s.phase)).toEqual(expect.arrayContaining(['approaching','closing','lifting','holding','lowering','opening','withdrawing','recovering','complete']));
   const hold=stages.find(s=>s.phase==='holding').state;expect(hold.tools.organId).toBe('liver');expect(hold.tools.jawClosure).toBeGreaterThan(.99);expect(hold.tools.instrumentVisible).toBe(true);expect(hold.tools.guard.blocked).toBe(false);expect(hold.tools.cameraClearanceMm).toBeGreaterThanOrEqual(0);
   expect(end.camera.position).toEqual(hold.camera.position);expect(end.organs.map((o:any)=>o.geometrySignature)).toEqual(before.organs.map((o:any)=>o.geometrySignature));
   const pending=page.waitForEvent('download');await cameraLab(page).getByRole('button',{name:'Export task study'}).click();const download=await pending;const study=JSON.parse(await readFile((await download.path())!,'utf8'));expect(study.grasp.succeeded).toBe(true);await writeFile(info.outputPath('task-study.json'),JSON.stringify(study));
   expect(errors).toEqual([]);
 } finally {await writeFile(info.outputPath('task-evidence.json'),JSON.stringify({before,end:await read(page),lab:await lab(page),stages,errors},null,2));}
});

test('cancellation during camera mapping and grasp learning cannot start a later instrument motion',async({page},info)=>{
 await open(page);const start=cameraLab(page).getByRole('button',{name:'Approach & grasp liver',exact:true});
 await start.click();await expect.poll(async()=>(await lab(page)).planner?.captured).toBeGreaterThan(0);await cameraLab(page).getByRole('button',{name:'Stop automatic task',exact:true}).click();
 await expect.poll(async()=>(await lab(page)).taskActive).toBe(false);const cancelled=await read(page);
 await page.waitForTimeout(1000);expect((await read(page)).tools.instrumentVisible).toBe(false);expect((await read(page)).camera.position).toEqual(cancelled.camera.position);
 await start.click();await expect.poll(async()=>(await read(page)).automaticGrasp?.phase,{timeout:75000,intervals:[100]}).toBe('learning');
 await cameraLab(page).getByRole('button',{name:'Stop automatic task',exact:true}).click();await expect.poll(async()=>(await lab(page)).taskActive).toBe(false);
 const stopped=await read(page);await page.waitForTimeout(2000);const end=await read(page);
 expect(end.automaticGrasp.phase).toBe('stopped');expect(end.tools.active).toBe(false);expect(end.tools.instrumentVisible).toBe(false);expect(end.physics.tool?.active??false).toBe(false);expect(end.camera.position).toEqual(stopped.camera.position);
 await writeFile(info.outputPath('cancel-evidence.json'),JSON.stringify({cancelled,stopped,end}));
});

test('Escape during lifting releases tissue and a new camera destination remains usable',async({page},info)=>{
 await open(page);await cameraLab(page).getByRole('button',{name:'Approach & grasp liver',exact:true}).click();
 await expect.poll(async()=>(await read(page)).automaticGrasp?.phase,{timeout:90000,intervals:[100]}).toBe('lifting');
 await page.waitForTimeout(750);const lifting=await read(page);await cameraLab(page).getByRole('button',{name:'Stop automatic task',exact:true}).focus();await page.keyboard.press('Escape');
 await expect.poll(async()=>(await lab(page)).taskActive).toBe(false);const stopped=await read(page);expect(stopped.tools.active).toBe(false);expect(stopped.tools.instrumentVisible).toBe(false);
 await expect.poll(async()=>(await read(page)).physics.displacement_mm,{timeout:10000}).toBeLessThan(.05);
 await cameraLab(page).getByRole('button',{name:'Go to gallbladder',exact:true}).click();await expect.poll(async()=>(await lab(page)).planner.phase,{timeout:60000}).toBe('playing');
 await expect(page.getByRole('region',{name:'Live scope path'})).toBeVisible();await page.keyboard.press('Escape');
 await writeFile(info.outputPath('release-restart.json'),JSON.stringify({lifting,stopped,end:await read(page)}));
});

test('disease-altered liver gets a fresh contact and completes the combined task',async({page},info)=>{
 await open(page);const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});
 await editor.getByRole('textbox').fill('liver-cirrhosis, severity 0.65');await editor.getByRole('button',{name:'Apply text',exact:true}).click();await expect(editor).toContainText('Applied shape and appearance to liver');
 const edited=await read(page);await cameraLab(page).getByRole('button',{name:'Approach & grasp liver',exact:true}).click();
 await expect.poll(async()=>{const {s,l}=await page.evaluate(()=>({s:(window as any).__visceraSceneSnapshot(),l:(window as any).__visceraCameraLabSnapshot()}));if(!l.taskActive&&s.automaticGrasp.phase!=='complete')throw new Error(l.message);return s.automaticGrasp.phase;},{timeout:180000,intervals:[500]}).toBe('complete');
 const end=await read(page);expect(end.automaticGrasp.succeeded).toBe(true);expect(end.automaticGrasp.peakForceN).toBeLessThan(.8);expect(end.automaticGrasp.peakGradient).toBeLessThan(.35);expect(end.organs.map((o:any)=>o.geometrySignature)).toEqual(edited.organs.map((o:any)=>o.geometrySignature));
 await page.screenshot({path:info.outputPath('disease-task-complete.png')});await writeFile(info.outputPath('disease-task.json'),JSON.stringify({edited,end,lab:await lab(page)}));
});

test('mobile automatic task exposes a reachable stop control and cancels cleanly',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});await open(page);await cameraLab(page).getByRole('button',{name:'Approach & grasp liver',exact:true}).click();
 await expect.poll(async()=>(await read(page)).automaticGrasp?.phase,{timeout:90000,intervals:[100]}).toBe('approaching');
 const hud=page.getByRole('region',{name:'Live automatic grasp'});await expect(hud).toBeInViewport();const box=await hud.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);
 await page.screenshot({path:info.outputPath('mobile-task.png')});await hud.getByRole('button',{name:'Stop & release',exact:true}).click();await expect.poll(async()=>(await lab(page)).taskActive).toBe(false);
 expect((await read(page)).tools.instrumentVisible).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await writeFile(info.outputPath('mobile-task.json'),JSON.stringify(await read(page)));
});

test('a shape edit during isolated learning discards its policy and leaves no active instrument',async({page},info)=>{
 await open(page);await cameraLab(page).getByRole('button',{name:'Approach & grasp liver',exact:true}).click();
 await expect.poll(async()=>(await read(page)).automaticGrasp?.phase,{timeout:90000,intervals:[100]}).toBe('learning');
 const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});await editor.getByRole('textbox').fill('liver-cirrhosis, severity 0.4');await editor.getByRole('button',{name:'Apply text',exact:true}).click();await expect(editor).toContainText('Applied shape and appearance to liver');
 await expect.poll(async()=>(await lab(page)).taskActive).toBe(false);await page.waitForTimeout(1500);
 const end=await read(page);expect(end.automaticGrasp.phase).toBe('stopped');expect(end.tools.active).toBe(false);expect(end.tools.instrumentVisible).toBe(false);expect(end.automaticGrasp.succeeded).toBe(false);
 await writeFile(info.outputPath('edit-cancel.json'),JSON.stringify(end));
});
