// Reproduce the shipped weights from the compact recorded RGBD graph (or a
// full Export study JSON). No generated poses, rewards or Q values are invented.
// node scripts/train_default_camera_policy.mjs [recorded-study.json] [output.json]
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const out=resolve(process.argv[3]??'apps/studio/public/camera-policies/virtamed-survey-v1.json');
const input=JSON.parse(await readFile(process.argv[2]??out,'utf8'));
const scene=input.scene??input;
const graph={...scene.graph,nodes:scene.graph.nodes.map(({rgb,depth,...node})=>node)};
const sha=value=>createHash('sha256').update(value).digest('hex');
const directory=await mkdtemp(join(tmpdir(),'viscera-camera-learner-'));
try {
 await build({entryPoints:['apps/studio/src/cameraRL.ts'],outfile:join(directory,'learner.mjs'),bundle:true,platform:'node',format:'esm'});
 const {trainCameraPolicy,validateCameraPolicy}=await import(pathToFileURL(join(directory,'learner.mjs')).href);
 const policy=validateCameraPolicy(graph,trainCameraPolicy(graph,{seed:42,episodes:6000,goalMask:graph.nodes.reduce((m,n)=>m|n.visibleMask,0),priority:'steady'}));
 const demonstration=policy.evaluation.learned.rollouts.filter(r=>r.success&&r.steps>=2).sort((a,b)=>b.angleRad-a.angleRad||a.startNode-b.startNode)[0];
 if(!demonstration||policy.evaluation.learned.successRate!==1) throw new Error('Default policy failed its evaluation.');
 const artifact={format:'viscera.pretrained-camera/1',graph,port:scene.port,fov:scene.fov,demonstrationStart:demonstration.startNode,policy,
  provenance:{source:'VirtaMed operative camera; real 64×48 RGB + linear depth capture; reserved starts on the same anatomy',sourceSha256:sha(JSON.stringify(graph)),learnerSha256:sha(await readFile('apps/studio/src/cameraRL.ts')),weightsSha256:sha(JSON.stringify(policy.q))}};
 await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(artifact)+'\n');
 console.log(JSON.stringify({out,bytes:(await readFile(out)).length,updates:policy.training.updates,demonstration,provenance:artifact.provenance},null,2));
} finally {await rm(directory,{recursive:true,force:true});}
