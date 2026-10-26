import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const evidence = process.env.APP_RECORDER_OUTPUT ?? 'artifacts/app-recorder-all-apps-2026-10-26';
mkdirSync(evidence,{recursive:true});
const rate=48000, seconds=60, wav=Buffer.alloc(44+rate*seconds*2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
for(let i=0;i<rate*seconds;i++) wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*.2*32767),44+i*2);
const tone=resolve(evidence,'synthetic-voice-test.wav');writeFileSync(tone,wav);
export default defineConfig({ testDir:'./tests/e2e', testMatch:'app-recorder.spec.ts', workers:1, timeout:120000, expect:{timeout:20000},
 reporter:[['list'],['json',{outputFile:`${evidence}/results.json`}]], outputDir:`${evidence}/test-results`,
 use:{ baseURL:process.env.LAB_RECORDER_URL??'http://127.0.0.1:5193', viewport:{width:1440,height:900}, permissions:['microphone'], trace:'retain-on-failure', screenshot:'only-on-failure',
 launchOptions:{ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--use-gl=angle','--use-angle=metal','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${tone}`,'--auto-select-tab-capture-source-by-title=App recording QA target','--enable-usermedia-screen-capturing','--allow-http-screen-capture','--autoplay-policy=no-user-gesture-required'] } }
});
