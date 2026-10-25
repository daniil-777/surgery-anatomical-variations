import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve(process.env.OPTICS_OUTPUT ?? '/tmp/virtamed-optics/bench');
await mkdir(out, {recursive:true});
const bundle = await build({stdin:{resolveDir:process.cwd(),contents:`
import * as THREE from 'three';
import { LaparoscopeLighting } from './apps/studio/src/laparoscopeLighting';
import { LaparoscopeOptics } from './apps/studio/src/laparoscopeOptics';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(900,700);renderer.setClearColor(0x080505);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.88;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(52,900/700,.1,1000),rig=new LaparoscopeLighting(scene,new THREE.SpotLight()),optics=new LaparoscopeOptics(renderer);
const plane=new THREE.Mesh(new THREE.PlaneGeometry(140,110),new THREE.MeshPhysicalMaterial({color:0xb98780,roughness:.48,clearcoat:.2}));plane.receiveShadow=true;scene.add(plane);
const wet=new THREE.Mesh(new THREE.SphereGeometry(15,80,64),new THREE.MeshPhysicalMaterial({color:0xb87b78,roughness:.3,clearcoat:1,clearcoatRoughness:.085}));wet.position.set(-18,5,15);wet.castShadow=wet.receiveShadow=true;scene.add(wet);
const tool=new THREE.Mesh(new THREE.CylinderGeometry(2.8,2.8,63,32),new THREE.MeshStandardMaterial({color:0x8f9296,metalness:.85,roughness:.22}));tool.rotation.z=-.65;tool.position.set(15,2,25);tool.castShadow=tool.receiveShadow=true;scene.add(tool);
const pixels=()=>{const c=document.createElement('canvas');c.width=900;c.height=700;const ctx=c.getContext('2d');ctx.drawImage(renderer.domElement,0,0);return ctx.getImageData(0,0,900,700).data;};
const stats=(p)=>{let bright=0,energy=0,cx=0,cy=0;for(let i=0;i<p.length;i+=4){const v=Math.min(p[i],p[i+1],p[i+2]);energy+=(p[i]+p[i+1]+p[i+2])/3;if(v>235){bright++;cx+=(i/4)%900;cy+=Math.floor(i/4/900);}}return {bright,mean:energy/(900*700),centroid:[cx/Math.max(1,bright),cy/Math.max(1,bright)]};};
window.renderCase=(angle=0,shadow=true,glare=true)=>{camera.position.set(Math.sin(angle)*85,4,Math.cos(angle)*85);camera.lookAt(0,0,10);rig.update(camera,26000);plane.receiveShadow=wet.receiveShadow=tool.receiveShadow=shadow;renderer.shadowMap.enabled=true;renderer.shadowMap.needsUpdate=true;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;if(glare)optics.render(scene,camera);else renderer.render(scene,camera);return {stats:stats(pixels()),lights:rig.snapshot(),optics:optics.snapshot()};};
window.compare=()=>{window.renderCase(0,true,true);const shadow=pixels();window.renderCase(0,false,true);const lit=pixels();window.renderCase(0,true,false);const noGlare=pixels();let shadowPixels=0,glarePixels=0,shadowMax=0,glareMax=0;for(let i=0;i<shadow.length;i+=4){const s=(lit[i]+lit[i+1]+lit[i+2]-shadow[i]-shadow[i+1]-shadow[i+2])/3;const g=Math.abs(noGlare[i]-shadow[i])+Math.abs(noGlare[i+1]-shadow[i+1])+Math.abs(noGlare[i+2]-shadow[i+2]);if(s>8)shadowPixels++;if(g>3)glarePixels++;shadowMax=Math.max(shadowMax,s);glareMax=Math.max(glareMax,g);}return {shadowPixels,glarePixels,shadowMax,glareMax};};
window.falloff=()=>{wet.visible=tool.visible=false;plane.material=new THREE.MeshLambertMaterial({color:0x808080});renderer.shadowMap.enabled=false;renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.LinearSRGBColorSpace;const values=[];for(const d of [40,80]){camera.position.set(0,0,d);camera.lookAt(0,0,0);rig.update(camera,4000);renderer.render(scene,camera);const p=pixels(),i=(350*900+450)*4;values.push((p[i]+p[i+1]+p[i+2])/3);}return {values,ratio:values[0]/values[1]};};
`},bundle:true,format:'iife',write:false});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:900,height:700}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try {
  await page.setContent('<style>body{margin:0;background:black}</style>');await page.addScriptTag({content:bundle.outputFiles[0].text});
  const cases=[];
  for(const [name,angle,shadow,glare] of [['front',0,true,true],['left',-.3,true,true],['right',.3,true,true],['no-shadows',0,false,true],['no-glare',0,true,false]]) {
    const result=await page.evaluate(([a,s,g])=>window.renderCase(a,s,g),[angle,shadow,glare]);cases.push({name,...result});await page.screenshot({path:path.join(out,name+'.png')});
  }
  const comparison=await page.evaluate(()=>window.compare()),falloff=await page.evaluate(()=>window.falloff());
  const receipt={cases,comparison,falloff,errors};await writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));
  if(errors.length)throw Error(errors.join('\n'));
  if(comparison.shadowPixels<200||comparison.shadowMax<20)throw Error('Occluders did not create a measurable cast shadow');
  if(comparison.glarePixels<100)throw Error('HDR glare pass did not affect bright highlights');
  if(falloff.ratio<3.4||falloff.ratio>4.2)throw Error('Rendered light violates expected near-field falloff');
  if(cases.slice(0,3).some(c=>c.stats.bright<5))throw Error('Missing saturated wet specular highlights');
  const front=cases[0].stats.centroid,right=cases[2].stats.centroid;if(Math.hypot(front[0]-right[0],front[1]-right[1])<5)throw Error('Highlight did not move with viewpoint');
  console.log(JSON.stringify({comparison,falloff,errors}));
}finally{await browser.close();}
