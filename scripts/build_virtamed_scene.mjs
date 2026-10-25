/** Rebuild the white, independently authored video-field GLB. No video pixels,
 * simulator assets or third-party surgical images are embedded. */
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(root,'.virtamed-build-'));
try {
  await build({entryPoints:[path.join(root,'apps/studio/src/virtaMedScene.ts')],outfile:path.join(temp,'scene.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',loader:{'.glsl':'text'},define:{'import.meta.env':'{}'},logLevel:'silent'});
  const {createVirtaMedScene,VIRTAMED_VERSION}=await import(pathToFileURL(path.join(temp,'scene.mjs')).href);
  const {GLTFExporter}=await import('three/examples/jsm/exporters/GLTFExporter.js');
  globalThis.FileReader=class {readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});}};
  const {root:scene,manifest}=createVirtaMedScene();
  const {Scene}=await import('three');const container=new Scene();container.name=scene.name;container.userData=scene.userData;for(const child of scene.children)container.add(child.clone());
  const glb=await new GLTFExporter().parseAsync(container,{binary:true});
  const bytes=Buffer.from(glb),sha256=createHash('sha256').update(bytes).digest('hex');
  const target=path.join(root,'apps/studio/public/anatomy-scene');
  await writeFile(path.join(target,'virtamed-scene.glb'),bytes);
  await writeFile(path.join(target,'virtamed-manifest.json'),JSON.stringify({...manifest,version:VIRTAMED_VERSION,filename:'virtamed-scene.glb',sha256,bytes:bytes.length,source:'Full.mp4, intact hepatocystic field 00:08–00:15; user-provided visual reference',construction:'Independently authored connected surfaces; no source simulator geometry, textures or logos',scale:'Assumed millimetres; monocular video does not determine absolute scale',hiddenAnatomy:'Inferred; not recovered from the video'},null,2)+'\n');
  console.log(JSON.stringify({sha256,bytes:bytes.length,parts:scene.children.length}));
} finally {await rm(temp,{recursive:true,force:true});}
