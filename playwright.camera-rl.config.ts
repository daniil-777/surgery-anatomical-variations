import { defineConfig } from '@playwright/test';
import base from './playwright.model-names.config';
const out=process.env.CAMERA_RL_OUTPUT??'/tmp/viscera-camera-rl/browser';
export default defineConfig({...base,testMatch:['camera-rl.spec.ts'],timeout:180000,expect:{timeout:45000},reporter:[['list'],['json',{outputFile:`${out}/results.json`}]],outputDir:`${out}/test-results`});
