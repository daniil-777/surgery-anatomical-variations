import { expect, test, type Page } from '@playwright/test';
import { SphereGeometry } from 'three';
import fixture from './fixtures/atlas-material-v2.json' with {type:'json'};
import type { AtlasSpec } from '../../apps/studio/src/atlas';
const keys=['scale_x','scale_y','scale_z','bend','twist','taper','asymmetry'];
const catalog={organs:[{id:'liver',label:'Liver',templates:[{id:'liver-reference',label:'Reference',source:'Synthetic test surface',license:'Original test fixture'}]}],controls:keys.map((key,i)=>({key,label:['Width','Height','Depth','Bend','Twist','Taper','Asymmetry'][i],min:-1,max:1,default:0})),materials:fixture.catalog};
const sphere=new SphereGeometry(75,48,32);sphere.scale(1.4,.9,1);
const positions=Array.from(sphere.attributes.position!.array),indices=Array.from(sphere.index!.array);
async function setup(page:Page){
 const exported:Record<string,any>[]=[];
 await page.route('**/api/atlas/catalog',route=>route.fulfill({json:catalog}));
 await page.route('**/api/atlas/generate',route=>{
  const spec=route.request().postDataJSON() as AtlasSpec,material=spec.material;
  const resolved=material?structuredClone(fixture.resolved.liver[material.preset]):null;
  if(resolved&&material)Object.assign(resolved.uniforms,{uAtlasSeed:material.seed,uAtlasWetness:material.wetness,uAtlasFineDetail:material.fine_detail});
  return route.fulfill({json:{spec:{...spec,realized_id:'fixture-bound'},summary:{},scene:{organs:[{id:'organ',name:'Test liver',kind:'organ',color:'#913831',positions,indices,...(material?{rest_positions:positions,material_regions:positions.filter((_,i)=>i%3===0).map(()=>0)}:{})}],metadata:{geometry_sha256:'fixture-'+JSON.stringify(spec.controls),...(material?{material_v2:{recipe:material,resolved}}:{})}}}});
 });
 await page.route('**/api/atlas/export',route=>{const req=route.request().postDataJSON();exported.push(req);return route.fulfill({body:Buffer.from(req.format==='unity'?[80,75,3,4]:[103,108,84,70]),contentType:req.format==='unity'?'application/zip':'model/gltf-binary'});});
 await page.goto('/');await expect(page.getByText('Reference geometry loaded',{exact:true})).toBeVisible();
 return exported;
}
async function drag(page:Page,escape=false){
 const box=(await page.getByTestId('atlas-viewport').boundingBox())!;
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
 await page.mouse.move(box.x+box.width*.55,box.y+box.height*.46,{steps:12});
 if(escape)await page.keyboard.press('Escape');
 await page.mouse.up();
}
async function download(page:Page,name='Export GLB') {const promise=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();await promise;}

test('surface dragging, exact history and appearance edits preserve exported sculpture',async({page})=>{
 const exported=await setup(page);await page.getByRole('tab',{name:'Sculpt',exact:true}).click();await drag(page);
 await expect(page.getByRole('button',{name:'Physics lab',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Physics lab',exact:true})).toHaveAccessibleDescription('Reset the sculpture to use the physics lab.');
 await expect(page.getByRole('button',{name:'Undo sculpture',exact:true})).toBeEnabled();await download(page);
 const sculpt=structuredClone(exported.at(-1)!.surface_edits);expect(sculpt).toHaveLength(1);expect(sculpt[0].positions).not.toEqual(positions);
 await page.getByRole('button',{name:'Undo sculpture',exact:true}).click();await download(page);expect(exported.at(-1)!.surface_edits).toBeUndefined();
 await expect(page.getByRole('button',{name:'Physics lab',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Redo sculpture',exact:true}).click();await download(page);expect(exported.at(-1)!.surface_edits).toEqual(sculpt);
 await page.getByRole('tab',{name:'Surface',exact:true}).click();await page.getByRole('slider',{name:'Surface wetness',exact:true}).fill('0.8');await expect(page.getByText('Preview matches this surface',{exact:true})).toBeVisible();
 await download(page,'Export Unity 4K');expect(exported.at(-1)).toMatchObject({format:'unity',texture_resolution:4096,surface_edits:sculpt});
 await page.getByRole('tab',{name:'Shape',exact:true}).click();await page.getByRole('slider',{name:'Width',exact:true}).fill('0.4');await expect(page.getByRole('alert')).toContainText('Reset the sculpture');await expect(page.getByRole('slider',{name:'Width',exact:true})).toHaveValue('0');
 await download(page);expect(exported.at(-1)!.surface_edits).toEqual(sculpt);
});
test('cancelled pointer stroke leaves no sculpture or undo entry',async({page})=>{
 const exported=await setup(page);await page.getByRole('tab',{name:'Sculpt',exact:true}).click();await drag(page,true);
 await expect(page.getByRole('button',{name:'Undo sculpture',exact:true})).toBeDisabled();await download(page);expect(exported.at(-1)!.surface_edits).toBeUndefined();
});
test('vessel controls reach export and can be disabled without changing shape',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const exported=await setup(page);
 await page.getByRole('tab',{name:'Surface',exact:true}).click();await download(page);const before=exported.at(-1)!.surface_vessels[0].network;
 await page.getByRole('slider',{name:'Vessel visibility',exact:true}).fill('0.9');await page.getByRole('button',{name:'New branching pattern',exact:true}).click();await download(page,'Export Unity 4K');
 const after=exported.at(-1)!.surface_vessels[0].network;expect(after.seed).not.toBe(before.seed);expect(after.settings.visibility).toBe(.9);expect(after.segments.length).toBeGreaterThan(10);expect(exported.at(-1)!.surface_edits).toBeUndefined();
 await page.getByRole('checkbox',{name:'Show surface vessels',exact:true}).uncheck();await download(page);expect(exported.at(-1)!.surface_vessels).toEqual([]);expect(errors).toEqual([]);
});
test('mobile touch creates a sculpture and Unity is disabled for clay',async({page,context})=>{
 await page.setViewportSize({width:390,height:844});const exported=await setup(page);
 await page.getByRole('button',{name:'Sculpt',exact:true}).click();
 const box=(await page.getByTestId('atlas-viewport').boundingBox())!,cdp=await context.newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width*.5,y:box.y+box.height*.48}]});
 for(let i=1;i<=12;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width*(.5+i*.004),y:box.y+box.height*(.48-i*.002)}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await expect(page.getByRole('button',{name:'Undo sculpture',exact:true})).toBeEnabled();await download(page);expect(exported.at(-1)!.surface_edits.length).toBe(1);
 await page.getByRole('button',{name:'Clay',exact:true}).click();await expect(page.getByRole('button',{name:'Export Unity 4K',exact:true})).toBeDisabled();
});

test('new reference geometry discards redo snapshots from the old sculpture',async({page})=>{
 await setup(page);await page.getByRole('tab',{name:'Sculpt',exact:true}).click();await drag(page);
 await page.getByRole('button',{name:'Undo sculpture',exact:true}).click();await expect(page.getByRole('button',{name:'Redo sculpture',exact:true})).toBeEnabled();
 await page.getByRole('tab',{name:'Shape',exact:true}).click();await page.getByRole('slider',{name:'Width',exact:true}).fill('0.4');
 await expect(page.getByText('Preview matches this recipe',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Redo sculpture',exact:true})).toBeDisabled();
});
