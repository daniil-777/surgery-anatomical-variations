/** Run with node scripts/benchmark_atlas_sculpt.mjs [realized-scene.json]. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const source = readFileSync(new URL("../apps/studio/src/atlasSurfaceSculpt.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { beginSurfaceSculpt } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function sphere(depth) {
  const positions = [1,0,0, -1,0,0, 0,1,0, 0,-1,0, 0,0,1, 0,0,-1];
  let indices = [0,2,4, 2,1,4, 1,3,4, 3,0,4, 2,0,5, 1,2,5, 3,1,5, 0,3,5];
  for (let d = 0; d < depth; d++) {
    const cache = new Map(), next = [];
    function midpoint(a,b) {
      const key = `${Math.min(a,b)}:${Math.max(a,b)}`;
      if (cache.has(key)) return cache.get(key);
      const xyz = [0,1,2].map(k => positions[a*3+k]+positions[b*3+k]);
      const length = Math.hypot(...xyz), id = positions.length/3;
      positions.push(...xyz.map(x => x/length)); cache.set(key,id); return id;
    }
    for (let i=0;i<indices.length;i+=3) {
      const [a,b,c]=indices.slice(i,i+3), ab=midpoint(a,b), bc=midpoint(b,c), ca=midpoint(c,a);
      next.push(a,ab,ca, ab,b,bc, ca,bc,c, ab,bc,ca);
    }
    indices=next;
  }
  return {positions,indices,name:`sphere-depth-${depth}`,radius:0.8,delta:[0.12,0.03,0.04]};
}

const meshes = [sphere(5), sphere(6), sphere(7)];
if (process.argv[2]) {
  const data = JSON.parse(readFileSync(process.argv[2],"utf8")), scene=data.scene??data;
  for (const organ of scene.organs) meshes.push({...organ,name:organ.name??organ.id,radius:35,delta:[12,3,4]});
}
const results = [];
for (const mesh of meshes) {
  const faceIndex=0, point=[0,1,2].map(k => mesh.indices.slice(0,3).reduce((sum,v)=>sum+mesh.positions[v*3+k],0)/3);
  const setupStart=performance.now();
  const stroke=beginSurfaceSculpt({...mesh,faceIndex,point,guardPositions:mesh.positions});
  const setupMs=performance.now()-setupStart;
  for(let frame=0;frame<5;frame++)stroke.update(mesh.delta);
  const durations=[]; let result;
  for(let frame=0;frame<60;frame++) {
    const start=performance.now();
    result=stroke.update(mesh.delta.map(x=>x*Math.sin((frame+1)/60*Math.PI/2)));
    durations.push(performance.now()-start);
  }
  durations.sort((a,b)=>a-b);
  results.push({name:mesh.name,vertices:mesh.positions.length/3,triangles:mesh.indices.length/3,setupMs,updateMedianMs:durations[30],updateP95Ms:durations[57],diagnostics:result.diagnostics});
}
console.log(JSON.stringify({date:"2026-10-07",runtime:process.version,platform:process.platform,script:fileURLToPath(import.meta.url),scope:"CPU solver only; excludes browser normal recompute, GPU render and pointer events",results},null,2));
