/** Fixed camera, actual atlas meshes and production variation code. No image retouching. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const output = path.resolve(process.env.REVIEW_OUTPUT ?? 'artifacts/laparoscopic-2026-10-24/baseline');
if((await readdir(output).catch(()=>[])).length)throw new Error('Use a new empty evidence folder.');
await mkdir(output, {recursive:true});
const sourceSha=Object.fromEntries(await Promise.all((await readdir('apps/studio/src/imports')).filter(f=>/\.(ts|tsx)$/.test(f)).map(async f=>[f,createHash('sha256').update(await readFile('apps/studio/src/imports/'+f)).digest('hex')])));
const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-gl=angle','--use-angle=metal']});
const page = await browser.newPage({viewport:{width:1200,height:900}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:5176/?mode=imports' + (process.env.REVIEW_SCOPE ? '#scope' : ''));
 await page.evaluate(async () => {
  const T = await import('/node_modules/.vite/deps/three.js');
  const V = await import('/src/imports/variations.ts');
  const L = await import('/src/imports/laparoscopicScene.ts');
  const {RoomEnvironment} = await import('/node_modules/.vite/deps/three_examples_jsm_environments_RoomEnvironment__js.js');
  const model = await L.loadLaparoscopicSceneModel();
  const system = await V.loadImportedVariationSystem();
  document.body.innerHTML=''; document.body.style.margin='0';
  const renderer = new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(1200,900); renderer.setPixelRatio(1); renderer.toneMapping=T.ACESFilmicToneMapping;
  renderer.setClearColor(0x101b20); document.body.append(renderer.domElement);
  const scene=new T.Scene(), camera=new T.PerspectiveCamera(35,4/3,.01,10000);
  let rig;
  if (location.hash.includes('scope')) {
    const {createSurgicalLighting}=await import('/src/imports/surgicalLighting.ts');
    rig=createSurgicalLighting(scene,renderer,camera);
  } else {
    scene.add(new T.HemisphereLight(0xeaf5ff,0x34453c,1.3));
    const key=new T.DirectionalLight(0xfff3e4,2.6);key.position.set(4,6,5);scene.add(key);
    const fill=new T.DirectionalLight(0xc7ddff,1);fill.position.set(-4,1,-3);scene.add(fill);
    const g=new T.PMREMGenerator(renderer);scene.environment=g.fromScene(new RoomEnvironment(),.04).texture;
  }
  window.review={T,V,model,system,renderer,scene,camera,rig};
 });
 let cases=[['liver',null],['liver','liver-cirrhosis'],['liver','liver-steatotic'],['liver','liver-metastases'],['liver','liver-capsular-cyst'],['gallbladder','gallbladder-cholecystitis'],['pancreas','pancreas-pancreatitis'],['small-intestine','small-intestine-crohn']];
 if(process.env.REVIEW_CASES)cases=cases.filter(([organ])=>process.env.REVIEW_CASES.split(',').includes(organ));
 await page.evaluate(({seed,severity})=>{window.review.seed=seed;window.review.severity=severity;},{seed:Number(process.env.REVIEW_SEED??42),severity:process.env.REVIEW_SEVERITY??'severe'});
 const receipts=[];
 for (const [organ,wanted] of cases) {
  const result=await page.evaluate(async ({organ,wanted})=>{
   const {T,V,model,system,renderer,scene,camera,rig}=window.review;
   if(window.review.current) {scene.remove(window.review.current);V.disposeVariationState(window.review.state);}
   const source=model.root.children.find(m=>m.name===organ); const mesh=source.clone(); mesh.geometry=source.geometry.clone();
   const root=new T.Group();root.add(mesh);scene.add(root);
   const state=V.createVariationState(root);window.review.current=root;window.review.state=state;
   const reference=system.references.find(r=>r.organ===organ);
   const profile=wanted ? system.profiles.find(p=>p.id===wanted || (p.organ===organ && p.id.includes(wanted.split('-').at(-1)))) : null;
   if(wanted&&!profile)throw new Error(`Missing profile ${wanted}; ${system.profiles.filter(p=>p.organ===organ).map(p=>p.id)}`);
   const recipe=V.sampleNeuralVariation(system,{referenceId:reference.id,seed:Number(window.review.seed??42),temperature:.35,...(profile?{profileId:profile.id,severity:window.review.severity??'severe'}:{})});
   const report=await V.applyVariation(state,recipe,{shapeStrength:.72,textureStrength:.9,synthesizeSeamlessTextures:true});
   root.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
   const box=new T.Box3().setFromObject(root),center=box.getCenter(new T.Vector3()),radius=box.getSize(new T.Vector3()).length()*.5;
   camera.position.copy(center).addScaledVector(new T.Vector3(.25,.1,1).normalize(),radius/Math.sin(camera.fov*Math.PI/360)*1.08);camera.lookAt(center);
   camera.near=radius/1000;camera.far=radius*100;camera.updateProjectionMatrix();rig?.update(center,radius);renderer.render(scene,camera);
   return {organ,profile:profile?.id,recipe,report};
  },{organ,wanted});
  const label=wanted??`${organ}-healthy`;
  await page.screenshot({path:path.join(output,`${label}.png`)});
  receipts.push(result);console.log(label);
  if(process.env.REVIEW_BACK){
   await page.evaluate(()=>{const {T,current,scene,renderer,camera,rig}=window.review;const box=new T.Box3().setFromObject(current),center=box.getCenter(new T.Vector3()),radius=box.getSize(new T.Vector3()).length()*.5;camera.position.copy(center).addScaledVector(new T.Vector3(.3,-.6,-1).normalize(),radius/Math.sin(camera.fov*Math.PI/360));camera.lookAt(center);camera.updateMatrixWorld();rig?.update(center,radius);renderer.render(scene,camera);});
   await page.screenshot({path:path.join(output,`${label}-posterior.png`)});
  }
  if(process.env.REVIEW_DIAGNOSTIC && !wanted) {
   for(const mode of ['no-normal','no-shadow','matte']) {
    await page.evaluate(mode=>{const {current,renderer,scene,camera}=window.review;current.traverse(n=>{if(n.isMesh){if(mode==='no-normal'){n.material.normalMap=null;n.material.needsUpdate=true;}if(mode==='matte'){n.material.clearcoat=0;n.material.roughness=.8;}}});if(mode==='no-shadow')renderer.shadowMap.enabled=false;renderer.render(scene,camera);},mode);
    await page.screenshot({path:path.join(output,`${label}-${mode}.png`)});
   }
  }
 }
 if(process.env.REVIEW_EXPORT && cases.length) {
  const download=page.waitForEvent('download',{timeout:120000});download.catch(()=>null);
  const receipt=await page.evaluate(async()=>{
   const {current,model,scene,renderer,camera,rig,T}=window.review;
   const {exportImportedModelGLB,loadImportedModel}=await import('/src/imports/importModel.ts');
   const before=current.children.find(n=>n.isMesh),blob=await exportImportedModelGLB({...model,root:current});
   const roundtrip=await loadImportedModel([new File([blob],'surface-phenotype.glb',{type:'model/gltf-binary'})]);
   let after;roundtrip.root.traverse(n=>{if(n.isMesh&&!after)after=n;});
   const attributes={};
   for(const name of ['position','normal','uv','color','tangent']) {
    const a=before.geometry.getAttribute(name),b=after.geometry.getAttribute(name);let maxError=0;
    if(!a&&!b)continue;if(!a||!b||a.count!==b.count)throw new Error(`Export changed ${name} layout`);
    for(let i=0;i<a.array.length;i++)maxError=Math.max(maxError,Math.abs(a.array[i]-b.array[i]));
    if(maxError>1e-6)throw new Error(`Export changed ${name}: ${maxError}`);attributes[name]=maxError;
   }
   const channels={};for(const role of ['map','normalMap','roughnessMap','clearcoatNormalMap','clearcoatRoughnessMap']){
    const a=before.material[role],b=after.material[role];if(!a&&!b)continue;
    if(!a||!b)throw new Error(`Lost ${role}`);
    const canvas=document.createElement('canvas');canvas.width=b.image.width;canvas.height=b.image.height;const ctx=canvas.getContext('2d');ctx.drawImage(b.image,0,0);
    const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data;let maxError=0;
    for(let i=0;i<bytes.length;i++){if(role.includes('Roughness')||role==='roughnessMap'){if(i%4!==1)continue;}maxError=Math.max(maxError,Math.abs(bytes[i]-a.image.data[i]));}
    if(maxError>1)throw new Error(`Export changed ${role}: ${maxError}`);channels[role]=maxError;
   }
   scene.remove(current);scene.add(roundtrip.root);window.review.roundtripRoot=roundtrip.root;roundtrip.root.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});renderer.render(scene,camera);
   const anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download='surface-phenotype.glb';anchor.click();
   return {bytes:blob.size,attributes,channels,stats:roundtrip.stats};
  });
  await page.screenshot({path:path.join(output,'export-roundtrip.png')});receipts.push({export:receipt});await (await download).saveAs(path.join(output,'surface-phenotype.glb'));
 }
 if(process.env.REVIEW_SCENE) {
  await page.evaluate(async()=>{
   const {T,V,model,system,scene,renderer,camera}=window.review;
   if(window.review.current) {scene.remove(window.review.current);V.disposeVariationState(window.review.state);}
   if(window.review.roundtripRoot)scene.remove(window.review.roundtripRoot);
   scene.add(model.root);const state=V.createVariationState(model.root);
   const report=await V.applySceneVariation(state,system,{seed:42,temperature:.4,shapeStrength:.45,textureStrength:.9,synthesizeSeamlessTextures:true});
   model.root.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
   window.review.current=model.root;window.review.state=state;window.review.sceneReport=report;
  });
  for(const view of ['anterior','subhepatic','posterior']) {
   await page.evaluate(view=>{
    const {T,model,scene,renderer,camera,rig}=window.review;
    const box=new T.Box3().setFromObject(model.root),center=box.getCenter(new T.Vector3()),radius=box.getSize(new T.Vector3()).length()*.5;
    let distance=radius/Math.sin(camera.fov*Math.PI/360)*1.03,dir=new T.Vector3(0,.05,1);
    if(view==='posterior')dir.z=-1;
    if(view==='subhepatic'){const focus=new T.Box3();model.root.traverse(n=>{if(n.isMesh && /gallbladder|hepatic-duct|portal-vein/.test(n.name))focus.expandByObject(n);});focus.getCenter(center);distance=focus.getSize(new T.Vector3()).length()*.5/Math.sin(camera.fov*Math.PI/360)*1.5;dir.set(.15,-.65,1);}
    camera.position.copy(center).addScaledVector(dir.normalize(),distance);camera.lookAt(center);camera.updateMatrixWorld();rig?.update(center,radius);renderer.render(scene,camera);
   },view);
   await page.screenshot({path:path.join(output,`scene-${view}.png`)});
  }
  receipts.push(await page.evaluate(()=>window.review.sceneReport));
  if(process.env.REVIEW_EXPORT){
   const download=page.waitForEvent('download',{timeout:120000});download.catch(()=>null);
   const exported=await page.evaluate(async()=>{
    const {model}=window.review;const {exportImportedModelGLB,loadImportedModel}=await import('/src/imports/importModel.ts');
    const start=performance.now(),blob=await exportImportedModelGLB(model);
    const imported=await loadImportedModel([new File([blob],'laparoscopic-scene.glb',{type:'model/gltf-binary'})]);
    const anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download='laparoscopic-scene.glb';anchor.click();
    return {bytes:blob.size,elapsedMs:performance.now()-start,stats:imported.stats};
   });
   await(await download).saveAs(path.join(output,'laparoscopic-scene.glb'));receipts.push({fullSceneExport:exported});
  }
 }
 await writeFile(path.join(output,'receipt.json'),JSON.stringify({sourceSha,cases:receipts,errors},null,2));
} catch(error) {await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),errors,sourceSha},null,2));throw error;} finally {await browser.close();}
