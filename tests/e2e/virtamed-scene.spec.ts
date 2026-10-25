import { expect,test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("operative film changes material only, preserves replay, and offers a clean field",async({page})=>{
  await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  const residue=page.getByRole('slider',{name:'Operative residue',exact:true});await expect(residue).toBeDisabled();
  await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();
  const before=await read();expect(before.organs.every((o:any)=>o.appearance.operative.amount===.5)).toBe(true);
  expect(before.organs[0].appearance.operative.sha256).toMatch(/^[a-f0-9]{64}$/);
  await residue.press('Home');await expect.poll(async()=>(await read()).organs[0].appearance.operative.amount).toBe(0);
  const clean=await read();expect(clean.organs.map((o:any)=>o.geometrySignature)).toEqual(before.organs.map((o:any)=>o.geometrySignature));
  expect(clean.camera.position).toEqual(before.camera.position);expect(clean.organs[0].materialSignature).not.toBe(before.organs[0].materialSignature);
  await residue.press('End');await expect.poll(async()=>(await read()).organs[0].appearance.operative.amount).toBe(1);
  await page.getByRole('textbox',{name:'Scene seed',exact:true}).fill('481');await page.getByRole('button',{name:'Replay seed',exact:true}).click();
  const varied=await read();await page.getByRole('button',{name:'Replay seed',exact:true}).click();
  expect((await read()).organs.map((o:any)=>o.materialSignature)).toEqual(varied.organs.map((o:any)=>o.materialSignature));
  await page.getByRole('button',{name:'White geometry',exact:true}).click();await expect(residue).toBeDisabled();
  expect((await read()).organs.every((o:any)=>o.appearance.operative.amount===0)).toBe(true);
});

test("a corrupted operative descriptor is rejected before scene publication",async({page})=>{
  await page.route('**/operative-appearance/morphology.png',route=>route.fulfill({status:200,contentType:'image/png',body:Buffer.from('corrupt')}));
  await page.goto('?mode=scene&scene=virtamed');await expect(page.getByRole('alert')).toContainText('Operative morphology checksum mismatch',{timeout:90000});
  await expect(page.locator('[data-scene-ready="true"]')).toHaveCount(0);
});

test("interior inspection uses the same camera lighting in all three abdominal entries",async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
  await page.goto('?mode=scene');await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  for(const [i,label] of ['Under the liver','Stomach & spleen','Bowel & mesentery'].entries()){
    await page.locator(i===0?'.whole-camera-entry':'.whole-exploration').getByRole('button',{name:label,exact:true}).click();
    await expect.poll(async()=>(await read()).camera.navigation.mode).toBe('explore');
    const entry=await read();expect(entry.rendering.optics.active).toBe(true);expect(entry.rendering.laparoscope.emitters.every((l:any)=>l.intensity>0&&l.castsShadow)).toBe(true);
    await page.getByRole('button',{name:'Look right',exact:true}).click();await page.getByRole('button',{name:'Move camera back',exact:true}).click();
    await expect.poll(async()=>(await read()).camera.navigation.direction).not.toEqual(entry.camera.navigation.direction);
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const turned=await read();if(JSON.stringify(turned.camera.position)===JSON.stringify(entry.camera.position))expect(turned.camera.navigation.blocked).toBe(true);
    if(process.env.OPTICS_INSIDE_OUTPUT)await page.locator('.whole-scene-canvas').screenshot({path:`${process.env.OPTICS_INSIDE_OUTPUT}/entry-${i}.png`});
  }
  await page.getByRole('button',{name:'Exit interior exploration',exact:true}).click();await expect.poll(async()=>(await read()).rendering.optics.active).toBe(false);expect(errors).toEqual([]);
});

test("laparoscope fibers and HDR optics follow the camera without moving tissue detail",async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
  await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  const before=await read(),canvas=page.locator('.whole-scene-canvas canvas'),box=(await canvas.boundingBox())!;
  expect(before.rendering.laparoscope.emitters).toHaveLength(2);expect(before.rendering.laparoscope.inverseSquare).toBe(true);
  expect(before.rendering.optics.hdr).toBe('RGBA16F');expect(before.rendering.optics.glareStrength).toBeGreaterThan(0);
  await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6+65,box.y+box.height*.5+12,{steps:16});await page.mouse.up();
  await expect.poll(async()=>(await read()).camera.position).not.toEqual(before.camera.position);
  const after=await read();expect(after.organs.map((p:any)=>p.materialSignature)).toEqual(before.organs.map((p:any)=>p.materialSignature));
  for(const [i,emitter] of after.rendering.laparoscope.emitters.entries()){
    expect(emitter.castsShadow).toBe(true);expect(emitter.positionMm).not.toEqual(before.rendering.laparoscope.emitters[i].positionMm);
    const distance=Math.hypot(...emitter.positionMm.map((v:number,j:number)=>v-after.camera.position[j]));
    expect(distance).toBeCloseTo(Math.hypot(...emitter.offsetMm),5);
  }
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save image',exact:true}).click();
  const file=await download,png=await readFile((await file.path())!);
  expect(png.subarray(1,4).toString()).toBe('PNG');expect(Math.max(png.readUInt32BE(16),png.readUInt32BE(20))).toBe(4096);
  if(process.env.OPTICS_CAPTURE_OUTPUT)await file.saveAs(process.env.OPTICS_CAPTURE_OUTPUT);
  // The backend-status banner can resize the live page during a cold load.
  // Export must restore the CURRENT drawing buffer, not an earlier layout.
  await expect.poll(async()=>page.evaluate(()=>{
    const canvas=document.querySelector('.whole-scene-canvas canvas') as HTMLCanvasElement;
    const snapshot=(window as any).__visceraSceneSnapshot();
    return {actual:snapshot.rendering.optics.glareResolution,expected:[Math.ceil(canvas.width/2),Math.ceil(canvas.height/2)]};
  }).then(value=>JSON.stringify(value.actual)===JSON.stringify(value.expected))).toBe(true);
  const restored=await read();expect(Math.max(...restored.rendering.optics.glareResolution)).toBeLessThan(2048);
  expect(errors).toEqual([]);
});

test("unforced resting physics avoids redundant mesh uploads and wakes on palpation",async({page})=>{
  await page.goto("?mode=scene&scene=virtamed");await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  await page.getByRole('button',{name:'Apply learned physics to all organs',exact:true}).click();
  await expect.poll(async()=>(await read()).physics?.running).toBe(true);
  await page.getByRole('checkbox',{name:/Breathing/}).uncheck();await page.getByRole('button',{name:'Reset motion',exact:true}).click();
  await page.waitForTimeout(700);const a=await read();await page.waitForTimeout(1100);const b=await read();
  expect(b.physics.time_s).toBeGreaterThan(a.physics.time_s);expect(b.rendering.geometryUploads).toBe(a.rendering.geometryUploads);
  expect(b.renderedFrames-a.renderedFrames).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'Palpate selected organ',exact:true}).click();
  await expect.poll(async()=>(await read()).rendering.geometryUploads).toBeGreaterThan(b.rendering.geometryUploads);
  await expect.poll(async()=>(await read()).physics.peak_displacement_mm).toBeGreaterThan(.01);
});

test("white scene, verified learned maps, material-only switch and supported-wall physics",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("?mode=scene&scene=virtamed");await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  const white=await read();expect(white.organs).toHaveLength(12);expect(white.surfaceMode).toBe("white");
  await page.getByRole("button",{name:"Apply learned textures",exact:true}).click();await expect.poll(async()=>(await read()).surfaceMode).toBe("learned-tissue");
  const tissue=await read();expect(tissue.organs.map((p:any)=>p.geometrySignature)).toEqual(white.organs.map((p:any)=>p.geometrySignature));
  expect(tissue.organs.filter((p:any)=>p.appearance?.sha256)).toHaveLength(4);expect(tissue.inspection.cameraLight.enabled).toBe(true);
  const vascular=tissue.organs.filter((p:any)=>p.appearance?.surfaceVessels);
  expect(vascular).toHaveLength(9);
  for(const part of vascular){expect(part.appearance.surfaceVessels.source).toBe('shared-organ-surface-network/1');expect(part.appearance.surfaceVessels.branches).toBeGreaterThan(8);}
  expect(tissue.videoReconstruction.interfaces.edges).toHaveLength(5);expect(tissue.videoReconstruction.interfaces.covers.length).toBeGreaterThan(0);
  const band=tissue.organs.find((p:any)=>p.id==='falciform-ligament').materialSignature;
  await page.getByRole('textbox',{name:'Scene seed',exact:true}).fill('319');await page.getByRole('combobox',{name:'Disease variation',exact:true}).selectOption('liver-cirrhosis');await page.getByRole('button',{name:'Replay seed',exact:true}).click();
  const varied=await read();expect(varied.organs.find((p:any)=>p.id==='falciform-ligament').materialSignature).not.toBe(band);
  await page.getByRole('button',{name:'Replay seed',exact:true}).click();expect((await read()).organs.map((p:any)=>[p.geometrySignature,p.materialSignature])).toEqual(varied.organs.map((p:any)=>[p.geometrySignature,p.materialSignature]));
  await page.getByRole("button",{name:"Apply learned physics to all organs",exact:true}).click();await expect.poll(async()=>(await read()).physics?.running).toBe(true);
  const physics=await read();expect(physics.physics.organs).toHaveLength(12);expect(physics.physics.organs.map((p:any)=>p.id)).toContain("abdominal-wall");
  await page.getByRole("button",{name:"White geometry",exact:true}).click();await expect.poll(async()=>(await read()).surfaceMode).toBe("white");
  expect((await read()).physics.running).toBe(true);expect(errors).toEqual([]);
});
test("Import 3D opens and exports the complete white scene",async({page})=>{
  await page.goto("?mode=imports");await page.getByRole("button",{name:"VirtaMed scene",exact:true}).click();
  await expect(page.getByRole("link",{name:"Open scene texture & physics lab ↗",exact:true})).toBeVisible({timeout:90000});
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export GLB",exact:true}).click();
  const file=await download,bytes=await readFile((await file.path())!);expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());expect(doc.meshes).toHaveLength(12);expect(doc.images??[]).toHaveLength(0);
  expect(doc.nodes.filter((n:any)=>n.mesh!==undefined).map((n:any)=>n.name)).toContain("hepatocystic-fat");
});
test("a corrupted scene is rejected atomically",async({page})=>{
  await page.route("**/anatomy-scene/virtamed-scene.glb",route=>route.fulfill({status:200,contentType:"model/gltf-binary",body:Buffer.from("corrupt")}));
  await page.goto("?mode=scene&scene=virtamed");await expect(page.getByRole("alert")).toContainText("integrity check",{timeout:90000});
  await expect(page.locator('[data-scene-ready="true"]')).toHaveCount(0);
});
test("scene controls fit a narrow screen",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto("?mode=scene&scene=virtamed");await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  await page.getByRole("button",{name:"Apply learned textures",exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
});

test("the enclosed cavity can be inspected and the same camera retained for instruments",async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|Shader|THREE/.test(m.text()))errors.push(m.text());});
  await page.goto('?mode=scene&scene=virtamed');await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.evaluate(()=> (window as any).__visceraSceneSnapshot());
  await page.getByRole('button',{name:'Apply learned textures',exact:true}).click();
  await page.getByRole('button',{name:'Apply learned physics to all organs',exact:true}).click();
  await expect.poll(async()=>(await read()).physics?.running).toBe(true);
  await page.getByRole('button',{name:'Explore cavity',exact:true}).click();
  await expect.poll(async()=>(await read()).camera.navigation.mode).toBe('explore');
  for(let i=0;i<12;i++)await page.getByRole('button',{name:'Look left',exact:true}).click();
  const interior=await read();expect(interior.rendering.optics.active).toBe(true);
  await page.getByRole('button',{name:'Use this view for instruments',exact:true}).click();
  await expect.poll(async()=>(await read()).camera.navigation.mode).toBe('orbit');
  const retained=await read();for(const field of ["position","target"])expect(Math.hypot(...retained.camera[field].map((v:number,i:number)=>v-interior.camera[field][i]))).toBeLessThan(1e-8);
  expect(retained.rendering.optics.active).toBe(true);expect(retained.physics.running).toBe(true);
  expect(retained.physics.organs.find((o:any)=>o.id==='abdominal-wall')).toBeTruthy();
  await expect(page.getByRole('button',{name:'Push',exact:true})).toBeEnabled();
  expect(retained.inspection.cameraLight.intensity).toBe(interior.inspection.cameraLight.intensity);
  expect(retained.inspection.cameraLight.intensity).toBeGreaterThan(0);
  expect(retained.inspection.cameraLight.intensity).toBeLessThan(155000);
  // Returning from another inspection must restore the close camera's light,
  // rather than brightening it to the distant video-view preset.
  await page.getByRole('button',{name:'Explore cavity',exact:true}).click();
  await expect.poll(async()=>(await read()).camera.navigation.mode).toBe('explore');
  await page.getByRole('button',{name:'Look right',exact:true}).click();
  await expect.poll(async()=>(await read()).camera.navigation.direction).not.toEqual(retained.camera.navigation.direction);
  await page.getByRole('button',{name:'Return to orbit',exact:true}).click();
  await expect.poll(async()=>(await read()).camera.navigation.mode).toBe('orbit');
  await expect.poll(async()=>(await read()).rendering.laparoscope.totalIntensity).toBe(retained.inspection.cameraLight.intensity);
  const restored=await read();
  for(const field of ["position","target","up"])expect(Math.hypot(...restored.camera[field].map((v:number,i:number)=>v-retained.camera[field][i]))).toBeLessThan(1e-8);
  expect(restored.camera.fov).toBe(retained.camera.fov);
  expect(restored.inspection.cameraLight.intensity).toBe(retained.inspection.cameraLight.intensity);
  expect(restored.rendering.optics.active).toBe(true);
  expect(errors).toEqual([]);
});
