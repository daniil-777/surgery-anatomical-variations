import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const nav=(page:Page)=>page.getByRole('navigation',{name:'Scene shortcuts'});
const items=[['Joint variation: shape and texture','scene-joint-variation'],['Actions: camera and grasping','scene-actions'],['Disease: generate a condition','scene-disease']] as const;
const snapshot=(page:Page)=>page.evaluate(()=>{const s=(window as any).__visceraSceneSnapshot();return {camera:s.camera,organs:s.organs.map((o:any)=>({id:o.id,shape:o.geometrySignature,texture:o.materialSignature})),tools:s.tools.active,planner:s.cameraPlanner.phase};});
async function open(page:Page){await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready=true]')).toBeVisible();}
async function jump(page:Page,name:string,id:string){
  await nav(page).getByRole('button',{name,exact:true}).click();
  await expect(page.locator(`#${id}`)).toBeFocused();
  await expect(nav(page).getByRole('button',{name,exact:true})).toHaveAttribute('aria-current','location');
  const bounds=await page.evaluate(id=>{const t=document.getElementById(id)!.getBoundingClientRect(),n=document.querySelector('.scene-section-nav')!.getBoundingClientRect();return {top:t.top,navBottom:n.bottom,bottom:t.bottom,viewport:innerHeight};},id);
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.navBottom-1);expect(bounds.top).toBeLessThan(bounds.viewport-60);
}
for(const width of [375,768,1440])test(`shortcuts reveal their destination without altering the scene at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:1000});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await open(page);
  if(width<761)await page.locator('.whole-mobile-toggle').click();
  await page.screenshot({path:info.outputPath('initial.png')});
  const before=await snapshot(page),cameraBox=await page.locator('.whole-stage').boundingBox();
  await page.evaluate(()=>{
    const measured=window as any;measured.shortcutLatency=[];let started=0;
    document.addEventListener('click',event=>{if((event.target as Element).closest('.scene-section-nav button'))started=performance.now();},true);
    document.addEventListener('focusin',event=>{if(started&&(event.target as Element).matches('.scene-shortcut-destination')){measured.shortcutLatency.push(performance.now()-started);started=0;}},true);
  });
  for(const [name,id] of [...items,items[0],items[2]]){await jump(page,name,id);await page.screenshot({path:info.outputPath(`${id}.png`)});}
  expect(await snapshot(page)).toEqual(before);
  if(width>760)expect(await page.locator('.whole-stage').boundingBox()).toEqual(cameraBox);
  // Joint controls are conditionally mounted. A shortcut must reveal them from either tab.
  for(const name of ['Atlas references','Whole-body colour']){
    await page.locator('.whole-panel-tabs').getByRole('button',{name,exact:true}).click();
    await expect(page.locator('#scene-joint-variation')).toHaveCount(0);
    await jump(page,...items[0]);await expect(page.getByRole('slider',{name:'Shape variation',exact:true})).toBeVisible();
  }
  const boxes=await nav(page).getByRole('button').evaluateAll(buttons=>buttons.map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height,name:b.getAttribute('aria-label'),target:!!document.getElementById(b.getAttribute('aria-controls')!)})));
  for(const b of boxes){expect(b.width).toBeGreaterThanOrEqual(44);expect(b.height).toBeGreaterThanOrEqual(44);expect(b.target).toBe(true);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const navigationLatencyMs=await page.evaluate(()=>(window as any).shortcutLatency);expect(navigationLatencyMs).toHaveLength(7);expect(Math.max(...navigationLatencyMs)).toBeLessThan(200);
  expect(errors).toEqual([]);await writeFile(info.outputPath('navigation.json'),JSON.stringify({width,boxes,navigationLatencyMs,sceneUnchanged:true,errors},null,2));
});
test('keyboard navigation, large text and reduced motion retain readable shortcuts',async({page},info)=>{
  await page.setViewportSize({width:768,height:1000});await page.emulateMedia({reducedMotion:'reduce'});await open(page);
  await page.evaluate(()=>document.documentElement.style.setProperty('--ui-text-scale','1.5'));
  const buttons=nav(page).getByRole('button');await buttons.first().focus();await page.keyboard.press('Tab');await expect(buttons.nth(1)).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.locator('#scene-actions')).toBeFocused();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Approach & grasp liver',exact:true})).toBeFocused();
  await jump(page,...items[2]);await page.keyboard.press('Tab');await expect(page.getByRole('combobox',{name:'Text edit target'})).toBeFocused();
  await jump(page,...items[0]);await page.keyboard.press('Tab');await expect(page.getByRole('slider',{name:'Shape variation',exact:true})).toBeFocused();
  expect(await buttons.evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth&&n.scrollHeight<=n.clientHeight))).toBe(true);
  await page.screenshot({path:info.outputPath('large-text-keyboard.png')});
});
test('shortcuts lead to working joint and disease generation',async({page},info)=>{
  await open(page);await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();const before=await snapshot(page);
  await jump(page,...items[0]);await page.getByRole('button',{name:'Joint scene variation',exact:true}).click();
  await expect.poll(async()=>JSON.stringify((await snapshot(page)).organs)).not.toBe(JSON.stringify(before.organs));const joint=await snapshot(page);
  const liver=(s:any)=>s.organs.find((o:any)=>o.id==='liver');
  expect(liver(joint).shape).not.toBe(liver(before).shape);expect(liver(joint).texture).not.toBe(liver(before).texture);
  await jump(page,...items[2]);const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});
  await editor.getByRole('button',{name:'Alcohol-associated cirrhosis',exact:true}).click();await expect(editor).toContainText('Applied shape and appearance to liver');
  const disease=await snapshot(page);expect(liver(disease).shape).not.toBe(liver(joint).shape);expect(liver(disease).texture).not.toBe(liver(joint).texture);expect(disease.tools).toBe(false);
  await page.screenshot({path:info.outputPath('disease-applied.png')});await writeFile(info.outputPath('generation.json'),JSON.stringify({before,joint,disease},null,2));
});
