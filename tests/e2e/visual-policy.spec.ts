import { test,expect,type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const panel=(page:Page)=>page.getByRole("region",{name:"Visual action policy",exact:true});
const snapshot=(page:Page)=>page.evaluate(()=>({task:(window as any).__visceraVisualTaskSnapshot(),scene:(window as any).__visceraSceneSnapshot()}));
// Disposable test contexts explicitly grant the same permission the browser asks
// the user for. Do not disable Chromium's local-network security checks.
test.beforeEach(async({context,baseURL})=>{if(baseURL?.startsWith('https:'))await context.grantPermissions(['local-network-access'],{origin:new URL(baseURL).origin});});
async function open(page:Page){await page.goto("?mode=scene&scene=virtamed");await expect(page.locator("[data-scene-ready=true]")).toBeVisible();}
async function connect(page:Page){await panel(page).getByRole('button',{name:'Connect local policy',exact:true}).click();await expect(panel(page)).toContainText('Local trained policy connected.');}
for(const [index,instruction,severity] of [[0,0,0],[1,1,.28],[2,2,.47],[3,0,.62]] as const){
 test(`real local visual policy completes liver sequence ${index}`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await open(page);
  if(severity){const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});await editor.getByRole('textbox').fill(`liver-cirrhosis, severity ${severity}`);await editor.getByRole('button',{name:'Apply text',exact:true}).click();await expect(editor).toContainText('Applied shape and appearance to liver');}
  await connect(page);await panel(page).getByRole('combobox',{name:'Visual task instruction'}).selectOption({index:instruction});
  await panel(page).getByRole('button',{name:'Run visual liver task',exact:true}).click();const stages:any[]=[];
  await expect.poll(async()=>{const s=await snapshot(page);if(stages.at(-1)?.task.state.phase!==s.task.state.phase){stages.push(s);await page.screenshot({path:info.outputPath(`phase-${s.task.state.phase}.png`)});}if(['blocked','stopped'].includes(s.task.state.phase))throw new Error(s.task.state.message);return s.task.state.phase;},{timeout:200000,intervals:[200]}).toBe('complete');
  const end=await snapshot(page);expect(end.task.state.succeeded).toBe(true);expect(end.task.state.decisions.map((d:any)=>d.skill)).toEqual(['look','grasp','release','finish']);
  expect(end.task.state.decisions.every((d:any)=>d.accepted&&d.margin>=.5&&d.inferenceMs<1500&&d.roundTripMs<7000)).toBe(true);
  expect(end.scene.tools.active).toBe(false);expect(end.scene.tools.instrumentVisible).toBe(false);expect(end.scene.automaticGrasp.peakForceN).toBeLessThan(.8);expect(end.scene.automaticGrasp.recoveryMm).toBeLessThan(.2);expect(end.scene.physics.finite).toBe(true);expect(errors).toEqual([]);
  await writeFile(info.outputPath('visual-task.json'),JSON.stringify({end,stages,errors},null,2));
 });
}
test('wrong or stale actions cannot bypass the skill preconditions',async({page})=>{
 await open(page);await page.route('http://127.0.0.1:8877/health',route=>route.fulfill({json:{schema:'viscera.visual-skills/1',ready:true,modelId:'test-policy'}}));
 await page.route('http://127.0.0.1:8877/predict',route=>{const request=route.request().postDataJSON();return route.fulfill({json:{requestId:request.requestId,skill:'grasp',scores:[0,1,0,0,0],margin:1,modelId:'test-policy',inferenceMs:10,accepted:true}});});
 await connect(page);await panel(page).getByRole('button',{name:'Run visual liver task',exact:true}).click();
 await expect(panel(page)).toContainText('does not satisfy the task preconditions');const s=await snapshot(page);expect(s.scene.tools.active).toBe(false);expect(s.scene.cameraPlanner.captured).toBe(0);expect(s.task.state.decisions).toHaveLength(0);
});
test('cancelling a delayed decision prevents later motion',async({page})=>{
 await open(page);await page.route('http://127.0.0.1:8877/health',route=>route.fulfill({json:{schema:'viscera.visual-skills/1',ready:true,modelId:'test-policy'}}));
 let pending:any;await page.route('http://127.0.0.1:8877/predict',route=>{pending=route;});await connect(page);await panel(page).getByRole('button',{name:'Run visual liver task',exact:true}).click();
 await expect.poll(()=>Boolean(pending)).toBe(true);await panel(page).getByRole('button',{name:'Stop visual task & release'}).click();await expect.poll(async()=>(await snapshot(page)).task.active).toBe(false);
 const request=pending.request().postDataJSON();await pending.fulfill({json:{requestId:request.requestId,skill:'look',scores:[1,0,0,0,0],margin:1,modelId:'test-policy',inferenceMs:10,accepted:true}}).catch(()=>{});
 await page.waitForTimeout(600);const s=await snapshot(page);expect(s.scene.tools.active).toBe(false);expect(s.scene.cameraPlanner.captured).toBe(0);expect(s.task.state.phase).toBe('stopped');
});
test('lost inference while holding releases the instrument',async({page},info)=>{
 await open(page);await connect(page);let predictions=0;
 await page.route('http://127.0.0.1:8877/predict',route=>{predictions++;return predictions===3?route.fulfill({status:503,json:{error:'test disconnect'}}):route.continue();});
 await panel(page).getByRole('button',{name:'Run visual liver task',exact:true}).click();await expect.poll(async()=>(await snapshot(page)).task.state.phase,{timeout:180000}).toBe('blocked');
 const s=await snapshot(page);expect(predictions).toBe(3);expect(s.scene.tools.active).toBe(false);expect(s.scene.tools.instrumentVisible).toBe(false);expect(s.scene.automaticGrasp.phase).toBe('stopped');
 await expect.poll(async()=>(await snapshot(page)).scene.physics.displacement_mm,{timeout:10000}).toBeLessThan(.05);await writeFile(info.outputPath('disconnect.json'),JSON.stringify(await snapshot(page)));
});
test('mobile keeps a visible stop control while the model is deciding',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});await open(page);
 await page.route('http://127.0.0.1:8877/health',route=>route.fulfill({json:{schema:'viscera.visual-skills/1',ready:true,modelId:'test-policy'}}));
 await page.route('http://127.0.0.1:8877/predict',()=>{});await connect(page);await panel(page).getByRole('button',{name:'Run visual liver task',exact:true}).click();
 const hud=page.getByRole('region',{name:'Live visual policy',exact:true});await expect(hud).toBeInViewport();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.screenshot({path:info.outputPath('mobile.png')});await hud.getByRole('button',{name:'Stop & release',exact:true}).click();await expect.poll(async()=>(await snapshot(page)).task.active).toBe(false);
 expect((await snapshot(page)).scene.tools.active).toBe(false);
});
test('denied local access keeps execution disabled and explains recovery',async({page,context})=>{
 await open(page);
 if(new URL(page.url()).protocol==='https:')await context.clearPermissions();
 else await page.route('http://127.0.0.1:8877/health',route=>route.abort('accessdenied'));
 await panel(page).getByRole('button',{name:'Connect local policy',exact:true}).click();
 await expect(panel(page)).toContainText("In the browser's site settings, allow Apps on this device");
 await expect(panel(page).getByRole('button',{name:'Run visual liver task',exact:true})).toBeDisabled();
 const s=await snapshot(page);expect(s.task.active).toBe(false);expect(s.scene.tools.active).toBe(false);
});
