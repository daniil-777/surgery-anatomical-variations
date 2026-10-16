import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
if(!args.get('--fixture'))throw new Error('--fixture is required');
const fixture=JSON.parse(await fs.readFile(args.get('--fixture'),'utf8'));
const base=args.get('--base-url')??'http://127.0.0.1:5174';
const out=args.get('--out')??'material-gpu-parity.json';
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
await page.goto(`${base}/atlas-witness.html`);
await page.waitForFunction(()=>Boolean(window.atlasWitness));
const report=await page.evaluate(async(fixture)=>{
 const THREE=await import('/node_modules/.vite/deps/three.js');
 const shader=await import('/src/atlasMaterialShader.ts');
 if(shader.ATLAS_MATERIAL_SHADER_SHA256!==fixture.shader.sha256) throw new Error('Fixture and production shader differ');
 const width=fixture.points_mm.length;
 const renderer=new THREE.WebGLRenderer();renderer.setSize(width,1);renderer.toneMapping=THREE.NoToneMapping;
 const target=new THREE.WebGLRenderTarget(width,1,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});
 const geometry=new THREE.PlaneGeometry(2,2);
 const scene=new THREE.Scene(),camera=new THREE.Camera();
 const results=[];
 for(const c of fixture.cases){
  const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,uniforms:{...shader.materialUniforms(c.resolved.uniforms),points:{value:fixture.points_mm.map(p=>new THREE.Vector3(...p))},regions:{value:fixture.region_ids},footprints:{value:fixture.footprints_mm},outputKind:{value:0}},
   vertexShader:'precision highp float; in vec3 position; void main(){gl_Position=vec4(position,1.0);}',
   fragmentShader:`precision highp float; precision highp int; ${shader.ATLAS_MATERIAL_GLSL}\nuniform vec3 points[${width}]; uniform float regions[${width}]; uniform float footprints[${width}]; uniform int outputKind; out vec4 result; void main(){int i=int(gl_FragCoord.x); AtlasMaterialSample s=atlasSampleMaterial(points[i],regions[i],footprints[i]); result=outputKind==0?vec4(s.colorLinear,s.roughness):vec4(s.heightMm,s.heightGradientRest);}`});
  const mesh=new THREE.Mesh(geometry,material);scene.add(mesh);
  const maximum=[];
  for(const [kind,key] of [[0,'rgba_color_roughness'],[1,'rgba_height_gradient']]){
   material.uniforms.outputKind.value=kind;renderer.setRenderTarget(target);renderer.render(scene,camera);
   const pixels=new Float32Array(width*4);renderer.readRenderTargetPixels(target,0,0,width,1,pixels);
   const expected=c[key].flat();let max=0;for(let i=0;i<pixels.length;i++){if(!Number.isFinite(pixels[i]))throw new Error('Nonfinite GPU output');max=Math.max(max,Math.abs(pixels[i]-expected[i]));} maximum.push(max);
  }
  results.push({organ:c.recipe.organ,seed:c.recipe.seed,maxColorRoughnessAbs:maximum[0],maxHeightGradientAbs:maximum[1]});
  scene.remove(mesh);material.dispose();
 }
 geometry.dispose();target.dispose();renderer.dispose();
 return {shaderVersion:fixture.shader.version,shaderSha256:fixture.shader.sha256,pointsPerCase:width,cases:results,tolerance:fixture.expected_gpu_abs_tolerance};
},fixture);
report.errors=errors;report.status=errors.length||report.cases.some(c=>c.maxColorRoughnessAbs>report.tolerance.rgba_color_roughness||c.maxHeightGradientAbs>report.tolerance.rgba_height_gradient)?'FAIL':'PASS';
await fs.writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
assert.equal(report.status,'PASS');await browser.close();
