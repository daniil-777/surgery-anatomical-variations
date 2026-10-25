import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const editor=(page:Page)=>page.getByRole('region',{name:'Scene text-to-shape editor'});
const snapshot=(page:Page)=>page.evaluate(()=>(window as any).__visceraSceneSnapshot());
const shape=(s:any,id:string)=>s.organs.find((o:any)=>o.id===id).geometrySignature;
const surface=(s:any,id:string)=>s.organs.find((o:any)=>o.id===id).materialSignature;
async function apply(page:Page,text:string){await editor(page).getByRole('textbox').fill(text);await editor(page).getByRole('button',{name:'Apply text',exact:true}).click();}
async function opened(page:Page){await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready=true]')).toBeVisible();}

test('VirtaMed typed disease and hints change shape and appearance; rejection and reset are exact',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Shader|WebGL|THREE/.test(m.text()))errors.push(m.text());});
  await opened(page);await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();
  await page.getByRole('button',{name:'Video camera · instruments enabled',exact:true}).click();
  const before=await snapshot(page);await page.screenshot({path:info.outputPath('baseline.png')});
  await apply(page,'liver-cirrhosis, severity 0.8, wetness 0.4');
  await expect(editor(page)).toContainText('Applied shape and appearance to liver');
  const after=await snapshot(page);expect(shape(after,'liver')).not.toBe(shape(before,'liver'));expect(surface(after,'liver')).not.toBe(surface(before,'liver'));
  expect(after.videoReconstruction.disease).toBe('liver-cirrhosis');
  await editor(page).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('cirrhosis.png')});
  await apply(page,'remove the liver and add an instrument');await expect(editor(page)).not.toContainText('Applied shape and appearance to liver');
  expect((await snapshot(page)).organs.map((o:any)=>[o.geometrySignature,o.materialSignature])).toEqual(after.organs.map((o:any)=>[o.geometrySignature,o.materialSignature]));
  await editor(page).getByRole('combobox',{name:'Text edit target'}).selectOption('gallbladder');
  await editor(page).getByRole('button',{name:'Chronic calculous cholecystitis',exact:true}).click();
  await expect(editor(page)).toContainText('Applied shape and appearance to gallbladder');
  const inflamed=await snapshot(page);expect(shape(inflamed,'gallbladder')).not.toBe(shape(before,'gallbladder'));expect(surface(inflamed,'gallbladder')).not.toBe(surface(before,'gallbladder'));
  expect(inflamed.videoReconstruction.interfaces.edges.some((edge:any)=>edge.edema>0)).toBe(true);
  await page.screenshot({path:info.outputPath('cholecystitis.png')});
  for(const [angle,drag] of [['front',0],['left-oblique',65],['right-oblique',-65]] as const){
    await page.getByRole('button',{name:'Restore video geometry',exact:true}).click();
    await page.getByRole('button',{name:'Video camera · instruments enabled',exact:true}).click();
    const box=(await page.locator('.whole-scene-canvas canvas').boundingBox())!;
    if(drag){await page.mouse.move(box.x+box.width*.65,box.y+box.height*.48);await page.mouse.down();await page.mouse.move(box.x+box.width*.65+drag,box.y+box.height*.48+8,{steps:18});await page.mouse.up();}
    await page.evaluate(async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
    await editor(page).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`baseline-${angle}.png`)});
    await editor(page).getByRole('button',{name:'Chronic calculous cholecystitis',exact:true}).click();
    await expect(editor(page)).toContainText('Applied shape and appearance to gallbladder');
    await page.screenshot({path:info.outputPath(`cholecystitis-${angle}.png`)});
  }
  await page.getByRole('button',{name:'Restore video geometry',exact:true}).click();
  expect((await snapshot(page)).organs.map((o:any)=>o.geometrySignature)).toEqual(before.organs.map((o:any)=>o.geometrySignature));
  await writeFile(info.outputPath('geometry-material-evidence.json'),JSON.stringify({before,after,inflamed,errors},null,2));expect(errors).toEqual([]);
});

async function exported(page:Page){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export GLB',exact:true}).click();const download=await pending;return readFile((await download.path())!);}
function glbMeshes(bytes:Buffer){let json:any,binary:Buffer=Buffer.alloc(0);for(let at=12;at<bytes.length;){const n=bytes.readUInt32LE(at),kind=bytes.readUInt32LE(at+4);if(kind===0x4e4f534a)json=JSON.parse(bytes.subarray(at+8,at+8+n).toString());if(kind===0x004e4942)binary=bytes.subarray(at+8,at+8+n);at+=8+n;}
  const data=(i:number)=>{const a=json.accessors[i],v=json.bufferViews[a.bufferView];return binary.subarray((v.byteOffset??0)+(a.byteOffset??0),(v.byteOffset??0)+(a.byteOffset??0)+a.count*({SCALAR:1,VEC2:2,VEC3:3,VEC4:4} as any)[a.type]*({5126:4,5125:4,5123:2,5121:1} as any)[a.componentType]).toString('base64');};
  return json.nodes.filter((n:any)=>n.mesh!==undefined).map((n:any)=>({name:n.name,primitives:json.meshes[n.mesh].primitives.map((p:any)=>({position:data(p.attributes.POSITION),color:p.attributes.COLOR_0===undefined?null:data(p.attributes.COLOR_0),material:json.materials[p.material]}))}));}

test('multipart upload text targets one mesh, preserves its neighbor, exports edits and restores source',async({page},info)=>{
  await page.goto('?mode=imports');await page.getByLabel('3D model files',{exact:true}).setInputFiles('tests/fixtures/imported-models/colour-pbr-multipart.glb');
  await expect(page.locator('[data-import-ready=true]')).toBeVisible();await expect(editor(page).getByRole('combobox')).toBeEnabled();
  const before=glbMeshes(await exported(page));
  const target=editor(page).getByRole('combobox');const value=await target.inputValue();
  await page.getByRole('combobox',{name:`Reference for ${value.split('#')[0]}`,exact:true}).selectOption('hra-liver-female');
  await editor(page).getByRole('button',{name:'Alcohol-associated cirrhosis',exact:true}).click();
  await expect(editor(page)).toContainText('Shape and appearance applied to');
  const after=glbMeshes(await exported(page));expect(after[0].primitives[0].position).not.toEqual(before[0].primitives[0].position);expect(after[0].primitives[0].color).not.toEqual(before[0].primitives[0].color);expect(after[1]).toEqual(before[1]);
  await page.screenshot({path:info.outputPath('uploaded-text-edit.png')});
  await apply(page,'20% wider');await expect(editor(page)).toContainText('calibrated mesh');expect(glbMeshes(await exported(page))).toEqual(after);
  await page.getByRole('button',{name:'Restore original',exact:true}).click();expect(glbMeshes(await exported(page))).toEqual(before);
});

test('single STL accepts typed disease and restores export',async({page})=>{
  await page.goto('?mode=imports');await page.getByLabel('3D model files',{exact:true}).setInputFiles('tests/fixtures/imported-models/cube-binary.stl');
  await expect(editor(page).getByRole('combobox')).toBeEnabled();await page.getByRole('combobox',{name:'Reference style',exact:true}).selectOption('hra-liver-female');
  const before=glbMeshes(await exported(page));await apply(page,'liver-steatotic-enlargement, severity 0.7');await expect(editor(page)).toContainText('Shape and appearance applied to');
  expect(glbMeshes(await exported(page))).not.toEqual(before);await page.getByRole('button',{name:'Restore original',exact:true}).click();expect(glbMeshes(await exported(page))).toEqual(before);
});

test('microphone transcript uses the same text-to-scene path',async({page},info)=>{
  test.skip(!process.env.SCENE_VOICE_AUDIO,'Set SCENE_VOICE_AUDIO to exercise the real speech engine with prerecorded audio.');
  const wav=await readFile(process.env.SCENE_VOICE_AUDIO!);
  await page.route('**/scene-test-voice.wav',route=>route.fulfill({contentType:'audio/wav',body:wav}));
  await page.addInitScript(()=>{(window as any).__whistleTestAudio='./scene-test-voice.wav';});
  await opened(page);const before=await snapshot(page);
  await editor(page).getByTestId('whistle-mic-button').click();
  await expect(editor(page)).toContainText('Applied shape and appearance to liver',{timeout:100000});
  const after=await snapshot(page);expect(shape(after,'liver')).not.toBe(shape(before,'liver'));expect(surface(after,'liver')).not.toBe(surface(before,'liver'));
  await writeFile(info.outputPath('voice-result.json'),JSON.stringify(await page.evaluate(()=>(window as any).__whistle.lastResult),null,2));
  await page.screenshot({path:info.outputPath('voice-applied.png')});
});

test('scene editor remains usable at a narrow viewport',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await opened(page);
  await editor(page).scrollIntoViewIfNeeded();await expect(editor(page).getByRole('textbox')).toBeVisible();
  await apply(page,'wider; wetter');await expect(editor(page)).toContainText('Applied shape and appearance to liver');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({path:info.outputPath('mobile-editor.png')});
});

test('text changes rebuild active physics and the edited anatomy responds to palpation',async({page},info)=>{
  await opened(page);await page.getByRole('button',{name:'Apply learned physics to all organs',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).physics?.running).toBe(true);
  await page.getByRole('checkbox',{name:/Breathing/}).uncheck();
  await apply(page,'liver-steatotic-enlargement, severity 0.7');await expect(editor(page)).toContainText('Applied shape and appearance to liver');
  await expect.poll(async()=>(await snapshot(page)).tools.ready).toBe(true);
  await page.getByRole('button',{name:'Palpate selected organ',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).physics.peak_displacement_mm).toBeGreaterThan(.001);
  const loaded=await snapshot(page);expect(loaded.physics.running).toBe(true);expect(Number.isFinite(loaded.physics.displacement_mm)).toBe(true);
  await page.getByRole('button',{name:'Reset motion',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page)).physics.displacement_mm).toBeLessThan(.001);
  await writeFile(info.outputPath('edited-physics.json'),JSON.stringify({loaded,reset:await snapshot(page)},null,2));
});
