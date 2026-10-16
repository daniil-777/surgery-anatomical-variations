// Run from repository root: node scripts/benchmark_liver_continuum_refinement.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const source = ['apps/studio/src/liverPlaygroundSolver.ts', 'apps/studio/src/liverContinuumMaterial.ts'];
const built = await esbuild.build({ entryPoints: [source[0]], bundle: true, platform: 'node', format: 'esm', write: false });
const { LiverPlaygroundSolver } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const fixture = JSON.parse(fs.readFileSync('apps/studio/src/fixtures/liver-playground-female-cage.json'));
const result = { source_sha256: Object.fromEntries(source.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')])), description: 'Step/iteration sensitivity, not proof of converged surgery. Each probe starts at that run’s settled apex; landing trajectories are contact-path dependent.', cases: [] };
const output = process.argv[2] ?? 'benchmarks/results/liver-continuum-2026-10-07/refinement.json';
fs.mkdirSync(path.dirname(output), { recursive: true });
for (const [dt, iterations] of [[1/120,4],[1/240,4],[1/120,8]]) {
  const solver = new LiverPlaygroundSolver(fixture.mesh, fixture.parameters, { materialModel: 'continuum', floorYmm: 0, iterations });
  const start = performance.now(), r = { dt, iterations, probe: [] };
  for (let i = 0; i < Math.round(6/dt); i++) solver.step(dt);
  r.settled = { ...solver.metrics(), positions_mm: Array.from(solver.positionsMm) };
  let top = 0; for (let i = 1; i < solver.positionsMm.length/3; i++) if (solver.positionsMm[3*i+1] > solver.positionsMm[3*top+1]) top = i;
  const apex = Array.from(solver.positionsMm.slice(3*top,3*top+3));
  solver.setProbe([apex[0],apex[1]+6,apex[2]],6); solver.setProbe(apex,6);
  for (let i = 0; i < Math.round(.75/dt); i++) {
    solver.step(dt);
    if ((i+1) % Math.round((1/120)/dt) === 0) {
      const reaction = [0,0,0];
      for (let node=0;node<solver.masses.length;node++) { const g = new Float64Array(3); solver.continuumExternal(node,g,new Float64Array(9)); for(let k=0;k<3;k++) reaction[k]+=g[k]; }
      r.probe.push({ time_s:(i+1)*dt, reaction_n:reaction, penetration_mm:solver.metrics().maximum_probe_penetration_mm });
    }
  }
  r.final = { ...solver.metrics(), positions_mm: Array.from(solver.positionsMm) }; r.wall_seconds=(performance.now()-start)/1000;
  result.cases.push(r); fs.writeFileSync(output, JSON.stringify(result,null,2)); console.log(JSON.stringify({ dt,iterations,volume:r.settled.volume_change_pct,minJ:r.settled.minimum_jacobian,force:r.probe.at(-1).reaction_n,penetration:r.probe.at(-1).penetration_mm,wall:r.wall_seconds }));
}
// A common settled particle/history checkpoint removes differing landings from
// the probe comparison. This benchmark-only access is not a public save API.
const checkpoint = new LiverPlaygroundSolver(fixture.mesh, fixture.parameters, { materialModel: 'continuum', floorYmm: 0 });
for (let i=0;i<720;i++) checkpoint.step();
let apexId=0;for(let i=1;i<checkpoint.masses.length;i++)if(checkpoint.positions[3*i+1]>checkpoint.positions[3*apexId+1])apexId=i;
const apex=Array.from(checkpoint.positionsMm.slice(3*apexId,3*apexId+3));result.common_checkpoint_probe=[];
for(const [dt,iterations] of [[1/120,4],[1/240,4],[1/120,8]]){
 const s=new LiverPlaygroundSolver(fixture.mesh,fixture.parameters,{materialModel:'continuum',floorYmm:0,iterations});
 s.positions.set(checkpoint.positions);s.velocities.set(checkpoint.velocities);s.publish();
 for(let i=0;i<s.continuum.cells.length;i++){s.continuum.cells[i].state.previous.set(checkpoint.continuum.cells[i].state.previous);s.continuum.cells[i].state.memory.set(checkpoint.continuum.cells[i].state.memory);}
 s.setProbe([apex[0],apex[1]+6,apex[2]],6);s.setProbe(apex,6);const history=[];
 for(let i=0;i<Math.round(.75/dt);i++){
  s.step(dt);if((i+1)%Math.round((1/120)/dt)===0){const force=[0,0,0];for(let id=0;id<s.masses.length;id++){const g=new Float64Array(3);s.continuumExternal(id,g,new Float64Array(9));for(let k=0;k<3;k++)force[k]+=g[k];}history.push({time_s:(i+1)*dt,reaction_n:force,penetration_mm:s.metrics().maximum_probe_penetration_mm});}
 }
 const record={dt,iterations,probe:history,metrics:s.metrics(),positions_mm:Array.from(s.positionsMm)};result.common_checkpoint_probe.push(record);fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({common_checkpoint:true,dt,iterations,force:history.at(-1).reaction_n,penetration:history.at(-1).penetration_mm}));
}
const base=result.common_checkpoint_probe[0];
result.common_checkpoint_summary=result.common_checkpoint_probe.slice(1).map(test=>{
 const a=base.probe.flatMap(p=>p.reaction_n),b=test.probe.flatMap(p=>p.reaction_n);
 const relative=(a,b)=>Math.sqrt(a.reduce((s,v,i)=>s+(v-b[i])**2,0)/a.reduce((s,v)=>s+v*v,0));
 const forceCurve=relative(a,b),positions=Math.sqrt(base.positions_mm.reduce((s,v,i)=>s+(v-test.positions_mm[i])**2,0)/(base.positions_mm.length/3));
 return{dt:test.dt,iterations:test.iterations,force_vector_curve_relative_l2:forceCurve,force_vector_endpoint_relative_error:relative(base.probe.at(-1).reaction_n,test.probe.at(-1).reaction_n),corresponding_node_position_rms_mm:positions,force_curve_below_5pct:forceCurve<.05,corresponding_nodes_below_1mm:positions<1};
});
result.full_convergence_gate='NOT_ESTABLISHED: one cage, one contact protocol, no spatial refinement or full force-work comparison';
fs.writeFileSync(output,JSON.stringify(result,null,2));
