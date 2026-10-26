import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile), evidence=process.env.APP_RECORDER_OUTPUT??'artifacts/app-recorder-all-apps-2026-10-26';
const launcher=(p:Page)=>p.getByRole('button',{name:'Record app with voice',exact:true});
const dialog=(p:Page)=>p.getByRole('dialog',{name:'Video recorder',exact:true});
async function open(page:Page) {const event=page.waitForEvent('popup');await launcher(page).click();const popup=await event;await expect(dialog(popup)).toBeVisible();return popup;}

test('recorder entry works across lab, standalone 2D/3D, architecture and every anatomy subapp',async({page,context})=>{
 for(const route of ['/', '/morph3d/', '/pixel-morph/', '/arch/', '/anatomy/', '/anatomy/textures.html', '/anatomy/tissues.html', '/anatomy/fat.html', '/anatomy/blood.html']) {
  await page.goto(route);await expect(launcher(page)).toBeVisible();
  const popup=await open(page);await expect(popup.getByRole('checkbox',{name:'Record microphone audio'})).toBeChecked();
  await expect(popup.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
  expect(await popup.evaluate(()=>document.title)).toContain('App recorder');await popup.close();
 }
 expect(context.pages()).toHaveLength(1);
});

test('one voice recording survives iframe switches and full page navigation with playable changing video',async({page,context})=>{
 await context.addInitScript(()=>{const Original=MediaRecorder;(window as any).MediaRecorder=class extends Original{constructor(s:MediaStream,o?:MediaRecorderOptions){super(s,o);this.addEventListener('start',()=>{(window as any).__captureStartedAt=performance.now();});}};});
 await page.goto('/');await page.evaluate(()=>document.title='App recording QA target');
 const popup=await open(page), errors:string[]=[];popup.on('pageerror',e=>errors.push(e.message));
 await popup.getByRole('radio',{name:'HD · 1280 × 720',exact:true}).check();
 await popup.getByRole('button',{name:'Start recording',exact:true}).click();
 await expect(popup.locator('.recorder-progress strong')).toHaveText('Recording');
 await page.bringToFront();await page.waitForTimeout(1200);
 await page.getByRole('tab',{name:'Drawings',exact:true}).click();await page.waitForTimeout(1200);
 await page.getByRole('tab',{name:'Architecture',exact:true}).click();await page.waitForTimeout(1800);
 await page.goto('/morph3d/');await expect(page.getByRole('button',{name:'Open app recording controls'})).toBeVisible();await page.waitForTimeout(1800);
 await page.getByRole('button',{name:'Mute recording microphone',exact:true}).click();const muteAt=await popup.evaluate(()=>(performance.now()-(window as any).__captureStartedAt)/1000);await page.waitForTimeout(1600);
 await expect(popup.getByRole('button',{name:'Unmute microphone',exact:true})).toBeVisible();
 const unmuteAt=await popup.evaluate(()=>(performance.now()-(window as any).__captureStartedAt)/1000);await page.getByRole('button',{name:'Unmute recording microphone',exact:true}).click();
 await page.getByRole('button',{name:'Pause app recording',exact:true}).click();await expect(popup.locator('.recorder-progress strong')).toHaveText('Paused');await page.waitForTimeout(700);
 await page.getByRole('button',{name:'Resume app recording',exact:true}).click();
 await page.goto('/pixel-morph/');await expect(page.getByRole('button',{name:'Open app recording controls'})).toBeVisible();await page.waitForTimeout(1800);
 // Same named window after a full navigation: opening controls must not reload it.
 await page.getByRole('button',{name:'Open app recording controls'}).click();expect(context.pages()).toHaveLength(2);await expect(popup.locator('.recorder-progress strong')).toHaveText('Recording');
 await page.goto('/anatomy/?mode=scene&scene=virtamed');await page.bringToFront();await page.waitForTimeout(2500);
 await page.getByRole('button',{name:'Stop app recording',exact:true}).click();
 await expect(popup.getByText('Your recording is ready', {exact:true})).toBeVisible();
 const download=popup.waitForEvent('download');await popup.getByRole('link',{name:/Download (MP4|WEBM)/i}).click();const video=await download;const file=`${evidence}/cross-app-voice.${video.suggestedFilename().split('.').at(-1)}`;await video.saveAs(file);
 const report=popup.waitForEvent('download');await popup.getByRole('button',{name:"Capture details",exact:true}).click();await (await report).saveAs(`${evidence}/cross-app-voice.json`);
 const probe=JSON.parse((await exec('/opt/homebrew/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
 expect(probe.streams.some((s:any)=>s.codec_type==='audio')).toBe(true);expect(probe.streams.some((s:any)=>s.codec_type==='video')).toBe(true);expect(Number(probe.format.duration)).toBeGreaterThan(8);
 await writeFile(`${evidence}/encoded-probe.json`,JSON.stringify(probe,null,2));
 const samples=(await exec('/opt/homebrew/bin/ffmpeg',['-v','error','-i',file,'-vf','fps=1,scale=16:16','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:2_000_000})).stdout as Buffer;
 const hashes=new Set();for(let i=0;i+768<=samples.length;i+=768) hashes.add(samples.subarray(i,i+768).toString('base64'));expect(hashes.size).toBeGreaterThan(5);
 const audio=(await exec('/opt/homebrew/bin/ffmpeg',['-v','error','-i',file,'-vn','-f','s16le','-ac','1','-ar','16000','-'],{encoding:'buffer',maxBuffer:4_000_000})).stdout as Buffer;
 const rms=(a:number,b:number)=>{let energy=0,n=0;for(let i=Math.max(0,Math.ceil(a*16000));i<Math.min(audio.length/2,Math.floor(b*16000));i++){energy+=(audio.readInt16LE(i*2)/32768)**2;n++;}return Math.sqrt(energy/Math.max(1,n));};
 const voiceRms=rms(.5,1.1), mutedRms=rms(muteAt+.45,unmuteAt-.15);expect(mutedRms).toBeLessThan(voiceRms*.05);await writeFile(`${evidence}/voice-analysis.json`,JSON.stringify({syntheticInputOnly:true,muteAt,unmuteAt,voiceRms,mutedRms,distinctVideoSamples:hashes.size,videoDuration:probe.streams.find((s:any)=>s.codec_type==='video').duration,audioDuration:probe.streams.find((s:any)=>s.codec_type==='audio').duration},null,2));
 let energy=0;for(let i=0;i<audio.length;i+=2) energy+=(audio.readInt16LE(i)/32768)**2;expect(Math.sqrt(energy/(audio.length/2))).toBeGreaterThan(.02);
 await popup.getByLabel('Recording preview').evaluate(async(v:HTMLVideoElement)=>{await v.play();});await expect.poll(()=>popup.getByLabel('Recording preview').evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.2);
 expect(errors).toEqual([]);await popup.screenshot({path:`${evidence}/finished-recording.png`});
});

test('permission denial is recoverable and no microphone request is made before Start',async({page,context})=>{
 await context.addInitScript(()=>{(window as any).__calls=[];navigator.mediaDevices.getDisplayMedia=async()=>{(window as any).__calls.push('display');throw new DOMException('Sharing cancelled in test','NotAllowedError');};navigator.mediaDevices.getUserMedia=async()=>{(window as any).__calls.push('audio');throw new DOMException('No microphone used in test','NotAllowedError');};});
 await page.goto('/pixel-morph/');const popup=await open(page);expect(await popup.evaluate(()=>(window as any).__calls)).toEqual([]);
 await popup.getByRole('button',{name:'Start recording',exact:true}).click();await expect(popup.getByRole('alert')).toContainText('Sharing cancelled');expect(await popup.evaluate(()=>(window as any).__calls)).toEqual(['display']);await expect(popup.getByRole('button',{name:'Start recording',exact:true})).toBeEnabled();
});

test('blocked popups explain how to retry',async({page})=>{
 await page.goto('/morph3d/');await page.evaluate(()=>{window.open=()=>null;});await launcher(page).click();await expect(page.getByRole('status').filter({hasText:'Allow pop-ups'})).toBeVisible();
});

test('another independent window cannot start a competing recorder',async({page,context})=>{
 await page.goto('/');const popup=await open(page);const duplicate=await context.newPage();await duplicate.goto('/recorder/');await expect(duplicate.getByRole('heading',{name:'Your recorder is already open.'})).toBeVisible();await expect(duplicate.getByRole('button',{name:'Start recording',exact:true})).toHaveCount(0);await popup.close();await duplicate.getByRole('button',{name:'Try again',exact:true}).click();await expect(dialog(duplicate)).toBeVisible();
});

for(const width of [375,768,1440]) test(`recording controls fit and work by keyboard at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/recorder/');await expect(dialog(page)).toBeVisible();
 await page.getByRole('button',{name:'Start recording',exact:true}).focus();await page.keyboard.press('Tab');await expect(page.getByRole('radio',{name:'Full HD · 1920 × 1080',exact:true})).toBeFocused();
 expect(await dialog(page).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:`${evidence}/recorder-${width}.png`,fullPage:true});
});

test('private login records across sign-in and keeps private assets protected',async({page,context})=>{
 test.skip(!process.env.PRIVATE_RECORDER_URL,'Requires the isolated private-login test server.');
 const base=process.env.PRIVATE_RECORDER_URL!;await page.goto(`${base}/auth/login`);await expect(page.getByRole('heading',{name:'Welcome back.'})).toBeVisible();
 expect((await context.request.get(`${base}/assets/not-public.js`)).status()).toBe(401);
 expect((await context.request.get(`${base}/auth/recorder/unknown.json`)).status()).toBe(404);
 await page.evaluate(()=>document.title='App recording QA target');const popup=await open(page);const errors:string[]=[];popup.on('pageerror',e=>errors.push(e.message));popup.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
 await popup.getByRole('radio',{name:'HD · 1280 × 720',exact:true}).check();await popup.getByRole('button',{name:'Start recording',exact:true}).click();await expect(popup.locator('.recorder-progress strong')).toHaveText('Recording');
 await page.bringToFront();await page.waitForTimeout(800);await page.screenshot({path:`${evidence}/private-login-recording.png`});
 await page.getByLabel('Username',{exact:true}).fill('recorder-test');await page.getByLabel('Password',{exact:true}).fill('recorder-test-only');await page.getByRole('button',{name:'Enter studio',exact:true}).click();await expect(page).toHaveURL(`${base}/`);
 await expect(page.getByRole('button',{name:'Open app recording controls',exact:true})).toBeVisible();await page.waitForTimeout(1800);
 await page.getByRole('button',{name:'Stop app recording',exact:true}).click();await expect(popup.getByText('Your recording is ready',{exact:true})).toBeVisible();
 const event=popup.waitForEvent('download');await popup.getByRole('link',{name:/Download (MP4|WEBM)/i}).click();const file=await event;await file.saveAs(`${evidence}/private-login-voice.${file.suggestedFilename().split('.').at(-1)}`);
 await popup.getByLabel('Recording preview').evaluate(async(v:HTMLVideoElement)=>{await v.play();});await expect.poll(()=>popup.getByLabel('Recording preview').evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.2);expect(errors).toEqual([]);
});
