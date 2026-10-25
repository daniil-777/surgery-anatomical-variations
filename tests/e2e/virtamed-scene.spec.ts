import { expect,test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("unforced resting physics avoids redundant mesh uploads and wakes on palpation",async({page})=>{
  await page.goto("/?mode=scene&scene=virtamed");await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  await page.getByRole('button',{name:'Apply learned physics to all organs',exact:true}).click();
  await page.getByRole('checkbox',{name:/Breathing/}).uncheck();await page.getByRole('button',{name:'Reset motion',exact:true}).click();
  await page.waitForTimeout(700);const a=await read();await page.waitForTimeout(1100);const b=await read();
  expect(b.physics.time_s).toBeGreaterThan(a.physics.time_s);expect(b.rendering.geometryUploads).toBe(a.rendering.geometryUploads);
  expect(b.renderedFrames-a.renderedFrames).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'Palpate selected organ',exact:true}).click();
  await expect.poll(async()=>(await read()).rendering.geometryUploads).toBeGreaterThan(b.rendering.geometryUploads);
  await expect.poll(async()=>(await read()).physics.peak_displacement_mm).toBeGreaterThan(.01);
});

test("white scene, verified learned maps, material-only switch and fixed-wall physics",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/?mode=scene&scene=virtamed");await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  const read=()=>page.locator('[data-scene-snapshot]').getAttribute('data-scene-snapshot').then(s=>JSON.parse(s!));
  const white=await read();expect(white.organs).toHaveLength(12);expect(white.surfaceMode).toBe("white");
  await page.getByRole("button",{name:"Apply learned textures",exact:true}).click();await expect.poll(async()=>(await read()).surfaceMode).toBe("learned-tissue");
  const tissue=await read();expect(tissue.organs.map((p:any)=>p.geometrySignature)).toEqual(white.organs.map((p:any)=>p.geometrySignature));
  expect(tissue.organs.filter((p:any)=>p.appearance?.sha256)).toHaveLength(4);expect(tissue.inspection.cameraLight.enabled).toBe(true);
  expect(tissue.videoReconstruction.interfaces.edges).toHaveLength(4);expect(tissue.videoReconstruction.interfaces.covers.length).toBeGreaterThan(0);
  const band=tissue.organs.find((p:any)=>p.id==='falciform-ligament').materialSignature;
  await page.getByRole('textbox',{name:'Scene seed',exact:true}).fill('319');await page.getByRole('combobox',{name:'Disease variation',exact:true}).selectOption('liver-cirrhosis');await page.getByRole('button',{name:'Replay seed',exact:true}).click();
  const varied=await read();expect(varied.organs.find((p:any)=>p.id==='falciform-ligament').materialSignature).not.toBe(band);
  await page.getByRole('button',{name:'Replay seed',exact:true}).click();expect((await read()).organs.map((p:any)=>[p.geometrySignature,p.materialSignature])).toEqual(varied.organs.map((p:any)=>[p.geometrySignature,p.materialSignature]));
  await page.getByRole("button",{name:"Apply learned physics to all organs",exact:true}).click();await expect.poll(async()=>(await read()).physics?.running).toBe(true);
  const physics=await read();expect(physics.physics.organs).toHaveLength(11);expect(physics.physics.organs.map((p:any)=>p.id)).not.toContain("abdominal-wall");
  await page.getByRole("button",{name:"White geometry",exact:true}).click();await expect.poll(async()=>(await read()).surfaceMode).toBe("white");
  expect((await read()).physics.running).toBe(true);expect(errors).toEqual([]);
});
test("Import 3D opens and exports the complete white scene",async({page})=>{
  await page.goto("/?mode=imports");await page.getByRole("button",{name:"VirtaMed scene",exact:true}).click();
  await expect(page.getByRole("link",{name:"Open scene texture & physics lab ↗",exact:true})).toBeVisible({timeout:90000});
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export GLB",exact:true}).click();
  const file=await download,bytes=await readFile((await file.path())!);expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());expect(doc.meshes).toHaveLength(12);expect(doc.images??[]).toHaveLength(0);
  expect(doc.nodes.filter((n:any)=>n.mesh!==undefined).map((n:any)=>n.name)).toContain("hepatocystic-fat");
});
test("a corrupted scene is rejected atomically",async({page})=>{
  await page.route("**/anatomy-scene/virtamed-scene.glb",route=>route.fulfill({status:200,contentType:"model/gltf-binary",body:Buffer.from("corrupt")}));
  await page.goto("/?mode=scene&scene=virtamed");await expect(page.getByRole("alert")).toContainText("integrity check",{timeout:90000});
  await expect(page.locator('[data-scene-ready="true"]')).toHaveCount(0);
});
test("scene controls fit a narrow screen",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto("/?mode=scene&scene=virtamed");await expect(page.locator('[data-scene-ready="true"]')).toBeVisible();
  await page.getByRole("button",{name:"Apply learned textures",exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
});
