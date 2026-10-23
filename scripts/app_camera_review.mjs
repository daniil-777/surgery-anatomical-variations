/** Final public/source camera evidence. Run only after the runtime/build is frozen. */
import { chromium } from '@playwright/test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
const execute = promisify(execFile), hash = data => createHash('sha256').update(data).digest('hex');
const base = (process.env.CAMERA_REVIEW_URL ?? 'http://127.0.0.1:5189').replace(/\/$/, '');
const output = path.resolve(process.env.CAMERA_REVIEW_OUTPUT ?? 'artifacts/app-audit-2026-10-20/camera/final-public');
if ((await readdir(output).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).length) throw new Error('Preserve prior evidence: choose an empty CAMERA_REVIEW_OUTPUT');
await mkdir(output, { recursive: true });
const report = { schema: 'viscera.app-camera-review/v1', startedUtc: new Date().toISOString(), base,
  scope: 'Actual authored atlas inspection and lumen phantom; no connected organ interiors or photorealism qualification',
  sourceSha256: {}, cases: [], errors: [], optionalApiProbes: [] };
for (const file of ['apps/studio/src/WholeSceneViewport.tsx','apps/studio/src/wholeSceneNavigation.ts','apps/studio/src/WholeSceneStudio.tsx','apps/studio/src/tissues/TissueViewport.tsx','apps/studio/src/tissues/TissueLab.tsx','apps/studio/src/tissues/material.ts','apps/studio/src/tissues/capture.ts','scripts/app_camera_review.mjs']) report.sourceSha256[file] = hash(await readFile(file));
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle','--use-angle=metal'] } : {}) });
report.browser = await browser.version();
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(90000);
page.on('pageerror', e => report.errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && /WebGL|shader|THREE/.test(m.text())) report.errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) {
  const detail = `${r.status()} ${r.url()}`, pathname = new URL(r.url()).pathname;
  // These two discovery requests select the tested browser-only fallback on a static host.
  const offlineDiscovery = pathname === '/api/health' || pathname === '/api/atlas/reference-material/status';
  if (r.status() === 404 && (offlineDiscovery || pathname.endsWith('/api.json'))) report.optionalApiProbes.push(detail);
  else report.errors.push(detail);
} });
const snapshot = async (selector, attribute) => JSON.parse(await page.locator(selector).getAttribute(attribute) ?? '{}');
async function decode(file) {
  const { stdout } = await execute('ffprobe', ['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,nb_read_frames,codec_name,avg_frame_rate:frame=best_effort_timestamp_time','-of','json',file], { maxBuffer: 8*1024*1024 });
  const probe = JSON.parse(stdout); if (probe.streams[0]?.width !== 3840 || probe.streams[0]?.height !== 2160) throw new Error('Expected native UHD stream: '+file);
  const raw = file+'.rgb'; await execute('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',file,'-vf','scale=160:90','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo',raw]);
  const rgb = await readFile(raw), bytes = 160*90*3, frames = [];
  for (let i=0;i<rgb.length;i+=bytes) frames.push(hash(rgb.subarray(i,i+bytes)));
  const times = probe.frames.map(f=>Number(f.best_effort_timestamp_time)).filter(Number.isFinite);
  const monotonic = times.every((v,i)=>i===0||v>times[i-1]);
  if (!monotonic || frames.length < 10 || new Set(frames).size < 10) throw new Error('Missing or frozen decoded motion: '+file);
  await execute('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',file,'-vf','fps=4,scale=480:270,tile=4x4','-frames:v','1',file+'-contact.jpg']);
  return { probe, decodedFrames:frames.length, uniqueFrames:new Set(frames).size, diagnosticResolution:[160,90], monotonicallyIncreasingTimestamps:monotonic, timestampSpanSeconds:times.at(-1)-times[0], meaning:'Decoded changes include camera/light motion. This is not motion-compensated flicker or a realism score.' };
}
try {
  report.deploymentIdentity = {};
  for (const file of ['build.json', 'public-source.json', 'public-assets.json']) {
    const response = await page.request.get(base + '/' + file);
    if (!response.ok()) throw new Error('Missing public release identity: ' + file);
    const bytes = await response.body();
    report.deploymentIdentity[file] = { sha256: hash(bytes), value: JSON.parse(bytes.toString()) };
  }
  report.catalog = await (await page.request.get(base+'/tissue-materials/catalog.json')).json();
  if(report.catalog.distribution?.native_available !== false || report.catalog.materials.some(item=>item.manifest!==null || JSON.stringify(item.available_resolutions)!=='[512]')) throw new Error('This public capture requires an explicitly512-only catalog');
  await page.goto(base+'/?mode=scene');
  const host = page.locator('[data-scene-ready="true"][data-scene-snapshot]'); await host.waitFor();
  await page.getByRole('button',{name:'Explore between organs',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-scene-snapshot]')?.dataset.sceneSnapshot??'{}').camera?.navigation.mode==='explore');
  const before = await snapshot('[data-scene-snapshot]','data-scene-snapshot');
  await page.setViewportSize({width:3840,height:2160});
  await host.evaluate(el=>{Object.assign(el.style,{position:'fixed',inset:'0px',width:'3840px',height:'2160px',zIndex:'99999'});});
  await page.waitForFunction(()=>{const c=document.querySelector('[data-scene-snapshot] canvas');return c?.width===3840&&c?.height===2160;});
  const canvas=host.locator('canvas'); await canvas.focus();
  await canvas.screenshot({path:path.join(output,'atlas-inspection-3840x2160.png')});
  const start=await snapshot('[data-scene-snapshot]','data-scene-snapshot');
  await canvas.evaluate(el=>{
    const stream=el.captureStream(30), mimeType=['video/webm;codecs=vp9','video/webm;codecs=vp8'].find(x=>MediaRecorder.isTypeSupported(x));
    if(!mimeType)throw new Error('No WebM encoder');
    const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:18000000}),chunks=[],started=performance.now(),samples=[];
    const timer=setInterval(()=>samples.push(JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot)),100);
    window.__cameraEvidence={recorder,result:new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>reject(new Error('Recorder error'));recorder.onstop=async()=>{const stopped=performance.now();clearInterval(timer);stream.getTracks().forEach(t=>t.stop());resolve({bytes:Array.from(new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer())),mimeType,durationSeconds:(stopped-started)/1000,samples});};})};recorder.start(100);
  });
  await page.keyboard.down('KeyS');await page.keyboard.down('ArrowLeft');await page.waitForTimeout(1700);
  await page.keyboard.up('KeyS');await page.keyboard.up('ArrowLeft');await page.keyboard.down('ArrowRight');await page.waitForTimeout(1600);await page.keyboard.up('ArrowRight');
  await page.evaluate(()=>window.__cameraEvidence.recorder.stop());
  const video=await page.evaluate(()=>window.__cameraEvidence.result);const atlasFile=path.join(output,'atlas-inspection-3840x2160.webm');await writeFile(atlasFile,Buffer.from(video.bytes));delete video.bytes;
  const decoded=await decode(atlasFile);
  report.cases.push({name:'atlas between-organ inspection',beforeLayoutChange:before.camera,start,...video,...decoded,encodedFramesPerRecordingWallSecond:decoded.decodedFrames/video.durationSeconds,recordingMethod:'Diagnostic canvas MediaRecorder at actual3840×2160. Separate from the product tour recorder.'});
  await page.setViewportSize({width:1500,height:1000});await page.goto(base+'/?mode=tissues');
  const tissue=page.locator('[data-tissue-ready="true"]');await tissue.waitFor();
  await page.getByLabel('Tissue region',{exact:true}).selectOption('colonic_mucosa');
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-tissue-ready="true"]')?.dataset.tissueSnapshot??'{}').organ==='colonic_mucosa');
  await page.getByLabel('View',{exact:true}).selectOption('walkthrough');
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-tissue-ready="true"]')?.dataset.tissueSnapshot??'{}').view==='walkthrough');
  const tissueStart=await snapshot('[data-tissue-ready="true"]','data-tissue-snapshot');
  const png=await tissue.evaluate(el=>el.captureTissueFrame(3840,2160,0));await writeFile(path.join(output,'public-lumen-3840x2160.png'),Buffer.from(png.split(',')[1],'base64'));
  const clip=await tissue.evaluate(async el=>{const r=await el.recordTissueVideo(3);return{bytes:Array.from(new Uint8Array(await r.blob.arrayBuffer())),metrics:r.metrics};});
  const tissueFile=path.join(output,'public-lumen-3840x2160.'+(clip.metrics.mimeType.startsWith('video/mp4')?'mp4':'webm'));await writeFile(tissueFile,Buffer.from(clip.bytes));
  const tissueDecoded=await decode(tissueFile);
  report.cases.push({name:'public authored lumen phantom',snapshot:tissueStart,sourceMapResolution:tissueStart.resolution,outputResolution:[3840,2160],metrics:clip.metrics,...tissueDecoded,encodedFramesPerRecordingWallSecond:tissueDecoded.decodedFrames/clip.metrics.durationSeconds,meaning:'UHD frame/video sampling does not add detail to the declared source map resolution.'});
  for(const [file,sha]of Object.entries(report.sourceSha256))if(hash(await readFile(file))!==sha)throw new Error('Source changed during capture: '+file);
  for (const [file, identity] of Object.entries(report.deploymentIdentity)) {
    const response = await page.request.get(base + '/' + file);
    if (!response.ok() || hash(await response.body()) !== identity.sha256) throw new Error('Public release changed during capture: ' + file);
  }
  report.completedUtc=new Date().toISOString();report.engineeringPassed=report.errors.length===0;
  if(report.errors.length)throw new Error('Captured browser errors; inspect preserved report');
} catch(error){report.errors.push(String(error));throw error;} finally {await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.close();await browser.close();}
