import { defineConfig } from '@playwright/test';
import base from './playwright.model-names.config';
const out=process.env.AUTOMATIC_GRASP_OUTPUT??'/tmp/viscera-autonomous-grasp/browser';
export default defineConfig({...base,testMatch:['automatic-grasp.spec.ts'],timeout:240000,expect:{timeout:45000},reporter:[['list'],['json',{outputFile:`${out}/results.json`}]],outputDir:`${out}/test-results`});
