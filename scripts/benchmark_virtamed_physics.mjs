// CPU benchmark of the shipped scene, including live vertex/normal/bounds work.
// Node 24: node scripts/benchmark_virtamed_physics.mjs /tmp/scene-baseline.json
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(specifier.startsWith('.')&&!/\.[cm]?[jt]sx?$/.test(specifier))return next(`${specifier}.ts`,context);throw error;}}});
const { WholeScenePhysics }=await import('../apps/studio/src/wholeScenePhysics.ts');
const { updateSceneBounds,updateSceneNormals }=await import('../apps/studio/src/sceneSurfaceUpdate.ts');
const root=new URL('../',import.meta.url);
const data=await readFile(new URL('apps/studio/public/anatomy-scene/virtamed-scene.glb',root));
const gltf=await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),'');
gltf.scene.updateMatrixWorld(true);
const manifest=JSON.parse(await readFile(new URL('apps/studio/public/anatomy-scene/virtamed-manifest.json',root),'utf8'));
const materials=JSON.parse(await readFile(new URL('apps/studio/public/anatomy-scene/virtamed-materials.json',root),'utf8'));
const parts=[];
gltf.scene.traverse(o=>{if(o.isMesh){const geometry=o.geometry.clone().applyMatrix4(o.matrixWorld);geometry.computeBoundingBox();parts.push({id:o.name,category:manifest.organs.find(p=>p.id===o.name).category,geometry,rest:geometry.attributes.position.array.slice()});}});
const summary=a=>{const s=[...a].sort((x,y)=>x-y);return {mean:a.reduce((s,x)=>s+x,0)/a.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)]};};
const runs=[];
for(let repeat=0;repeat<3;repeat++){
  const physics=new WholeScenePhysics(parts.map(p=>({id:p.id,category:p.id==='abdominal-wall'?'skeleton':p.category,bounds:{min:p.geometry.boundingBox.min.toArray(),max:p.geometry.boundingBox.max.toArray()}})),materials);
  const moving=parts.filter(p=>p.id!=='abdominal-wall').map(p=>({...p,binding:physics.bind(p.rest)}));
  const liver=moving.find(p=>p.id==='liver'),point=Array.from(liver.rest.slice(0,3));
  physics.beginToolContact({mode:'grasp',organId:'liver',restPointMm:point,normal:[0,0,1],targetPointMm:[point[0]+3,point[1],point[2]+2],radiusMm:6});
  const solve=[],deform=[],surface=[];
  for(let frame=0;frame<390;frame++){
    const start=performance.now();physics.step(1/60,true);const solved=performance.now();
    for(const p of moving)physics.deform(p.rest,p.geometry.attributes.position.array,p.binding);
    const deformed=performance.now();
    for(const p of moving){
      if(process.env.BENCH_SURFACE==='fast'){if(frame%3===0)updateSceneNormals(p.geometry);updateSceneBounds(p.geometry);}
      else {if(frame%3===0)p.geometry.computeVertexNormals();p.geometry.computeBoundingBox();p.geometry.computeBoundingSphere();}
    }
    const finished=performance.now();
    if(frame>=30){solve.push(solved-start);deform.push(deformed-solved);surface.push(finished-deformed);}
  }
  const state=physics.snapshot();if(!state.finite||state.displacement_gradient_bound>.4500001)throw new Error('Invalid simulated state');
  runs.push({solve_ms:summary(solve),deform_ms:summary(deform),normals_bounds_ms:summary(surface),total_ms:summary(solve.map((v,i)=>v+deform[i]+surface[i])),state});
}
const result={node:process.version,vertices:parts.reduce((s,p)=>s+p.rest.length/3,0),movingVertices:parts.filter(p=>p.id!=='abdominal-wall').reduce((s,p)=>s+p.rest.length/3,0),framesPerRun:360,runs};
await writeFile(process.argv[2]??'/tmp/virtamed-physics-benchmark.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({vertices:result.vertices,movingVertices:result.movingVertices,runs:runs.map(({state,...r})=>r)},null,2));
